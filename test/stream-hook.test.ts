import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createApp } from "../src/server.ts";
import { setup, U } from "./helpers.ts";

const STREAM_SECRET = "stream-secret-for-tests-0123456789abcdef";
const SENDER = "0xbc8d3a1a11ec298608968fd7c0577af2edcd6659";

function harness(opts: { secret?: string | null; balance?: number } = {}) {
  const ctx = setup({ balance: opts.balance ?? 60 * U });
  const app = createApp({
    engine: ctx.engine,
    cfg: { secret: "tool-secret", ownerNumbers: ["+15125550147"], dashboardToken: "dash" },
    streamSecret: opts.secret === undefined ? STREAM_SECRET : opts.secret ?? undefined,
  });
  const agent = ctx.wallet.address.toLowerCase();
  const deposit = (over: Record<string, unknown> = {}) => ({
    tx_hash: "0xfeed01", log_index: 2, from: SENDER, to: agent, value: (200n * 10n ** 18n).toString(), block_number: 72158488, ...over,
  });
  const deliver = async (body: unknown, opts2: { secret?: string; tamper?: boolean; headers?: Record<string, string> } = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const nonce = "nonce-" + Math.random().toString(36).slice(2);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", opts2.secret ?? STREAM_SECRET).update(nonce + timestamp + raw).digest("hex");
    const res = await app.request("/hooks/quicknode", {
      method: "POST",
      headers: { "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": timestamp, "x-qn-signature": signature, ...(opts2.headers ?? {}) },
      body: opts2.tamper ? raw.replace("200", "900") : raw,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...ctx, app, deposit, deliver };
}

test("a signed delivery with a deposit to the agent is recorded as coming from the Stream and triggers the sweep", async () => {
  // On chain the balance already includes the deposit by the time the Stream reports it.
  const { deliver, deposit, ledger, calls } = harness({ balance: 260 * U });
  const r = await deliver({ deposits: [deposit()] });
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, 1);
  assert.equal(ledger.recent(10).find((row) => row.kind === "deposit" || row.origin === "sweep") !== undefined, true);
  assert.equal(ledger.pendingSweep()?.amount, 159 * U);
  assert.equal(calls.length, 1);
});

test("a delivery with a bad signature is refused and nothing is recorded", async () => {
  const { deliver, deposit, ledger } = harness();
  assert.equal((await deliver({ deposits: [deposit()] }, { secret: "wrong-secret-wrong-secret-wrong-secret" })).status, 401);
  assert.equal((await deliver({ deposits: [deposit()] }, { tamper: true })).status, 401);
  assert.equal(ledger.recent(10).length, 0);
});

test("a delivery missing the signature headers is refused", async () => {
  const { app } = harness();
  const res = await app.request("/hooks/quicknode", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("the hook does not exist when no Stream secret is configured", async () => {
  const { deliver, deposit } = harness({ secret: null });
  assert.equal((await deliver({ deposits: [deposit()] })).status, 404);
});

test("the same deposit delivered twice by the Stream produces one action and one call", async () => {
  const { deliver, deposit, calls } = harness({ balance: 260 * U });
  await deliver({ deposits: [deposit()] });
  const again = await deliver({ deposits: [deposit()] });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicates, 1);
  assert.equal(calls.length, 1);
});

test("a deposit addressed to someone else is ignored even if it is signed", async () => {
  const { deliver, deposit, ledger } = harness();
  const r = await deliver({ deposits: [deposit({ to: SENDER })] });
  assert.equal(r.status, 200);
  assert.equal(r.json.ignored, 1);
  assert.equal(ledger.recent(10).length, 0);
});

test("a signed delivery with nothing usable is acknowledged, so the Stream does not pause", async () => {
  const { deliver } = harness();
  for (const body of [{}, { deposits: [] }, { deposits: [{ junk: true }] }, [], "null"]) {
    assert.equal((await deliver(body)).status, 200, JSON.stringify(body));
  }
});

test("Arc's 18-decimal value is converted to micro-USDC, flooring any dust", async () => {
  const { deliver, deposit, ledger } = harness({ balance: 0 });
  await deliver({ deposits: [deposit({ value: "1000001900000000000", tx_hash: "0xdust" })] });
  const row = ledger.recent(5).find((r) => r.kind === "deposit");
  assert.equal(row?.amount, 1_000_001);
});
