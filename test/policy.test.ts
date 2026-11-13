import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.ts";
import type { PolicyConfig, PolicyState, PolicyInput } from "../src/policy.ts";

const U = 1_000_000; // one USDC in micros

// The demo configuration from the design doc.
const cfg: PolicyConfig = {
  perTxCap: 250 * U,
  dailyCap: 1000 * U,
  approvalThreshold: 50 * U,
  gasReserve: 1 * U,
  allowlist: {
    alice: "0x00000000000000000000000000000000000a11ce",
    savings: "0x000000000000000000000000000000000005a7e5",
  },
};
const state = (over: Partial<PolicyState> = {}): PolicyState => ({
  paused: false, spentToday: 0, available: 260 * U, ...over,
});
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  amount: 5 * U, toLabel: "alice", source: "voice", ...over,
});

test("a small send to an allowlisted label is AUTO", () => {
  const d = decide(input(), state(), cfg);
  assert.equal(d.decision, "AUTO");
  assert.equal(d.rule, "auto");
});

test("an amount over the approval threshold needs a CALL", () => {
  const d = decide(input({ amount: 80 * U }), state(), cfg);
  assert.equal(d.decision, "CALL");
  assert.equal(d.rule, "approval_threshold");
});

test("an amount exactly at the approval threshold is still AUTO", () => {
  assert.equal(decide(input({ amount: 50 * U }), state(), cfg).decision, "AUTO");
});

test("any stream-sourced action needs a CALL, even a tiny one", () => {
  const d = decide(input({ amount: 2 * U, toLabel: "savings", source: "stream" }), state(), cfg);
  assert.equal(d.decision, "CALL");
  assert.equal(d.rule, "stream_source");
});

test("an amount over the per-transaction cap is BLOCKED", () => {
  const d = decide(input({ amount: 300 * U }), state({ available: 5000 * U }), cfg);
  assert.equal(d.decision, "BLOCK");
  assert.equal(d.rule, "per_tx_cap");
});

test("a send that would exceed the daily cap is BLOCKED", () => {
  const d = decide(input({ amount: 40 * U }), state({ spentToday: 970 * U }), cfg);
  assert.equal(d.decision, "BLOCK");
  assert.equal(d.rule, "daily_cap");
});

test("a send that lands exactly on the daily cap is allowed", () => {
  assert.equal(decide(input({ amount: 30 * U }), state({ spentToday: 970 * U }), cfg).decision, "AUTO");
});

test("a recipient that is not an allowlist label is BLOCKED", () => {
  const d = decide(input({ toLabel: "mallory" }), state(), cfg);
  assert.equal(d.decision, "BLOCK");
  assert.equal(d.rule, "not_allowlisted");
});

test("a raw address is refused even if it belongs to an allowlisted label", () => {
  const d = decide(input({ toLabel: cfg.allowlist.alice! }), state(), cfg);
  assert.equal(d.rule, "not_allowlisted");
});

test("allowlist labels match case-insensitively and ignore surrounding space", () => {
  assert.equal(decide(input({ toLabel: "  Alice " }), state(), cfg).decision, "AUTO");
});

test("a send that would leave less than the gas reserve is BLOCKED", () => {
  const d = decide(input({ amount: 10 * U }), state({ available: 10.5 * U }), cfg);
  assert.equal(d.decision, "BLOCK");
  assert.equal(d.rule, "gas_reserve");
});

test("a send that leaves exactly the gas reserve is allowed", () => {
  assert.equal(decide(input({ amount: 10 * U }), state({ available: 11 * U }), cfg).decision, "AUTO");
});

test("when paused, everything is BLOCKED before any other rule is considered", () => {
  const d = decide(input({ toLabel: "mallory", amount: 9999 * U }), state({ paused: true }), cfg);
  assert.equal(d.decision, "BLOCK");
  assert.equal(d.rule, "paused");
});

test("a zero or negative amount is BLOCKED as invalid", () => {
  for (const amount of [0, -5 * U, 1.5]) {
    const d = decide(input({ amount }), state(), cfg);
    assert.equal(d.decision, "BLOCK");
    assert.equal(d.rule, "invalid_amount");
  }
});

test("blocks are checked before the approval threshold, so an over-cap amount never reaches CALL", () => {
  const d = decide(input({ amount: 300 * U, source: "stream" }), state({ available: 5000 * U }), cfg);
  assert.equal(d.decision, "BLOCK");
});

test("every decision carries a plain-English reason the agent can speak", () => {
  assert.match(decide(input({ amount: 300 * U }), state({ available: 5000 * U }), cfg).reason, /250/);
  assert.match(decide(input({ amount: 80 * U }), state(), cfg).reason, /50/);
});
