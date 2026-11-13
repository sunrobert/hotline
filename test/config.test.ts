import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

const U = 1_000_000;
const A = "0x00000000000000000000000000000000000a11ce";
const S = "0x000000000000000000000000000000000005a7e5";

const env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  PER_TX_CAP: "250", DAILY_CAP: "1000", APPROVAL_THRESHOLD: "50", GAS_RESERVE_USDC: "1",
  SWEEP_THRESHOLD_USDC: "100", SAVINGS_LABEL: "savings",
  ALLOWLIST: `savings:${S}, alice:${A}`,
  ALLOWLIST_ALIASES: "savings:储蓄|存款,alice:爱丽丝",
  OWNER_NUMBERS: "+1 (512) 555-0147, +8613800138000", OWNER_PIN: "5729",
  HOTLINE_SECRET: "tool-secret-for-tests", DASHBOARD_TOKEN: "dash-token-for-tests",
  AGENT_PRIVATE_KEY: "0x" + "11".repeat(32),
  ...over,
});

test("loadConfig turns USDC limits into micro-USDC", () => {
  const cfg = loadConfig(env());
  assert.equal(cfg.engine.perTxCap, 250 * U);
  assert.equal(cfg.engine.dailyCap, 1000 * U);
  assert.equal(cfg.engine.approvalThreshold, 50 * U);
  assert.equal(cfg.engine.gasReserve, 1 * U);
  assert.equal(cfg.engine.sweepThreshold, 100 * U);
});

test("loadConfig parses the allowlist and its spoken aliases", () => {
  const cfg = loadConfig(env());
  assert.deepEqual(cfg.engine.allowlist, { savings: S, alice: A });
  assert.deepEqual(cfg.engine.aliases, { savings: ["储蓄", "存款"], alice: ["爱丽丝"] });
});

test("loadConfig normalizes owner numbers to E.164", () => {
  assert.deepEqual(loadConfig(env()).server.ownerNumbers, ["+15125550147", "+8613800138000"]);
});

test("loadConfig applies defaults for the optional settings", () => {
  const cfg = loadConfig(env());
  assert.equal(cfg.engine.pendingTtlMs, 600_000);
  assert.equal(cfg.engine.dailyResetHourUtc, 0);
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.chain.rpcUrl, "https://rpc.testnet.arc.io");
});

test("loadConfig refuses to start without each required secret", () => {
  for (const key of ["OWNER_PIN", "HOTLINE_SECRET", "DASHBOARD_TOKEN", "OWNER_NUMBERS", "ALLOWLIST", "AGENT_PRIVATE_KEY"]) {
    assert.throws(() => loadConfig(env({ [key]: undefined })), new RegExp(key), `missing ${key} should throw`);
  }
});

test("loadConfig rejects a PIN with fewer than four digits", () => {
  assert.throws(() => loadConfig(env({ OWNER_PIN: "12" })), /OWNER_PIN/);
});

test("loadConfig rejects an allowlist entry that is not an address", () => {
  assert.throws(() => loadConfig(env({ ALLOWLIST: "savings:0x1234" })), /ALLOWLIST/);
});

test("loadConfig rejects a savings label that is not on the allowlist", () => {
  assert.throws(() => loadConfig(env({ SAVINGS_LABEL: "vault" })), /SAVINGS_LABEL/);
});

test("loadConfig rejects limits that contradict each other", () => {
  assert.throws(() => loadConfig(env({ PER_TX_CAP: "2000" })), /PER_TX_CAP/);
  assert.throws(() => loadConfig(env({ APPROVAL_THRESHOLD: "300" })), /APPROVAL_THRESHOLD/);
});

test("loadConfig rejects an owner number it cannot parse", () => {
  assert.throws(() => loadConfig(env({ OWNER_NUMBERS: "call me maybe" })), /OWNER_NUMBERS/);
});

test("voice calling is off unless the ElevenLabs key, agent id, and phone number id are all set", () => {
  assert.equal(loadConfig(env()).voice, null);
  assert.equal(loadConfig(env({ ELEVENLABS_API_KEY: "k", ELEVENLABS_AGENT_ID: "agent_1" })).voice, null);
  assert.deepEqual(
    loadConfig(env({ ELEVENLABS_API_KEY: "k", ELEVENLABS_AGENT_ID: "agent_1", ELEVENLABS_PHONE_NUMBER_ID: "phnum_1" })).voice,
    { apiKey: "k", agentId: "agent_1", phoneNumberId: "phnum_1", provider: "twilio" },
  );
});

test("the first owner number is the one the agent calls", () => {
  assert.equal(loadConfig(env()).ownerNumber, "+15125550147");
});

test("the phone provider defaults to twilio and can be set to sip_trunk, and nothing else", () => {
  const base = { ELEVENLABS_API_KEY: "k", ELEVENLABS_AGENT_ID: "agent_1", ELEVENLABS_PHONE_NUMBER_ID: "phnum_1" };
  assert.equal(loadConfig(env(base)).voice?.provider, "twilio");
  assert.equal(loadConfig(env({ ...base, ELEVENLABS_PHONE_PROVIDER: "sip_trunk" })).voice?.provider, "sip_trunk");
  assert.throws(() => loadConfig(env({ ...base, ELEVENLABS_PHONE_PROVIDER: "carrier-pigeon" })), /ELEVENLABS_PHONE_PROVIDER/);
});

test("browser calling needs only the ElevenLabs key and agent id, not a phone number", () => {
  assert.equal(loadConfig(env()).agent, null);
  assert.equal(loadConfig(env({ ELEVENLABS_API_KEY: "k" })).agent, null);
  const cfg = loadConfig(env({ ELEVENLABS_API_KEY: "k", ELEVENLABS_AGENT_ID: "agent_1" }));
  assert.deepEqual(cfg.agent, { apiKey: "k", agentId: "agent_1" });
  assert.equal(cfg.voice, null);
});
