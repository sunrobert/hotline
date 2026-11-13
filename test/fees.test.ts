import { test } from "node:test";
import assert from "node:assert/strict";
import { withFeeFloor, ARC_MIN_FEE_PER_GAS } from "../src/wallet/fees.ts";

const GWEI = 1_000_000_000n;

test("Arc's fee floor is 20 gwei", () => {
  assert.equal(ARC_MIN_FEE_PER_GAS, 20n * GWEI);
});

test("an estimate under the floor is raised to it, or the mempool silently drops the transaction", () => {
  const fees = withFeeFloor({ maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 1n * GWEI });
  assert.equal(fees.maxFeePerGas, 20n * GWEI);
  assert.equal(fees.maxPriorityFeePerGas, 1n * GWEI);
});

test("an estimate over the floor is kept", () => {
  const fees = withFeeFloor({ maxFeePerGas: 45n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
  assert.equal(fees.maxFeePerGas, 45n * GWEI);
});

test("the priority fee never exceeds the max fee", () => {
  const fees = withFeeFloor({ maxFeePerGas: 5n * GWEI, maxPriorityFeePerGas: 30n * GWEI });
  assert.equal(fees.maxFeePerGas, 20n * GWEI);
  assert.equal(fees.maxPriorityFeePerGas, 20n * GWEI);
});
