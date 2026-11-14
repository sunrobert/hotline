import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_NETWORK, arcUsdcRequirements, decodeHeader, encodeHeader, verifyPayment,
} from "../src/x402/protocol.ts";
import type { PaymentPayload, PaymentRequired, SettlementResponse, VerifyResponse } from "../src/x402/protocol.ts";
import { createPaymentPayload, paidFetch } from "../src/x402/buyer.ts";
import { paywall } from "../src/x402/seller.ts";
import type { Facilitator } from "../src/x402/seller.ts";
import { USDC_ERC20 } from "../src/wallet/arc.ts";

// Well-known local development keys. Signing is offline; nothing here touches a chain.
const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const NOW = 1_800_000_000;
const NONCE = ("0x" + "ab".repeat(32)) as `0x${string}`;

const requirements = arcUsdcRequirements({ amountMicros: 10_000, payTo: SELLER });
const required: PaymentRequired = {
  x402Version: 2,
  resource: { url: "https://seller.example/x402/price?asset=ETH", mimeType: "application/json" },
  accepts: [requirements],
};

const signed = (over: { nowSec?: number; nonce?: `0x${string}`; account?: typeof payer } = {}) =>
  createPaymentPayload({ account: over.account ?? payer, required, nowSec: over.nowSec ?? NOW, nonce: over.nonce ?? NONCE });

/** Re-signs nothing: edits a signed payload so the signature no longer matches what it claims. */
const tamper = (p: PaymentPayload, edit: (p: PaymentPayload) => void): PaymentPayload => {
  const copy = structuredClone(p);
  edit(copy);
  return copy;
};

// ---------- protocol ----------

test("Arc requirements follow the x402 v2 exact scheme with EIP-3009 on the USDC ERC-20 interface", () => {
  assert.deepEqual(requirements, {
    scheme: "exact",
    network: "eip155:5042002",
    amount: "10000",
    asset: USDC_ERC20,
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  });
  assert.equal(ARC_NETWORK, "eip155:5042002");
});

test("headers are base64 JSON both ways, and garbage is refused instead of half-parsed", () => {
  const raw = encodeHeader(required);
  assert.match(raw, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(decodeHeader(raw), required);
  assert.throws(() => decodeHeader("not base64 json!!"));
});

test("a signed payload carries the chosen requirements and an exact, time-boxed authorization", async () => {
  const p = await signed();
  assert.equal(p.x402Version, 2);
  assert.deepEqual(p.accepted, requirements);
  assert.deepEqual(p.resource, required.resource);
  const a = p.payload.authorization;
  assert.equal(a.from, payer.address);
  assert.equal(a.to, SELLER);
  assert.equal(a.value, "10000");
  assert.equal(a.nonce, NONCE);
  assert.ok(Number(a.validAfter) <= NOW);
  assert.equal(Number(a.validBefore), NOW + 60);
  assert.match(p.payload.signature, /^0x[0-9a-f]{130}$/);
});

test("each payment gets a fresh random nonce unless one is given", async () => {
  const a = await createPaymentPayload({ account: payer, required, nowSec: NOW });
  const b = await createPaymentPayload({ account: payer, required, nowSec: NOW });
  assert.match(a.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a.payload.authorization.nonce, b.payload.authorization.nonce);
});

test("a payer cannot be offered anything but exact USDC on Arc", async () => {
  const other: PaymentRequired = { ...required, accepts: [{ ...requirements, network: "eip155:8453" }] };
  await assert.rejects(createPaymentPayload({ account: payer, required: other, nowSec: NOW }), /no payment option/);
});

test("a correct payment verifies and names the payer", async () => {
  const r = await verifyPayment(await signed(), requirements, NOW);
  assert.deepEqual(r, { isValid: true, payer: payer.address });
});

const rejects = async (p: unknown, reason: string, nowSec = NOW) => {
  const r: VerifyResponse = await verifyPayment(p, requirements, nowSec);
  assert.equal(r.isValid, false);
  assert.equal(r.invalidReason, reason);
};

test("verification refuses a payload that is not a payload", async () => {
  await rejects({ hello: "world" }, "invalid_payload");
  await rejects(null, "invalid_payload");
});

test("verification refuses the wrong protocol version, scheme, or network", async () => {
  const p = await signed();
  await rejects(tamper(p, (x) => { (x as { x402Version: number }).x402Version = 1; }), "invalid_x402_version");
  await rejects(tamper(p, (x) => { (x.accepted as { scheme: string }).scheme = "upto"; }), "unsupported_scheme");
  await rejects(tamper(p, (x) => { x.accepted.network = "eip155:84532"; }), "invalid_network");
});

test("verification refuses a different asset than the one required", async () => {
  const p = await signed();
  await rejects(tamper(p, (x) => { x.accepted.asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; }), "invalid_payment_requirements");
});

test("verification refuses money sent anywhere but the seller", async () => {
  const p = await signed();
  await rejects(tamper(p, (x) => { x.payload.authorization.to = stranger.address; }), "invalid_exact_evm_payload_recipient_mismatch");
});

test("verification refuses an amount that is not exactly the price", async () => {
  const p = await signed();
  await rejects(tamper(p, (x) => { x.payload.authorization.value = "9999"; }), "invalid_exact_evm_payload_authorization_value_mismatch");
  await rejects(tamper(p, (x) => { x.payload.authorization.value = "10001"; }), "invalid_exact_evm_payload_authorization_value_mismatch");
});

test("verification refuses an authorization that is not valid yet or about to expire", async () => {
  await rejects(await signed({ nowSec: NOW + 100 }), "invalid_exact_evm_payload_authorization_valid_after");
  // Expires in under the settlement margin: it could lapse while the transaction is in flight.
  await rejects(await signed(), "invalid_exact_evm_payload_authorization_valid_before", NOW + 58);
});

test("verification refuses a signature that does not come from the claimed payer", async () => {
  const p = await signed();
  const forged = tamper(p, (x) => { x.payload.authorization.from = stranger.address; });
  await rejects(forged, "invalid_exact_evm_payload_signature");
  const bumped = tamper(p, (x) => { x.payload.authorization.nonce = ("0x" + "cd".repeat(32)) as `0x${string}`; });
  await rejects(bumped, "invalid_exact_evm_payload_signature");
  await rejects(tamper(p, (x) => { x.payload.signature = "0x1234"; }), "invalid_exact_evm_payload_signature");
});

// ---------- seller ----------

class FakeFacilitator implements Facilitator {
  settled: PaymentPayload[] = [];
  checkResult: VerifyResponse | null = null;
  failSettle: string | null = null;
  async check(): Promise<VerifyResponse> { return this.checkResult ?? { isValid: true }; }
  async settle(p: PaymentPayload): Promise<SettlementResponse> {
    if (this.failSettle) return { success: false, errorReason: this.failSettle, transaction: "", network: ARC_NETWORK };
    this.settled.push(p);
    return { success: true, transaction: "0x" + "77".repeat(32), network: ARC_NETWORK, payer: p.payload.authorization.from };
  }
}

function sellerApp(opts: { handlerStatus?: number } = {}) {
  const facilitator = new FakeFacilitator();
  let served = 0;
  const app = new Hono();
  app.get("/x402/price", paywall({ requirements, facilitator, nowSec: () => NOW, description: "Spot price" }), (c) => {
    served++;
    if (opts.handlerStatus) return c.json({ error: "upstream down" }, opts.handlerStatus as 502);
    return c.json({ asset: "ETH", price_usd: 3000 });
  });
  return { app, facilitator, served: () => served };
}

const pay = (app: Hono, payload?: PaymentPayload) =>
  app.request("http://seller.example/x402/price?asset=ETH", {
    headers: payload ? { "PAYMENT-SIGNATURE": encodeHeader(payload) } : {},
  });

test("without payment the seller answers 402 with the requirements in PAYMENT-REQUIRED", async () => {
  const { app, served } = sellerApp();
  const res = await pay(app);
  assert.equal(res.status, 402);
  const body = decodeHeader<PaymentRequired>(res.headers.get("PAYMENT-REQUIRED") ?? "");
  assert.equal(body.x402Version, 2);
  assert.deepEqual(body.accepts, [requirements]);
  assert.equal(body.resource.url, "http://seller.example/x402/price?asset=ETH");
  assert.equal(body.resource.description, "Spot price");
  assert.equal(served(), 0);
});

test("a valid payment is settled and the data comes back with PAYMENT-RESPONSE", async () => {
  const { app, facilitator, served } = sellerApp();
  const res = await pay(app, await signed());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { asset: "ETH", price_usd: 3000 });
  const settlement = decodeHeader<SettlementResponse>(res.headers.get("PAYMENT-RESPONSE") ?? "");
  assert.equal(settlement.success, true);
  assert.equal(settlement.transaction, "0x" + "77".repeat(32));
  assert.equal(facilitator.settled.length, 1);
  assert.equal(served(), 1);
});

test("an unreadable PAYMENT-SIGNATURE is a 400, not a charge", async () => {
  const { app, facilitator } = sellerApp();
  const res = await app.request("http://seller.example/x402/price", { headers: { "PAYMENT-SIGNATURE": "%%%" } });
  assert.equal(res.status, 400);
  assert.equal(facilitator.settled.length, 0);
});

test("an invalid payment gets 402 again with the reason, and nothing is settled or served", async () => {
  const { app, facilitator, served } = sellerApp();
  const p = tamper(await signed(), (x) => { x.payload.authorization.value = "1"; });
  const res = await pay(app, p);
  assert.equal(res.status, 402);
  const body = decodeHeader<PaymentRequired>(res.headers.get("PAYMENT-REQUIRED") ?? "");
  assert.equal(body.error, "invalid_exact_evm_payload_authorization_value_mismatch");
  assert.equal(facilitator.settled.length, 0);
  assert.equal(served(), 0);
});

test("the on-chain check can refuse a payment the signature alone would allow", async () => {
  const { app, facilitator, served } = sellerApp();
  facilitator.checkResult = { isValid: false, invalidReason: "insufficient_funds" };
  const res = await pay(app, await signed());
  assert.equal(res.status, 402);
  assert.equal(decodeHeader<PaymentRequired>(res.headers.get("PAYMENT-REQUIRED") ?? "").error, "insufficient_funds");
  assert.equal(served(), 0);
});

test("the same authorization cannot buy twice from the same seller", async () => {
  const { app, facilitator } = sellerApp();
  const p = await signed();
  assert.equal((await pay(app, p)).status, 200);
  const again = await pay(app, p);
  assert.equal(again.status, 402);
  assert.equal(facilitator.settled.length, 1);
});

test("if the data cannot be produced, the payment is not settled", async () => {
  const { app, facilitator } = sellerApp({ handlerStatus: 502 });
  const res = await pay(app, await signed());
  assert.equal(res.status, 502);
  assert.equal(facilitator.settled.length, 0);
  assert.equal(res.headers.get("PAYMENT-RESPONSE"), null);
});

test("if settlement fails, the data is withheld and the failure is reported in PAYMENT-RESPONSE", async () => {
  const { app, facilitator } = sellerApp();
  facilitator.failSettle = "invalid_transaction_state";
  const res = await pay(app, await signed());
  assert.equal(res.status, 402);
  const s = decodeHeader<SettlementResponse>(res.headers.get("PAYMENT-RESPONSE") ?? "");
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "invalid_transaction_state");
  assert.doesNotMatch(await res.text(), /3000/);
});

// ---------- buyer ----------

const viaApp = (app: Hono): typeof fetch => async (input, init) => app.request(String(input), init as RequestInit);

test("paidFetch pays a 402 once, after approval, and returns the data and the transaction", async () => {
  const { app, facilitator } = sellerApp();
  const approvals: { amount: string; payTo: string }[] = [];
  const r = await paidFetch("http://seller.example/x402/price?asset=ETH", {
    account: payer, fetch: viaApp(app), nowSec: () => NOW,
    approve: async (req) => { approvals.push({ amount: req.amount, payTo: req.payTo }); return { ok: true }; },
  });
  assert.equal(r.status, "paid");
  if (r.status !== "paid") return;
  assert.deepEqual(r.body, { asset: "ETH", price_usd: 3000 });
  assert.equal(r.settlement.transaction, "0x" + "77".repeat(32));
  assert.deepEqual(approvals, [{ amount: "10000", payTo: SELLER }]);
  assert.equal(facilitator.settled.length, 1);
});

test("paidFetch signs nothing when approval is refused", async () => {
  const { app, facilitator } = sellerApp();
  const r = await paidFetch("http://seller.example/x402/price?asset=ETH", {
    account: payer, fetch: viaApp(app), nowSec: () => NOW,
    approve: async () => ({ ok: false, message: "over the daily cap" }),
  });
  assert.deepEqual(r, { status: "declined", message: "over the daily cap" });
  assert.equal(facilitator.settled.length, 0);
});

test("paidFetch passes a free resource straight through without asking", async () => {
  const app = new Hono();
  app.get("/free", (c) => c.json({ free: true }));
  let asked = false;
  const r = await paidFetch("http://seller.example/free", {
    account: payer, fetch: viaApp(app), approve: async () => { asked = true; return { ok: true }; },
  });
  assert.equal(r.status, "free");
  assert.equal(asked, false);
});

test("paidFetch reports a failed settlement with the seller's reason", async () => {
  const { app, facilitator } = sellerApp();
  facilitator.failSettle = "insufficient_funds";
  const r = await paidFetch("http://seller.example/x402/price?asset=ETH", {
    account: payer, fetch: viaApp(app), nowSec: () => NOW, approve: async () => ({ ok: true }),
  });
  assert.equal(r.status, "failed");
  if (r.status === "failed") assert.equal(r.reason, "insufficient_funds");
});

test("paidFetch refuses a 402 that offers no option it can pay", async () => {
  const app = new Hono();
  app.get("/odd", (c) => {
    const body: PaymentRequired = { x402Version: 2, resource: { url: "x" }, accepts: [{ ...requirements, network: "eip155:1" }] };
    return c.json({}, 402, { "PAYMENT-REQUIRED": encodeHeader(body) });
  });
  let asked = false;
  const r = await paidFetch("http://seller.example/odd", {
    account: payer, fetch: viaApp(app), approve: async () => { asked = true; return { ok: true }; },
  });
  assert.equal(r.status, "failed");
  assert.equal(asked, false);
});
