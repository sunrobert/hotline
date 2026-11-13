import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { Engine } from "./engine.ts";
import { createApp } from "./server.ts";
import { createArcWallet } from "./wallet/arc.ts";
import { formatUsdc } from "./money.ts";
import { CallQueue } from "./calls/queue.ts";
import { createDialer } from "./calls/elevenlabs.ts";
import { startDepositPoller } from "./deposits/watcher.ts";
import { createTokenProvider } from "./dashboard/token.ts";

const cfg = loadConfig(process.env);

if (cfg.dbPath !== ":memory:") mkdirSync(dirname(cfg.dbPath), { recursive: true });
const ledger = new Ledger(cfg.dbPath);
const wallet = createArcWallet(cfg.chain);

// Declared before the engine so the engine's hook can reach it; assigned below if voice is configured.
let queue: CallQueue | null = null;

const engine = new Engine({
  ledger, wallet, cfg: cfg.engine,
  hooks: {
    needsCall: (row) => {
      console.log(`[call-needed] ${row.code}: ${formatUsdc(row.amount)} USDC to ${row.to_label} (${row.rule})`);
      if (queue) queue.enqueue(row.code);
      else console.log("[call-needed] voice is not configured, so nobody is being called. The action will expire.");
    },
  },
});

if (cfg.voice) {
  queue = new CallQueue({ engine, dialer: createDialer(cfg.voice), ownerNumber: cfg.ownerNumber });
  const q = queue;
  setInterval(() => { void q.tick().catch((err) => console.error("[calls]", err)); }, 3000).unref();
}

await engine.recover();
setInterval(() => {
  const expired = engine.expireStale();
  if (expired > 0) console.log(`[expiry] ${expired} pending action(s) expired`);
}, 15_000).unref();

// Deposits: poll Arc for USDC arriving at the agent wallet. Each one may trigger the sweep rule.
startDepositPoller({
  rpcUrl: cfg.chain.rpcUrl,
  agent: wallet.address,
  onDeposit: async (deposit) => {
    const result = await engine.handleDeposit(deposit);
    if (!result.duplicate) console.log(`[deposit] ${formatUsdc(deposit.amount)} USDC from ${deposit.from_addr} -> ${result.action?.decision ?? "nothing"} (${result.action?.reason ?? result.action?.rule ?? ""})`);
  },
});

const app = createApp({
  engine, cfg: cfg.server,
  isOutbound: (id) => queue?.isOutbound(id) ?? false,
  getConversationToken: cfg.agent ? createTokenProvider(cfg.agent) : null,
});
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`[hotline] listening on :${info.port}`);
  console.log(`[hotline] dashboard http://localhost:${info.port}/dashboard (sign in with DASHBOARD_TOKEN from .env.local)`);
  console.log(`[hotline] agent wallet ${wallet.address} on Arc testnet`);
  console.log(`[hotline] browser calls ${cfg.agent ? "on" : "off (no ElevenLabs key or agent id)"}`);
  console.log(`[hotline] phone calls ${cfg.voice ? `on, approvals ring ${cfg.ownerNumber.replace(/\d(?=\d{4})/g, "*")}` : "off (no phone number attached)"}`);
});
