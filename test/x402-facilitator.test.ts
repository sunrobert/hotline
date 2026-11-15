import { test } from "node:test";
import assert from "node:assert/strict";
import { custom, keccak256, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createArcFacilitator, transferWithAuthorizationArgs } from "../src/x402/arc-facilitator.ts";
import { createPaymentPayload } from "../src/x402/buyer.ts";
import { arcUsdcRequirements } from "../src/x402/protocol.ts";

const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
// Hardhat's third dev key: the address above. Test-only, holds nothing anywhere.
const SELLER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

test("a payment becomes the nine transferWithAuthorization arguments, signature split into v, r, s", async () => {
  const requirements = arcUsdcRequirements({ amountMicros: 10_000, payTo: SELLER });
  const p = await createPaymentPayload({
    account: payer, nowSec: 1_800_000_000, nonce: `0x${"ab".repeat(32)}`,
    required: { x402Version: 2, resource: { url: "x" }, accepts: [requirements] },
  });
  const args = transferWithAuthorizationArgs(p);
  assert.equal(args.length, 9);
  assert.deepEqual(args.slice(0, 6), [payer.address, SELLER, 10_000n, 1_799_999_995n, 1_800_000_060n, `0x${"ab".repeat(32)}`]);
  assert.ok(args[6] === 27 || args[6] === 28);
  assert.equal(args[7], p.payload.signature.slice(0, 66));
  assert.equal(args[8], "0x" + p.payload.signature.slice(66, 130));
});

// A chain double that answers the RPC calls settle() makes, with a slow nonce lookup so two
// settlements overlap the way two price lookups in one turn would.
function fakeArcRpc() {
  const sentNonces: number[] = [];
  let pendingCount = 7;
  const request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    switch (method) {
      case "eth_chainId": return "0x4cef52";
      case "eth_blockNumber": return "0x100";
      case "eth_maxPriorityFeePerGas": return "0x1";
      case "eth_getBlockByNumber": return { number: "0x100", hash: "0x" + "11".repeat(32), baseFeePerGas: "0x4a817c800", timestamp: "0x1", transactions: [] };
      case "eth_estimateGas": return "0x15f90";
      case "eth_getTransactionCount": {
        const n = pendingCount;
        await new Promise((r) => setTimeout(r, 20));
        return "0x" + n.toString(16);
      }
      case "eth_sendRawTransaction": {
        const tx = parseTransaction(params![0] as `0x${string}`);
        if (sentNonces.includes(tx.nonce!)) throw new Error("nonce too low");
        sentNonces.push(tx.nonce!);
        pendingCount = Math.max(pendingCount, tx.nonce! + 1);
        return keccak256(params![0] as `0x${string}`);
      }
      case "eth_getTransactionReceipt": return {
        transactionHash: (params as string[])[0], blockNumber: "0x100", blockHash: "0x" + "11".repeat(32), status: "0x1",
        logs: [], gasUsed: "0x15f90", cumulativeGasUsed: "0x15f90", effectiveGasPrice: "0x4a817c800",
        transactionIndex: "0x0", type: "0x2", from: SELLER, to: "0x3600000000000000000000000000000000000000",
        contractAddress: null, logsBloom: "0x" + "00".repeat(256),
      };
      default: throw new Error(`fake rpc: ${method} not handled`);
    }
  };
  return { transport: custom({ request }), sentNonces };
}

test("two settlements at once go out with different nonces and both land", async () => {
  const rpc = fakeArcRpc();
  const facilitator = createArcFacilitator({ rpcUrl: "http://unused", privateKey: SELLER_KEY, transport: rpc.transport });
  const requirements = arcUsdcRequirements({ amountMicros: 10_000, payTo: facilitator.address });
  const pay = (byte: string) => createPaymentPayload({
    account: payer, nowSec: Math.floor(Date.now() / 1000), nonce: `0x${byte.repeat(32)}`,
    required: { x402Version: 2, resource: { url: "x" }, accepts: [requirements] },
  });
  const [a, b] = await Promise.all([pay("01"), pay("02")]);
  const results = await Promise.all([facilitator.settle(a, requirements), facilitator.settle(b, requirements)]);
  assert.deepEqual(results.map((r) => r.success), [true, true], JSON.stringify(results));
  assert.deepEqual([...rpc.sentNonces].sort(), [7, 8]);
});
