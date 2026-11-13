// Demo helper: send testnet USDC from the `sender` demo wallet to the agent wallet.
// This is the "money arrives" moment that makes the phone ring.
//
//   npm run demo:deposit -- 200

import { privateKeyToAccount } from "viem/accounts";
import { createArcWallet, explorerTx } from "../src/wallet/arc.ts";
import { toMicros, formatUsdc } from "../src/money.ts";

const amount = toMicros(Number(process.argv[2] ?? "200"));
const senderKey = process.env.SENDER_PRIVATE_KEY as `0x${string}` | undefined;
const agentKey = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!senderKey || !agentKey) throw new Error("SENDER_PRIVATE_KEY and AGENT_PRIVATE_KEY are required in .env.local");

const sender = createArcWallet({ rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io", privateKey: senderKey });
const agent = privateKeyToAccount(agentKey).address;

const balance = await sender.balance();
console.log(`sender ${sender.address} has ${formatUsdc(balance)} USDC`);
if (balance < amount) throw new Error(`not enough: fund the sender at https://faucet.circle.com (Arc Testnet)`);

const hash = await sender.send(agent, amount);
console.log(`sent ${formatUsdc(amount)} USDC to agent ${agent}`);
console.log(explorerTx(hash));
const receipt = await sender.waitForReceipt(hash);
console.log(receipt.ok ? "confirmed" : `failed: ${receipt.error}`);
