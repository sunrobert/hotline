import { test } from "node:test";
import assert from "node:assert/strict";
import { depositFromLog } from "../src/deposits/watcher.ts";
import { USDC_SYSTEM_EMITTER, USDC_ERC20 } from "../src/wallet/arc.ts";

const AGENT = "0x354ea63B9120b9d98fd8FbD18145055561EFBa9D";
const SENDER = "0xbc8D3a1A11eC298608968Fd7c0577aF2eDcD6659";
const U18 = 10n ** 18n;

const log = (over: Record<string, unknown> = {}) => ({
  address: USDC_SYSTEM_EMITTER as string,
  transactionHash: "0xabc" as string | null,
  logIndex: 3 as number | null,
  blockNumber: 72205016n as bigint | null,
  args: { from: SENDER, to: AGENT, value: 200n * U18 } as { from?: string; to?: string; value?: bigint },
  ...over,
});

test("a system Transfer log to the agent becomes a deposit in micro-USDC", () => {
  assert.deepEqual(depositFromLog(log(), AGENT, "poller", 1234), {
    tx_hash: "0xabc", log_index: 3, from_addr: SENDER, amount: 200_000_000, block_number: 72205016, via: "poller", now: 1234,
  });
});

test("the agent address is matched without regard to checksum case", () => {
  assert.ok(depositFromLog(log(), AGENT.toLowerCase(), "poller", 1));
});

test("a log from the ERC-20 contract is ignored, so one transfer is never counted twice", () => {
  assert.equal(depositFromLog(log({ address: USDC_ERC20 }), AGENT, "poller", 1), null);
});

test("a transfer to someone else is ignored", () => {
  assert.equal(depositFromLog(log({ args: { from: AGENT, to: SENDER, value: 5n * U18 } }), AGENT, "poller", 1), null);
});

test("dust below one micro-USDC is ignored", () => {
  assert.equal(depositFromLog(log({ args: { from: SENDER, to: AGENT, value: 999_999_999_999n } }), AGENT, "poller", 1), null);
});

test("a pending log with no transaction hash yet is ignored", () => {
  assert.equal(depositFromLog(log({ transactionHash: null }), AGENT, "poller", 1), null);
  assert.equal(depositFromLog(log({ logIndex: null }), AGENT, "poller", 1), null);
});
