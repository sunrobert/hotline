import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePreflight } from "../scripts/preflight-lib.ts";
import type { PreflightFacts } from "../scripts/preflight-lib.ts";

const U = 1_000_000;
const good = (over: Partial<PreflightFacts> = {}): PreflightFacts => ({
  serverUp: true,
  publicUrl: "https://a.trycloudflare.com",
  publicUp: true,
  agentToolsUrl: "https://a.trycloudflare.com",
  callStartHookUrl: "https://a.trycloudflare.com/hooks/conversation-init",
  phoneNumberAssigned: true,
  voiceConfigured: true,
  streamRunning: true,
  streamUrl: "https://a.trycloudflare.com/hooks/quicknode",
  streamHookConfigured: true,
  paused: false,
  pendingActions: 0,
  agentBalance: 15_050_000,
  senderBalance: 50 * U,
  elevenLabsCreditsLeft: 100_000,
  quickNodeCreditsLeft: 79_000_000,
  x402Enabled: true,
  sellerBalance: 500_000,
  ...over,
});

const byName = (facts: PreflightFacts) => Object.fromEntries(evaluatePreflight(facts).map((c) => [c.name, c]));

test("everything in place: every check passes and none is a blocker", () => {
  const checks = evaluatePreflight(good());
  assert.ok(checks.length >= 10);
  assert.deepEqual(checks.filter((c) => c.level !== "ok").map((c) => c.name), []);
});

test("a dead public address is a blocker, and so is the server being down", () => {
  assert.equal(byName(good({ publicUp: false })).tunnel!.level, "fail");
  assert.equal(byName(good({ serverUp: false })).server!.level, "fail");
});

test("the agent pointing at an old tunnel is a blocker, with the fix in the message", () => {
  const c = byName(good({ agentToolsUrl: "https://old.trycloudflare.com" })).agent!;
  assert.equal(c.level, "fail");
  assert.match(c.fix ?? "", /npm run agent|npm run tunnel/);
});

test("a Stream that is off is a warning, not a blocker, because the poller still catches deposits", () => {
  const c = byName(good({ streamRunning: false, streamUrl: null })).stream!;
  assert.equal(c.level, "warn");
  assert.match(c.fix ?? "", /npm run stream -- on/);
});

test("a Stream delivering to an old address is a blocker", () => {
  assert.equal(byName(good({ streamUrl: "https://old.trycloudflare.com/hooks/quicknode" })).stream!.level, "fail");
});

test("a paused agent and leftover pending approvals are blockers before a demo", () => {
  assert.equal(byName(good({ paused: true })).paused!.level, "fail");
  const p = byName(good({ pendingActions: 2 })).pending!;
  assert.equal(p.level, "fail");
  assert.match(p.fix ?? "", /reset-demo/);
});

test("the agent should start near 15 USDC so the sweep read out on stage is the usual 15", () => {
  assert.equal(byName(good({ agentBalance: 2 * U })).agent_balance!.level, "fail");
  assert.equal(byName(good({ agentBalance: 40 * U })).agent_balance!.level, "warn");
});

test("the sender needs at least 20 USDC for the demo deposit", () => {
  assert.equal(byName(good({ senderBalance: 19 * U })).sender_balance!.level, "fail");
});

test("low ElevenLabs credits warn early and block when a full run would not fit", () => {
  assert.equal(byName(good({ elevenLabsCreditsLeft: 20_000 })).elevenlabs_credits!.level, "warn");
  assert.equal(byName(good({ elevenLabsCreditsLeft: 2_000 })).elevenlabs_credits!.level, "fail");
});

test("facts that could not be read are reported as unknown, never as passing", () => {
  const c = byName(good({ elevenLabsCreditsLeft: null, quickNodeCreditsLeft: null }));
  assert.equal(c.elevenlabs_credits!.level, "warn");
  assert.equal(c.quicknode_credits!.level, "warn");
});

test("no phone number attached is a blocker for a phone demo", () => {
  assert.equal(byName(good({ phoneNumberAssigned: false })).phone!.level, "fail");
});

test("x402: the price feed should be on, and its seller needs gas to settle payments", () => {
  assert.equal(byName(good()).x402!.level, "ok");
  const off = byName(good({ x402Enabled: false, sellerBalance: null })).x402!;
  assert.equal(off.level, "warn");
  assert.match(off.fix ?? "", /x402 -- setup/);
  const dry = byName(good({ sellerBalance: 10_000 })).x402!;
  assert.equal(dry.level, "fail");
  assert.match(dry.fix ?? "", /x402 -- setup/);
});
