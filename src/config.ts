// Environment -> typed config. Fails loudly at boot: a guardrail that silently
// loaded a wrong limit is worse than a server that will not start.

import type { EngineConfig } from "./engine.ts";
import { normalizeLabel } from "./policy.ts";
import { normalizeE164 } from "./phone.ts";
import { toMicros } from "./money.ts";

export interface ServerConfig {
  /** Shared secret the voice agent's tool calls must carry in X-Hotline-Secret. */
  secret: string;
  /** E.164 numbers allowed to command the agent. */
  ownerNumbers: string[];
  dashboardToken: string;
}

export interface Config {
  engine: EngineConfig;
  server: ServerConfig;
  chain: { rpcUrl: string; privateKey: `0x${string}` };
  dbPath: string;
  port: number;
  ownerLanguage: string;
  /** The number the agent dials for approvals: the first of OWNER_NUMBERS. */
  ownerNumber: string;
  /** The voice agent on ElevenLabs. Enough for browser calls from the dashboard. Null until it exists. */
  agent: { apiKey: string; agentId: string } | null;
  /** Null until the agent exists and a phone number is attached. Phone calls are skipped without it. */
  voice: { apiKey: string; agentId: string; phoneNumberId: string; provider: "twilio" | "sip_trunk" } | null;
  /** Secret QuickNode signs Stream deliveries with. Null: the Stream hook is off. */
  streamSecret: string | null;
  /** The free RPC poller that also detects deposits. Off only to prove the Stream works alone. */
  depositPoller: boolean;
  /** The x402 price feed (seller + its facilitator key) and where the agent buys from. Null: get_price is off. */
  x402: { sellerKey: `0x${string}`; priceMicros: number; sellerUrl: string } | null;
}

type Env = Record<string, string | undefined>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function usdc(env: Env, key: string): number {
  const raw = required(env, key);
  try { return toMicros(Number(raw)); } catch { throw new Error(`${key} must be a positive USDC amount, got "${raw}"`); }
}

function integer(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer from ${min} to ${max}, got "${raw}"`);
  return n;
}

/** "a:x,b:y" -> [["a","x"],["b","y"]] */
function pairs(raw: string, key: string): [string, string][] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const i = entry.indexOf(":");
    if (i <= 0 || i === entry.length - 1) throw new Error(`${key}: "${entry}" is not label:value`);
    return [normalizeLabel(entry.slice(0, i)), entry.slice(i + 1).trim()];
  });
}

function voice(env: Env): Config["voice"] {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  const agentId = env.ELEVENLABS_AGENT_ID?.trim();
  const phoneNumberId = env.ELEVENLABS_PHONE_NUMBER_ID?.trim();
  const provider = env.ELEVENLABS_PHONE_PROVIDER?.trim() || "twilio";
  if (provider !== "twilio" && provider !== "sip_trunk") throw new Error(`ELEVENLABS_PHONE_PROVIDER must be twilio or sip_trunk, got "${provider}"`);
  return apiKey && agentId && phoneNumberId ? { apiKey, agentId, phoneNumberId, provider } : null;
}

function streamSecret(env: Env): string | null {
  const secret = env.QUICKNODE_STREAM_SECRET?.trim();
  if (!secret) return null;
  if (secret.length < 32) throw new Error("QUICKNODE_STREAM_SECRET must be at least 32 characters");
  return secret;
}

function x402(env: Env, port: number): Config["x402"] {
  const sellerKey = env.PRICES_PRIVATE_KEY?.trim();
  if (!sellerKey) return null;
  if (!PRIVATE_KEY.test(sellerKey)) throw new Error("PRICES_PRIVATE_KEY must be 0x followed by 64 hex characters");
  const priceMicros = env.X402_PRICE_USDC?.trim() ? usdc(env, "X402_PRICE_USDC") : 10_000;
  const sellerUrl = env.X402_SELLER_URL?.trim() || `http://localhost:${port}/x402/price`;
  return { sellerKey: sellerKey as `0x${string}`, priceMicros, sellerUrl };
}

export function loadConfig(env: Env): Config {
  const allowlist: Record<string, string> = {};
  for (const [label, address] of pairs(required(env, "ALLOWLIST"), "ALLOWLIST")) {
    if (!ADDRESS.test(address)) throw new Error(`ALLOWLIST: "${label}" does not map to a 0x address`);
    allowlist[label] = address;
  }

  const aliases: Record<string, string[]> = {};
  for (const [label, names] of pairs(env.ALLOWLIST_ALIASES ?? "", "ALLOWLIST_ALIASES")) {
    if (!Object.hasOwn(allowlist, label)) throw new Error(`ALLOWLIST_ALIASES: "${label}" is not on the allowlist`);
    aliases[label] = names.split("|").map((n) => n.trim()).filter(Boolean);
  }

  const savingsLabel = normalizeLabel(required(env, "SAVINGS_LABEL"));
  if (!Object.hasOwn(allowlist, savingsLabel)) throw new Error(`SAVINGS_LABEL "${savingsLabel}" is not on the allowlist`);

  const perTxCap = usdc(env, "PER_TX_CAP");
  const dailyCap = usdc(env, "DAILY_CAP");
  const approvalThreshold = usdc(env, "APPROVAL_THRESHOLD");
  if (perTxCap > dailyCap) throw new Error("PER_TX_CAP cannot be larger than DAILY_CAP");
  if (approvalThreshold > perTxCap) throw new Error("APPROVAL_THRESHOLD cannot be larger than PER_TX_CAP");

  const ownerPin = required(env, "OWNER_PIN");
  if (ownerPin.replace(/\D/g, "").length < 4) throw new Error("OWNER_PIN needs at least four digits");

  const ownerNumbers = required(env, "OWNER_NUMBERS").split(",").map((s) => s.trim()).filter(Boolean).map((raw) => {
    const n = normalizeE164(raw);
    if (!n) throw new Error(`OWNER_NUMBERS: cannot read "${raw}" as a phone number`);
    return n;
  });

  const privateKey = required(env, "AGENT_PRIVATE_KEY");
  if (!PRIVATE_KEY.test(privateKey)) throw new Error("AGENT_PRIVATE_KEY must be 0x followed by 64 hex characters");

  return {
    engine: {
      perTxCap, dailyCap, approvalThreshold,
      gasReserve: usdc(env, "GAS_RESERVE_USDC"),
      allowlist, aliases,
      sweepThreshold: usdc(env, "SWEEP_THRESHOLD_USDC"),
      savingsLabel,
      ownerPin,
      pendingTtlMs: integer(env, "PENDING_TTL_SEC", 600, 30, 86_400) * 1000,
      dailyResetHourUtc: integer(env, "DAILY_RESET_UTC", 0, 0, 23),
    },
    server: {
      secret: required(env, "HOTLINE_SECRET"),
      ownerNumbers,
      dashboardToken: required(env, "DASHBOARD_TOKEN"),
    },
    chain: {
      rpcUrl: env.ARC_RPC_URL?.trim() || "https://rpc.testnet.arc.io",
      privateKey: privateKey as `0x${string}`,
    },
    dbPath: env.DB_PATH?.trim() || "data/hotline.db",
    port: integer(env, "PORT", 8787, 1, 65_535),
    ownerLanguage: env.OWNER_LANGUAGE?.trim() || "en",
    ownerNumber: ownerNumbers[0]!,
    agent: env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_AGENT_ID?.trim()
      ? { apiKey: env.ELEVENLABS_API_KEY.trim(), agentId: env.ELEVENLABS_AGENT_ID.trim() }
      : null,
    voice: voice(env),
    streamSecret: streamSecret(env),
    depositPoller: env.DEPOSIT_POLLER?.trim().toLowerCase() !== "off",
    x402: x402(env, integer(env, "PORT", 8787, 1, 65_535)),
  };
}
