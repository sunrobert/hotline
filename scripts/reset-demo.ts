// Puts the demo wallets back where a rehearsal starts: money that went to savings and alice
// returns to the sender, and the agent holds 15 USDC (plus a little for gas).
//
//   npm run reset-demo -- --dry-run    # show the plan, move nothing
//   npm run reset-demo                 # do it
//
// Safe with the server running. Topping up the agent looks like a deposit, which would trigger
// the sweep rule and ring the phone, so the agent is paused while money moves, the deposit is
// left to be observed (paused means it is logged and ignored), then the agent is unpaused.
// Pending approvals are cancelled so a rehearsal starts clean.

import { existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createArcWallet, explorerTx } from "../src/wallet/arc.ts";
import { Ledger } from "../src/ledger.ts";
import { formatUsdc, toMicros } from "../src/money.ts";
import { planReset } from "./reset-lib.ts";
import type { Wallet } from "./reset-lib.ts";

const dryRun = process.argv.includes("--dry-run");
const rpcUrl = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io";
const target = toMicros(Number(process.env.DEMO_AGENT_START_USDC || "15"));

const keys: Record<Wallet, string | undefined> = {
  agent: process.env.AGENT_PRIVATE_KEY, sender: process.env.SENDER_PRIVATE_KEY,
  savings: process.env.SAVINGS_PRIVATE_KEY, alice: process.env.ALICE_PRIVATE_KEY,
};
for (const [name, key] of Object.entries(keys)) if (!key) throw new Error(`${name.toUpperCase()}_PRIVATE_KEY is missing from .env.local`);
const wallets = Object.fromEntries(Object.entries(keys).map(([name, key]) =>
  [name, createArcWallet({ rpcUrl, privateKey: key as `0x${string}` })])) as Record<Wallet, ReturnType<typeof createArcWallet>>;
const address = (w: Wallet) => privateKeyToAccount(keys[w] as `0x${string}`).address;

const readBalances = async () => Object.fromEntries(
  await Promise.all((Object.keys(wallets) as Wallet[]).map(async (w) => [w, await wallets[w].balance()] as const))) as Record<Wallet, number>;
const show = (b: Record<Wallet, number>) => (Object.keys(b) as Wallet[]).map((w) => `${w} ${formatUsdc(b[w])}`).join(" | ");

const before = await readBalances();
console.log(`now      ${show(before)}`);
const plan = planReset({ balances: before, agentTarget: target, headroom: 50_000, gasBuffer: 10_000 });
if (plan.transfers.length === 0) console.log("plan     nothing to move");
for (const t of plan.transfers) console.log(`plan     ${t.from} -> ${t.to}  ${formatUsdc(t.amount)} USDC`);
if (plan.shortfall) console.log(`warning  sender is ${formatUsdc(plan.shortfall)} USDC short of topping up the agent. Get more at https://faucet.circle.com (Arc Testnet).`);
if (plan.senderAfter < toMicros(20)) console.log(`warning  sender will hold ${formatUsdc(plan.senderAfter)} USDC; the demo deposit is 20.`);
if (dryRun) { console.log("dry run  nothing moved"); process.exit(0); }

const dbPath = process.env.DB_PATH || "data/hotline.db";
const ledger = existsSync(dbPath) ? new Ledger(dbPath) : null;
const wasPaused = ledger?.isPaused() ?? false;
if (ledger && !wasPaused) { ledger.setPaused(true); console.log("pause    agent paused while money moves"); }

try {
  for (const t of plan.transfers) {
    const hash = await wallets[t.from].send(address(t.to), t.amount);
    const receipt = await wallets[t.from].waitForReceipt(hash);
    console.log(`${receipt.ok ? "sent" : "FAILED"}     ${t.from} -> ${t.to}  ${formatUsdc(t.amount)} USDC  ${explorerTx(hash)}`);
    if (!receipt.ok) throw new Error(`transfer failed: ${receipt.error}`);
  }
  if (ledger) {
    // Let the server's deposit poller (every 2 s) see the top-up while the agent is still paused.
    if (plan.transfers.some((t) => t.to === "agent")) await new Promise((r) => setTimeout(r, 8000));
    const pending = ledger.byStatus("pending");
    for (const row of pending) ledger.update(row.code, { status: "cancelled", reason: "demo_reset", call_live: 0 }, Date.now());
    if (pending.length) console.log(`ledger   cancelled ${pending.length} pending action(s)`);
  }
} finally {
  if (ledger && !wasPaused) { ledger.setPaused(false); console.log("unpause  agent unpaused"); }
  ledger?.close();
}

console.log(`after    ${show(await readBalances())}`);
