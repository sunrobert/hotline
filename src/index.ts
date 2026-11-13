import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { Engine } from "./engine.ts";
import { createApp } from "./server.ts";
import { createArcWallet } from "./wallet/arc.ts";
import { formatUsdc } from "./money.ts";

const cfg = loadConfig(process.env);

if (cfg.dbPath !== ":memory:") mkdirSync(dirname(cfg.dbPath), { recursive: true });
const ledger = new Ledger(cfg.dbPath);
const wallet = createArcWallet(cfg.chain);

const engine = new Engine({
  ledger, wallet, cfg: cfg.engine,
  hooks: {
    // The outbound call queue plugs in here.
    needsCall: (row) => console.log(`[call-needed] ${row.code}: ${formatUsdc(row.amount)} USDC to ${row.to_label} (${row.rule})`),
  },
});

await engine.recover();
setInterval(() => {
  const expired = engine.expireStale();
  if (expired > 0) console.log(`[expiry] ${expired} pending action(s) expired`);
}, 15_000).unref();

const app = createApp({ engine, cfg: cfg.server });
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`[hotline] listening on :${info.port}`);
  console.log(`[hotline] agent wallet ${wallet.address} on Arc testnet`);
});
