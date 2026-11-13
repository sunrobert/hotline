import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSweep, dailyResetBoundary } from "../src/sweep.ts";

const U = 1_000_000;
const rule = { threshold: 100 * U, gasReserve: 1 * U };

test("the demo deposit: 60 + 200 sweeps 159, leaving the threshold plus gas", () => {
  assert.equal(computeSweep({ balance: 260 * U, committed: 0, ...rule }), 159 * U);
});

test("no sweep when the balance is at or under the threshold", () => {
  assert.equal(computeSweep({ balance: 100 * U, committed: 0, ...rule }), null);
  assert.equal(computeSweep({ balance: 60 * U, committed: 0, ...rule }), null);
});

test("no sweep when the excess is smaller than the gas reserve", () => {
  assert.equal(computeSweep({ balance: 100.5 * U, committed: 0, ...rule }), null);
});

test("funds already committed to other actions are not swept twice", () => {
  // 460 on chain, but a 159 sweep is already pending: only 200 more is free to move.
  assert.equal(computeSweep({ balance: 460 * U, committed: 159 * U, ...rule }), 200 * U);
});

test("dailyResetBoundary returns the most recent reset hour at or before now", () => {
  const now = Date.UTC(2026, 10, 13, 15, 30);
  assert.equal(dailyResetBoundary(now, 0), Date.UTC(2026, 10, 13, 0, 0));
  assert.equal(dailyResetBoundary(now, 15), Date.UTC(2026, 10, 13, 15, 0));
  assert.equal(dailyResetBoundary(now, 20), Date.UTC(2026, 10, 12, 20, 0));
});

test("a sweep is rounded down to whole USDC so the agent never reads out gas dust", () => {
  // 26.37 on hand after gas: 15.37 is excess, but the agent proposes 15
  assert.equal(computeSweep({ balance: 26_370_000, committed: 0, ...rule, threshold: 10 * U }), 15 * U);
});

test("an excess under one whole USDC after the gas reserve is not swept", () => {
  assert.equal(computeSweep({ balance: 11_900_000, committed: 0, ...rule, threshold: 10 * U }), null);
});
