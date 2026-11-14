import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { transferWithAuthorizationArgs } from "../src/x402/arc-facilitator.ts";
import { createPaymentPayload } from "../src/x402/buyer.ts";
import { arcUsdcRequirements } from "../src/x402/protocol.ts";

const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

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
