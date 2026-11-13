import { test } from "node:test";
import assert from "node:assert/strict";
import { toMicros, fromMicros, formatUsdc, nativeToMicros, microsToNative } from "../src/money.ts";

test("toMicros converts whole and fractional USDC to integer micro-USDC", () => {
  assert.equal(toMicros(5), 5_000_000);
  assert.equal(toMicros(0.1), 100_000);
  assert.equal(toMicros(159.25), 159_250_000);
});

test("toMicros avoids binary float drift", () => {
  assert.equal(toMicros(0.1 + 0.2), 300_000);
});

test("toMicros rejects amounts that are not positive finite numbers", () => {
  for (const bad of [0, -1, NaN, Infinity, "5" as unknown as number]) {
    assert.throws(() => toMicros(bad), /invalid amount/);
  }
});

test("fromMicros is the inverse of toMicros", () => {
  assert.equal(fromMicros(159_250_000), 159.25);
});

test("formatUsdc drops trailing zeros for speech and receipts", () => {
  assert.equal(formatUsdc(159_000_000), "159");
  assert.equal(formatUsdc(5_500_000), "5.5");
  assert.equal(formatUsdc(10_000), "0.01");
});

test("nativeToMicros floors Arc's 18-decimal native value to 6 decimals", () => {
  assert.equal(nativeToMicros(200n * 10n ** 18n), 200_000_000);
  // 1.0000019 USDC native: the sub-micro remainder is dropped, never rounded up
  assert.equal(nativeToMicros(1_000_001_900_000_000_000n), 1_000_001);
});

test("microsToNative scales 6-decimal micros up to Arc's 18-decimal native unit", () => {
  assert.equal(microsToNative(5_000_000), 5n * 10n ** 18n);
});
