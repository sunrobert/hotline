import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { buildStreamFilter } from "../src/deposits/stream-filter.ts";
import { USDC_SYSTEM_EMITTER, USDC_ERC20 } from "../src/wallet/arc.ts";

const AGENT = "0x354ea63B9120b9d98fd8FbD18145055561EFBa9D";
const SENDER = "0xbc8D3a1A11eC298608968Fd7c0577aF2eDcD6659";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const hex = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

const log = (over: Record<string, unknown> = {}) => ({
  address: USDC_SYSTEM_EMITTER.toLowerCase(),
  topics: [TRANSFER, pad(SENDER), pad(AGENT)],
  data: hex(20n * 10n ** 18n),
  blockNumber: "0x44d0d18",
  transactionHash: "0xabc123",
  logIndex: "0x3",
  ...over,
});

/** Run the filter source exactly as QuickNode would: a script that defines main(). */
function runFilter(payload: unknown) {
  const source = buildStreamFilter(AGENT);
  // QuickNode serializes what main() returns; JSON also strips the VM's own Array prototype.
  return JSON.parse(JSON.stringify(runInNewContext(`${source}\nmain(payload);`, { payload }) ?? null));
}

test("the filter source defines main() and has the agent address baked in, lowercased", () => {
  const source = buildStreamFilter(AGENT);
  assert.match(source, /function main\(/);
  assert.ok(source.includes(AGENT.toLowerCase().slice(2)));
});

test("a USDC transfer to the agent from Arc's system emitter becomes a clean deposit", () => {
  const out = runFilter({ data: [[[log()]]], metadata: {} });
  assert.deepEqual(out, {
    deposits: [{ tx_hash: "0xabc123", log_index: 3, from: SENDER.toLowerCase(), to: AGENT.toLowerCase(), value: (20n * 10n ** 18n).toString(), block_number: 72158488 }],
  });
});

test("however deeply QuickNode nests the log arrays, every log is seen", () => {
  const out = runFilter({ data: [log(), [log({ logIndex: "0x4" })], [[log({ logIndex: "0x5" })]]], metadata: {} });
  assert.deepEqual(out.deposits.map((d: { log_index: number }) => d.log_index), [3, 4, 5]);
});

test("the same transfer logged by the ERC-20 contract is ignored, so it is never counted twice", () => {
  assert.equal(runFilter({ data: [[[log({ address: USDC_ERC20.toLowerCase() })]]], metadata: {} }), null);
});

test("transfers to anyone else, other events, and mint-shaped logs without a recipient are ignored", () => {
  const payload = { data: [[[
    log({ topics: [TRANSFER, pad(AGENT), pad(SENDER)] }),
    log({ topics: ["0x" + "11".repeat(32), pad(SENDER), pad(AGENT)] }),
    log({ topics: [TRANSFER, pad(SENDER)] }),
  ]]], metadata: {} };
  assert.equal(runFilter(payload), null);
});

test("a batch with nothing for the agent returns null, so QuickNode delivers nothing", () => {
  assert.equal(runFilter({ data: [[]], metadata: {} }), null);
  assert.equal(runFilter({ data: [], metadata: {} }), null);
});

test("addresses in any letter case still match", () => {
  const out = runFilter({ data: [[[log({ address: USDC_SYSTEM_EMITTER.toUpperCase().replace("0X", "0x"), topics: [TRANSFER.toUpperCase().replace("0X", "0x"), pad(SENDER), pad(AGENT).toUpperCase().replace("0X", "0x")] })]]], metadata: {} });
  assert.equal(out.deposits.length, 1);
});
