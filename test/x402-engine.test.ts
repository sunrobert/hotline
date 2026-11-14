// x402 payments through the policy engine: same allowlist, caps, pause, and ledger as a spoken send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, U, ALICE, SAVINGS } from "./helpers.ts";

const PRICES = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CENT = 10_000;
const withPrices = (over = {}) => ({ allowlist: { alice: ALICE, savings: SAVINGS, prices: PRICES }, ...over });
const TX = "0x" + "77".repeat(32);

test("a cent to an allowlisted seller is approved at once and held as committed until it settles", async () => {
  const { engine, ledger } = setup({ cfg: withPrices() });
  const r = await engine.authorizePayment({ payTo: PRICES.toLowerCase(), amountMicros: CENT, resource: "ETH price", conversationId: "c1" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const row = ledger.get(r.code);
  assert.equal(row?.kind, "pay_api");
  assert.equal(row?.to_label, "prices");
  assert.equal(row?.decision, "AUTO");
  assert.equal(row?.status, "approved");
  assert.equal(row?.amount, CENT);
  assert.equal(ledger.committed(), CENT);
});

test("a settled payment is recorded with its transaction and counts toward the daily cap", async () => {
  const { engine, ledger } = setup({ cfg: withPrices({ dailyCap: 1 * U }) });
  const r = await engine.authorizePayment({ payTo: PRICES, amountMicros: CENT, resource: "ETH price" });
  assert.ok(r.ok);
  if (!r.ok) return;
  engine.paymentSubmitted(r.code, TX);
  assert.equal(ledger.get(r.code)?.status, "submitted");
  assert.equal(ledger.get(r.code)?.tx_hash, TX);
  await engine.idle();
  assert.equal(ledger.get(r.code)?.status, "complete");

  // 0.01 is gone from today's 1 USDC: a 0.995 send no longer fits.
  const big = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 0.995, source: "voice" });
  assert.equal(big.decision, "BLOCK");
  assert.equal(big.rule, "daily_cap");
});

test("a seller that is not on the allowlist is never paid", async () => {
  const { engine, ledger } = setup({ cfg: withPrices() });
  const r = await engine.authorizePayment({ payTo: "0x000000000000000000000000000000000000bEEF", amountMicros: CENT, resource: "anything" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.view.rule, "not_allowlisted");
  assert.equal(ledger.get(r.view.action_code)?.status, "blocked");
  assert.equal(ledger.committed(), 0);
});

test("nothing is paid while the agent is paused", async () => {
  const { engine } = setup({ cfg: withPrices() });
  engine.pause();
  const r = await engine.authorizePayment({ payTo: PRICES, amountMicros: CENT, resource: "ETH price" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.view.rule, "paused");
});

test("a price over the auto-approve limit is refused, not queued for a call", async () => {
  const { engine, ledger, calls } = setup({ cfg: withPrices() });
  const r = await engine.authorizePayment({ payTo: PRICES, amountMicros: 60 * U, resource: "a very expensive report" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.view.decision, "CALL");
  assert.equal(ledger.get(r.view.action_code)?.status, "cancelled");
  assert.equal(ledger.get(r.view.action_code)?.reason, "needs_approval");
  assert.equal(calls.length, 0);
  assert.equal(ledger.committed(), 0);
});

test("a payment the seller did not settle is marked failed and frees the commitment", async () => {
  const { engine, ledger } = setup({ cfg: withPrices() });
  const r = await engine.authorizePayment({ payTo: PRICES, amountMicros: CENT, resource: "ETH price" });
  assert.ok(r.ok);
  if (!r.ok) return;
  engine.paymentFailed(r.code, "insufficient_funds");
  assert.equal(ledger.get(r.code)?.status, "failed");
  assert.equal(ledger.get(r.code)?.error, "insufficient_funds");
  assert.equal(ledger.committed(), 0);
});

test("an x402 payment reads as a payment in status and history, not as a send", async () => {
  const { engine } = setup({ cfg: withPrices() });
  const r = await engine.authorizePayment({ payTo: PRICES, amountMicros: CENT, resource: "ETH price" });
  assert.ok(r.ok);
  const recent = (await engine.status()).recent[0];
  assert.ok(recent);
  assert.equal(recent.kind, "pay_api");
  assert.equal(recent.summary, "Paid 0.01 USDC to prices (x402)");
  assert.equal(recent.amount_usdc, 0.01);
});

test("a payment interrupted by a restart fails closed and is never re-sent as a transfer", async () => {
  const { engine, ledger, wallet } = setup({ cfg: withPrices() });
  const r = await engine.authorizePayment({ payTo: PRICES, amountMicros: CENT, resource: "ETH price" });
  assert.ok(r.ok);
  if (!r.ok) return;
  await engine.recover();
  assert.equal(ledger.get(r.code)?.status, "failed");
  assert.equal(wallet.sends.length, 0);
});
