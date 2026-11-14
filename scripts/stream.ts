// Manages the QuickNode Stream that watches for USDC arriving at the agent wallet.
//
//   npm run stream -- check     run our filter on QuickNode's servers against a real past deposit
//   npm run stream -- on        start a fresh Stream at the chain tip, pointed at PUBLIC_URL
//   npm run stream -- off       delete it (billing stops)
//   npm run stream -- status    show it
//   npm run stream -- retarget  point an existing Stream at the current PUBLIC_URL (used by `npm run tunnel`)
//
// Streams bill per block processed, about 105,000 blocks a day on Arc testnet, so keep it off
// unless you are rehearsing, recording, or demoing. `on` always starts at the tip: no backfill.

import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { buildStreamConfig, STREAM_EXTERNAL_ID } from "../src/deposits/stream-config.ts";
import { buildStreamFilter } from "../src/deposits/stream-filter.ts";
import { setEnvValue } from "./tunnel-lib.ts";

const API = "https://api.quicknode.com/streams/rest/v1";
const ENV = ".env.local";
const NETWORK = process.env.QUICKNODE_NETWORK || "arc-testnet";
const command = process.argv[2] ?? "status";

const apiKey = process.env.QUICKNODE_API_KEY?.trim();
if (!apiKey) throw new Error("QUICKNODE_API_KEY is missing from .env.local (dashboard.quicknode.com/api-keys, with Streams enabled)");
const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`).address;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method, headers: { "x-api-key": apiKey!, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface Stream { id: string; name: string; status: string; network: string; dataset: string; destination_attributes?: { url?: string }; start_range?: number; current_block?: number; }
const findOurs = async (): Promise<Stream[]> => {
  const res = await call<{ data?: Stream[] } | Stream[]>("GET", `/streams?external_id=${STREAM_EXTERNAL_ID}`);
  return Array.isArray(res) ? res : (res.data ?? []);
};

function secret(): string {
  const existing = process.env.QUICKNODE_STREAM_SECRET?.trim();
  if (existing && existing.length >= 32) return existing;
  const fresh = randomBytes(24).toString("hex");
  writeFileSync(ENV, setEnvValue(readFileSync(ENV, "utf8"), "QUICKNODE_STREAM_SECRET", fresh), { mode: 0o600 });
  console.log("secret   generated QUICKNODE_STREAM_SECRET in .env.local. Restart `npm start` so the server can verify deliveries.");
  return fresh;
}

const show = (s: Stream) => `${s.id}  ${s.status}  ${s.network}/${s.dataset}  -> ${s.destination_attributes?.url ?? "?"}`;

if (command === "check") {
  // A real deposit to the agent: the top-up made by `npm run reset-demo` on Nov 13.
  const block = process.env.STREAM_CHECK_BLOCK || "72214961";
  const res = await call<unknown>("POST", "/streams/test_filter", {
    network: NETWORK, dataset: "logs", block, filter_function: Buffer.from(buildStreamFilter(agent)).toString("base64"),
  });
  console.log(`network  ${NETWORK} accepted; filter ran on QuickNode against block ${block}:`);
  console.log(JSON.stringify(res, null, 2).slice(0, 1500));
} else if (command === "on") {
  const publicUrl = process.env.PUBLIC_URL?.trim();
  if (!publicUrl || publicUrl.endsWith(".invalid")) throw new Error("PUBLIC_URL is not set. Run `npm run tunnel` first.");
  for (const old of await findOurs()) { await call("DELETE", `/streams/${old.id}`); console.log(`deleted  old stream ${old.id}`); }
  const created = await call<Stream>("POST", "/streams", buildStreamConfig({ agent, publicUrl, secret: secret(), network: NETWORK }));
  console.log(`on       ${show(created)}`);
  console.log("billing  runs per block until `npm run stream -- off`");
} else if (command === "off") {
  const ours = await findOurs();
  for (const s of ours) { await call("DELETE", `/streams/${s.id}`); console.log(`off      deleted ${s.id}`); }
  if (!ours.length) console.log("off      no stream to delete");
} else if (command === "retarget") {
  const publicUrl = process.env.PUBLIC_URL?.trim();
  const ours = await findOurs();
  if (!ours.length || !publicUrl) { console.log("stream   none running; nothing to retarget"); process.exit(0); }
  const cfg = buildStreamConfig({ agent, publicUrl, secret: secret(), network: NETWORK });
  for (const s of ours) {
    await call("PATCH", `/streams/${s.id}`, { destination: "webhook", destination_attributes: cfg.destination_attributes });
    console.log(`stream   ${s.id} now delivers to ${cfg.destination_attributes.url}`);
  }
} else {
  const ours = await findOurs();
  console.log(ours.length ? ours.map((s) => `stream   ${show(s)}`).join("\n") : "stream   none (off)");
}
