// The agent's get_price tool buying from the x402 price feed over HTTP, with the policy engine approving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/server.ts";
import { ARC_NETWORK, arcUsdcRequirements, decodeHeader } from "../src/x402/protocol.ts";
import type { PaymentPayload, PaymentRequired, SettlementResponse, VerifyResponse } from "../src/x402/protocol.ts";
import type { Facilitator } from "../src/x402/seller.ts";
import { setup, ALICE, SAVINGS } from "./helpers.ts";

const SECRET = "tool-secret-for-tests";
const OWNER = "+15125550147";
const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const TX = "0x" + "77".repeat(32);
const agentAccount = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

class FakeFacilitator implements Facilitator {
  settled: PaymentPayload[] = [];
  failSettle: string | null = null;
  async check(): Promise<VerifyResponse> { return { isValid: true }; }
  async settle(p: PaymentPayload): Promise<SettlementResponse> {
    if (this.failSettle) return { success: false, errorReason: this.failSettle, transaction: "", network: ARC_NETWORK };
    this.settled.push(p);
    return { success: true, transaction: TX, network: ARC_NETWORK, payer: p.payload.authorization.from };
  }
}

function harness(opts: { allowlistSeller?: boolean; withX402?: boolean } = {}) {
  const allowlist: Record<string, string> = { alice: ALICE, savings: SAVINGS };
  if (opts.allowlistSeller !== false) allowlist.prices = SELLER;
  const ctx = setup({ cfg: { allowlist } });
  const facilitator = new FakeFacilitator();
  const quotes: string[] = [];
  let app: ReturnType<typeof createApp>;
  const x402 = opts.withX402 === false ? {} : {
    x402Seller: {
      requirements: arcUsdcRequirements({ amountMicros: 10_000, payTo: SELLER }),
      facilitator,
      quote: async (asset: string) => { quotes.push(asset); return { asset, price_usd: 3123.45, as_of: "2026-11-14T00:00:00Z", source: "test" }; },
    },
    x402Buyer: {
      account: agentAccount,
      sellerUrl: "http://hotline.test/x402/price",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
    },
  };
  app = createApp({ engine: ctx.engine, cfg: { secret: SECRET, ownerNumbers: [OWNER], dashboardToken: "dash" }, ...x402 });
  const call = async (tool: string, body: Record<string, unknown>) => {
    const res = await app.request(`/tools/${tool}`, {
      method: "POST", headers: { "content-type": "application/json", "x-hotline-secret": SECRET },
      body: JSON.stringify({ caller_id: OWNER, conversation_id: "in-1", ...body }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...ctx, app, call, facilitator, quotes };
}

test("the price feed asks for x402 payment before it answers", async () => {
  const { app, quotes } = harness();
  const res = await app.request("http://hotline.test/x402/price?asset=ETH");
  assert.equal(res.status, 402);
  const required = decodeHeader<PaymentRequired>(res.headers.get("PAYMENT-REQUIRED") ?? "");
  assert.equal(required.accepts[0]?.payTo, SELLER);
  assert.equal(quotes.length, 0);
});

test("get_price pays a cent through the policy engine and returns the price with the transaction", async () => {
  const { call, ledger, engine, facilitator } = harness();
  const r = await call("get_price", { asset: "eth" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.asset, "ETH");
  assert.equal(r.json.price_usd, 3123.45);
  assert.equal(r.json.paid_usdc, 0.01);
  assert.equal(r.json.tx_hash, TX);
  assert.equal(facilitator.settled.length, 1);
  assert.equal(facilitator.settled[0]?.payload.authorization.from, agentAccount.address);
  await engine.idle();
  const row = ledger.get(r.json.action_code);
  assert.equal(row?.kind, "pay_api");
  assert.equal(row?.status, "complete");
  assert.equal(row?.tx_hash, TX);
  assert.equal(row?.conversation_id, "in-1");
});

test("get_price will not pay a seller that is not on the allowlist", async () => {
  const { call, facilitator, quotes } = harness({ allowlistSeller: false });
  const r = await call("get_price", { asset: "ETH" });
  assert.equal(r.json.ok, false);
  assert.match(r.json.message, /allowlist/);
  assert.equal(facilitator.settled.length, 0);
  assert.equal(quotes.length, 0);
});

test("get_price pays nothing while the agent is paused", async () => {
  const { call, engine, facilitator } = harness();
  engine.pause();
  const r = await call("get_price", { asset: "ETH" });
  assert.equal(r.json.ok, false);
  assert.equal(facilitator.settled.length, 0);
});

test("get_price for an asset the feed does not carry costs nothing and leaves no ledger row", async () => {
  const { call, ledger, facilitator } = harness();
  const r = await call("get_price", { asset: "NOTACOIN" });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, "unsupported_asset");
  assert.equal(facilitator.settled.length, 0);
  assert.equal(ledger.recent(5).length, 0);
});

test("get_price records a failed settlement as failed, and says nothing was charged", async () => {
  const { call, ledger, facilitator } = harness();
  facilitator.failSettle = "insufficient_funds";
  const r = await call("get_price", { asset: "BTC" });
  assert.equal(r.json.ok, false);
  const row = ledger.recent(1)[0];
  assert.equal(row?.kind, "pay_api");
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "insufficient_funds");
});

test("get_price explains itself when paid lookups are not set up", async () => {
  const { call } = harness({ withX402: false });
  const r = await call("get_price", { asset: "ETH" });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, "not_configured");
});
