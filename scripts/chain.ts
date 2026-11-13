// Read-only check of Arc testnet: reachability, fees, demo wallet balances, and the
// shape of the USDC Transfer log the deposit trigger depends on. Sends nothing.

import { createPublicClient, http, parseAbiItem, formatGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, USDC_SYSTEM_EMITTER } from "../src/wallet/arc.ts";
import { ARC_MIN_FEE_PER_GAS } from "../src/wallet/fees.ts";
import { nativeToMicros, formatUsdc } from "../src/money.ts";

const rpcUrl = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io";
const client = createPublicClient({ chain: ARC_TESTNET, transport: http(rpcUrl, { retryCount: 3 }) });

const [chainId, block, fees] = await Promise.all([client.getChainId(), client.getBlock(), client.estimateFeesPerGas()]);
console.log(`rpc        ${rpcUrl}`);
console.log(`chain id   ${chainId} ${chainId === ARC_TESTNET.id ? "(Arc testnet)" : "(UNEXPECTED)"}`);
console.log(`block      ${block.number}  ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
console.log(`fees       maxFeePerGas ${formatGwei(fees.maxFeePerGas)} gwei (floor ${formatGwei(ARC_MIN_FEE_PER_GAS)})`);

console.log("\nwallets");
for (const name of ["AGENT", "SENDER", "SAVINGS", "ALICE"]) {
  const key = process.env[`${name}_PRIVATE_KEY`];
  if (!key) { console.log(`  ${name.toLowerCase().padEnd(8)} (no key in env)`); continue; }
  const address = privateKeyToAccount(key as `0x${string}`).address;
  const balance = nativeToMicros(await client.getBalance({ address }));
  console.log(`  ${name.toLowerCase().padEnd(8)} ${address}  ${formatUsdc(balance)} USDC`);
}

// Does a USDC movement really surface as a Transfer log from the system emitter?
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const span = 20n;
const logs = await client.getLogs({ address: USDC_SYSTEM_EMITTER, event: transfer, fromBlock: block.number - span, toBlock: block.number });
console.log(`\nsystem Transfer logs in the last ${span} blocks: ${logs.length}`);
const sample = logs.at(-1);
if (sample) {
  console.log(`  sample  tx ${sample.transactionHash} log #${sample.logIndex}`);
  console.log(`          ${sample.args.from} -> ${sample.args.to}`);
  console.log(`          value ${sample.args.value} (18 decimals) = ${formatUsdc(nativeToMicros(sample.args.value ?? 0n))} USDC`);
}
