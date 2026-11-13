import { test } from "node:test";
import assert from "node:assert/strict";
import { planReset } from "../scripts/reset-lib.ts";

const U = 1_000_000;
const CENT = 10_000;
const opts = { agentTarget: 15 * U, headroom: 5 * CENT, gasBuffer: 1 * CENT };

test("after a rehearsal: savings and alice go back to the sender, and the agent is topped up to the target plus headroom", () => {
  const plan = planReset({ balances: { agent: 1_998_471, sender: 40 * U, savings: 29 * U, alice: 9 * U }, ...opts });
  assert.deepEqual(plan.transfers, [
    { from: "savings", to: "sender", amount: 28_990_000 },
    { from: "alice", to: "sender", amount: 8_990_000 },
    { from: "sender", to: "agent", amount: 13_060_000 },
  ]);
  assert.equal(plan.shortfall, 0);
  assert.equal(plan.agentAfter, 15_058_471);
});

test("the agent ends at or just above the target, never below it", () => {
  const plan = planReset({ balances: { agent: 3_456_789, sender: 50 * U, savings: 0, alice: 0 }, ...opts });
  assert.ok(plan.agentAfter >= opts.agentTarget + opts.headroom);
  assert.ok(plan.agentAfter < opts.agentTarget + opts.headroom + CENT);
});

test("an agent holding too much sends the excess back to the sender, keeping the headroom", () => {
  const plan = planReset({ balances: { agent: 40 * U, sender: 0, savings: 0, alice: 0 }, ...opts });
  assert.deepEqual(plan.transfers, [{ from: "agent", to: "sender", amount: 24_950_000 }]);
});

test("an agent already within the band is left alone", () => {
  const plan = planReset({ balances: { agent: 15_030_000, sender: 20 * U, savings: 0, alice: 0 }, ...opts });
  assert.deepEqual(plan.transfers, []);
});

test("dust too small to be worth moving after gas is not swept", () => {
  const plan = planReset({ balances: { agent: 15_050_000, sender: 20 * U, savings: 15_000, alice: 0 }, ...opts });
  assert.deepEqual(plan.transfers, []);
});

test("every amount moved is a whole number of cents", () => {
  const plan = planReset({ balances: { agent: 1_234_567, sender: 33_333_333, savings: 7_777_777, alice: 1_111_111 }, ...opts });
  for (const t of plan.transfers) assert.equal(t.amount % CENT, 0, JSON.stringify(t));
});

test("when the sender cannot cover the top-up, nothing is sent to the agent and the shortfall is reported", () => {
  const plan = planReset({ balances: { agent: 2 * U, sender: 5 * U, savings: 0, alice: 0 }, ...opts });
  assert.deepEqual(plan.transfers, []);
  assert.equal(plan.shortfall, 13_050_000 - 4_990_000); // need 15.05 - 2; sender can spare 5 minus gas
});

test("the plan reports how much the sender has left for the demo deposit", () => {
  const plan = planReset({ balances: { agent: 1_998_471, sender: 40 * U, savings: 29 * U, alice: 9 * U }, ...opts });
  assert.equal(plan.senderAfter, 40 * U + 28_990_000 + 8_990_000 - 13_060_000);
});
