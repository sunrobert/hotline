// Before a rehearsal, a recording, or the finals: is everything actually ready?
//
//   npm run preflight
//
// Read-only. Looks at the local server, the public tunnel, the agent's wiring on ElevenLabs,
// the phone number, the QuickNode Stream, the ledger, wallet balances, and credits left.
// Prints each check with a fix, and exits 1 if anything would break the demo.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { evaluatePreflight } from "./preflight-lib.ts";
import type { PreflightFacts } from "./preflight-lib.ts";
import { publicHealthy } from "./net.ts";
import { STREAM_EXTERNAL_ID } from "../src/deposits/stream-config.ts";
import { nativeToMicros } from "../src/money.ts";

const env = process.env;
const port = Number(env.PORT || 8787);
const local = `http://localhost:${port}`;
const elevenKey = env.ELEVENLABS_API_KEY ?? "";
const quickKey = env.QUICKNODE_API_KEY ?? "";

const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
const json = async (url: string, headers: Record<string, string>) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<any>;
};

const serverUp = (await attempt(async () => (await fetch(`${local}/health`, { signal: AbortSignal.timeout(5000) })).ok)) ?? false;
const publicUrl = env.PUBLIC_URL?.trim() && !env.PUBLIC_URL.endsWith(".invalid") ? env.PUBLIC_URL.trim() : null;
const publicUp = publicUrl ? await publicHealthy(publicUrl) : false;

const agentToolsUrl = await attempt(async () => {
  const tools = (await json("https://api.elevenlabs.io/v1/convai/tools", { "xi-api-key": elevenKey })).tools as any[];
  const bases = [...new Set(tools.filter((t) => t.tool_config.type === "webhook" && t.tool_config.api_schema?.url?.includes("/tools/"))
    .map((t) => String(t.tool_config.api_schema.url).replace(/\/tools\/.*$/, "")))];
  return bases.length === 1 ? bases[0]! : bases.join(" + ") || null;
});
const callStartHookUrl = await attempt(async () =>
  (await json("https://api.elevenlabs.io/v1/convai/settings", { "xi-api-key": elevenKey })).conversation_initiation_client_data_webhook?.url ?? null);
const phoneNumberAssigned = (await attempt(async () => {
  const numbers = await json("https://api.elevenlabs.io/v1/convai/phone-numbers", { "xi-api-key": elevenKey }) as any[];
  const ours = numbers.find((n) => n.phone_number_id === env.ELEVENLABS_PHONE_NUMBER_ID);
  return Boolean(ours && ours.assigned_agent?.agent_id === env.ELEVENLABS_AGENT_ID);
})) ?? false;
const elevenLabsCreditsLeft = await attempt(async () => {
  const s = await json("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": elevenKey });
  return Number(s.character_limit) - Number(s.character_count);
});

const stream = await attempt(async () => {
  const res = await json(`https://api.quicknode.com/streams/rest/v1/streams?external_id=${STREAM_EXTERNAL_ID}`, { "x-api-key": quickKey });
  const list = (Array.isArray(res) ? res : res.data ?? []) as any[];
  return list.find((s) => s.status === "active") ?? null;
});
const quickNodeCreditsLeft = await attempt(async () =>
  Number((await json("https://api.quicknode.com/v0/usage/rpc", { "x-api-key": quickKey })).data?.credits_remaining));
// A configured hook refuses an unsigned request with 401; an unconfigured one does not exist (404).
const streamHookConfigured = (await attempt(async () =>
  (await fetch(`${local}/hooks/quicknode`, { method: "POST", body: "{}", signal: AbortSignal.timeout(5000) })).status === 401)) ?? false;

const dbPath = env.DB_PATH || "data/hotline.db";
const ledgerFacts = existsSync(dbPath) ? await attempt(async () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const paused = (db.prepare("SELECT value FROM settings WHERE key = 'paused'").get() as { value: string } | undefined)?.value === "1";
  const pending = Number((db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'pending'").get() as { n: number }).n);
  db.close();
  return { paused, pending };
}) : { paused: false, pending: 0 };

const chain = createPublicClient({ chain: arcTestnet, transport: http(env.ARC_RPC_URL || "https://rpc.testnet.arc.io", { retryCount: 2 }) });
const balanceOf = (key: string | undefined) => attempt(async () =>
  key ? nativeToMicros(await chain.getBalance({ address: privateKeyToAccount(key as `0x${string}`).address })) : null);
const [agentBalance, senderBalance] = await Promise.all([balanceOf(env.AGENT_PRIVATE_KEY), balanceOf(env.SENDER_PRIVATE_KEY)]);

const facts: PreflightFacts = {
  serverUp, publicUrl, publicUp, agentToolsUrl, callStartHookUrl,
  phoneNumberAssigned,
  voiceConfigured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID && env.ELEVENLABS_PHONE_NUMBER_ID),
  streamRunning: stream !== null,
  streamUrl: stream?.destination_attributes?.url ?? null,
  streamHookConfigured,
  paused: ledgerFacts?.paused ?? null,
  pendingActions: ledgerFacts?.pending ?? null,
  agentBalance, senderBalance, elevenLabsCreditsLeft, quickNodeCreditsLeft,
};

const checks = evaluatePreflight(facts);
const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
for (const c of checks) {
  console.log(`${mark[c.level]} ${c.name.padEnd(19)} ${c.message}`);
  if (c.fix) console.log(`  ${"".padEnd(19)} → ${c.fix}`);
}
const fails = checks.filter((c) => c.level === "fail").length;
const warns = checks.filter((c) => c.level === "warn").length;
console.log(`\n${fails ? `NOT READY: ${fails} blocker(s)` : "READY"}${warns ? `, ${warns} warning(s)` : ""}.`);
process.exit(fails ? 1 : 0);
