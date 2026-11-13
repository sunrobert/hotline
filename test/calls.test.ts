import { test } from "node:test";
import assert from "node:assert/strict";
import { CallQueue, callScript } from "../src/calls/queue.ts";
import type { Dialer } from "../src/calls/queue.ts";
import { createDialer } from "../src/calls/elevenlabs.ts";
import { setup, U, PIN } from "./helpers.ts";

const OWNER = "+15125550147";

class FakeDialer implements Dialer {
  dials: { toNumber: string; variables: Record<string, string>; conversationId: string }[] = [];
  ended = new Set<string>();
  failNext: string | null = null;
  async dial(req: { toNumber: string; variables: Record<string, string> }) {
    if (this.failNext) { const m = this.failNext; this.failNext = null; throw new Error(m); }
    const conversationId = `out-${this.dials.length + 1}`;
    this.dials.push({ ...req, conversationId });
    return { conversationId };
  }
  async isEnded(conversationId: string) { return this.ended.has(conversationId); }
}

function rig(opts: { balance?: number } = {}) {
  const ctx = setup({ balance: opts.balance ?? 60 * U });
  const dialer = new FakeDialer();
  const queue = new CallQueue({ engine: ctx.engine, dialer, ownerNumber: OWNER, now: () => ctx.clock.t, retryDelayMs: 90_000 });
  /** Deliver a deposit and hand any resulting call request to the queue, as the boot file does. */
  const deposit = async (amount: number) => {
    const seen = ctx.calls.length;
    const r = await ctx.deposit(amount);
    for (const row of ctx.calls.slice(seen)) queue.enqueue(row.code);
    return r;
  };
  return { ...ctx, dialer, queue, deposit };
}

// ---------- what the agent is told to say ----------

test("the call script for a sweep states the amount and destination and asks for yes and PIN", async () => {
  const { deposit, ledger } = rig();
  await deposit(200 * U);
  const script = callScript(ledger.pendingSweep()!);
  assert.match(script.opening_line, /159/);
  assert.match(script.opening_line, /savings/);
  assert.match(script.opening_line, /PIN/);
  assert.match(script.call_context, /You placed this call/);
  assert.match(script.call_context, /Send 159 USDC to savings/);
});

test("the call script for a texted request says the owner asked for it", async () => {
  const { engine, ledger } = rig({ balance: 260 * U });
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "text" });
  const script = callScript(ledger.get(r.action_code)!);
  assert.match(script.call_context, /asked by text/i);
  assert.match(script.opening_line, /80/);
  assert.match(script.opening_line, /alice/);
});

test("the call script never contains an address or an action code", async () => {
  const { deposit, ledger } = rig();
  await deposit(200 * U);
  const text = JSON.stringify(callScript(ledger.pendingSweep()!));
  assert.doesNotMatch(text, /0x[0-9a-fA-F]{6,}/);
  assert.doesNotMatch(text, /H-[A-Z0-9]{4}/);
});

// ---------- the queue ----------

test("a deposit over the threshold makes the queue dial the owner and bind the call to the action", async () => {
  const { deposit, queue, dialer, ledger } = rig();
  await deposit(200 * U);
  await queue.tick();
  assert.equal(dialer.dials.length, 1);
  assert.equal(dialer.dials[0]?.toNumber, OWNER);
  assert.match(dialer.dials[0]?.variables.opening_line ?? "", /159/);
  const sweep = ledger.pendingSweep()!;
  assert.equal(sweep.conversation_id, "out-1");
  assert.equal(sweep.call_live, 1);
  assert.equal(queue.isOutbound("out-1"), true);
  assert.equal(queue.isOutbound("someone-else"), false);
});

test("the amount read out is the one recomputed at dial time", async () => {
  const { deposit, queue, dialer, wallet } = rig();
  await deposit(200 * U);
  wallet.balanceMicros = 200 * U;
  await queue.tick();
  assert.match(dialer.dials[0]?.variables.opening_line ?? "", /\b99\b/);
});

test("nothing is dialled if the action is no longer needed by the time its turn comes", async () => {
  const { deposit, queue, dialer, wallet } = rig();
  await deposit(200 * U);
  wallet.balanceMicros = 90 * U;
  await queue.tick();
  assert.equal(dialer.dials.length, 0);
  assert.equal(queue.size, 0);
});

test("a yes on the outbound call executes, and the finished call is not retried", async () => {
  const { deposit, queue, dialer, engine, wallet, clock } = rig();
  await deposit(200 * U);
  await queue.tick();
  await engine.confirm({ conversationId: "out-1", approved: true, pin: PIN });
  dialer.ended.add("out-1");
  await queue.tick();
  clock.t += 5 * 60_000;
  await queue.tick();
  assert.equal(wallet.sends.length, 1);
  assert.equal(dialer.dials.length, 1);
  assert.equal(queue.size, 0);
});

test("an unanswered call is retried once after ninety seconds, then given up as no answer", async () => {
  const { deposit, queue, dialer, ledger, clock } = rig();
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  await queue.tick();
  dialer.ended.add("out-1");
  await queue.tick(); // call ended, nothing decided
  assert.equal(ledger.get(code)?.call_live, 0);
  clock.t += 89_000;
  await queue.tick();
  assert.equal(dialer.dials.length, 1, "not before ninety seconds");
  clock.t += 2_000;
  await queue.tick();
  assert.equal(dialer.dials.length, 2);
  dialer.ended.add("out-2");
  await queue.tick();
  assert.equal(ledger.get(code)?.status, "expired_no_answer");
  assert.equal(queue.size, 0);
  clock.t += 10 * 60_000;
  await queue.tick();
  assert.equal(dialer.dials.length, 2, "no third call");
});

test("a failed dial counts as an attempt", async () => {
  const { deposit, queue, dialer, ledger, clock } = rig();
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  dialer.failNext = "twilio: number not verified";
  await queue.tick();
  assert.equal(dialer.dials.length, 0);
  assert.equal(ledger.get(code)?.status, "pending");
  clock.t += 91_000;
  dialer.failNext = "twilio: number not verified";
  await queue.tick();
  assert.equal(ledger.get(code)?.status, "expired_no_answer");
});

test("only one call is in progress at a time", async () => {
  const { deposit, queue, dialer, engine } = rig({ balance: 260 * U });
  const first = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "text" });
  const second = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 70, source: "text" });
  queue.enqueue(first.action_code);
  queue.enqueue(second.action_code);
  await queue.tick();
  await queue.tick();
  assert.equal(dialer.dials.length, 1);
  await engine.confirm({ conversationId: "out-1", approved: false });
  dialer.ended.add("out-1");
  await queue.tick(); // first call wraps up
  await queue.tick(); // second is dialled
  assert.equal(dialer.dials.length, 2);
  assert.match(dialer.dials[1]?.variables.opening_line ?? "", /70/);
  void deposit;
});

test("the same action enqueued twice is only called about once", async () => {
  const { deposit, queue, dialer, ledger } = rig();
  await deposit(200 * U);
  queue.enqueue(ledger.pendingSweep()!.code);
  assert.equal(queue.size, 1);
  await queue.tick();
  assert.equal(dialer.dials.length, 1);
});

test("a call that never reports an end is treated as ended after the maximum call length", async () => {
  const { deposit, queue, dialer, ledger, clock } = rig();
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  await queue.tick();
  clock.t += 7 * 60_000;
  await queue.tick();
  assert.equal(ledger.get(code)?.call_live, 0);
  assert.equal(dialer.dials.length, 1);
});

// ---------- the ElevenLabs dialer ----------

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const requests: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { impl: impl as typeof fetch, requests };
}
const dialerWith = (f: typeof fetch) => createDialer({ apiKey: "key-for-tests", agentId: "agent_1", phoneNumberId: "phnum_1", fetch: f });

test("dialling posts the agent, the number, and the call variables to the outbound call endpoint", async () => {
  const { impl, requests } = fakeFetch([{ status: 200, body: { success: true, message: "ok", conversation_id: "conv_9", callSid: "CA1" } }]);
  const r = await dialerWith(impl).dial({ toNumber: OWNER, variables: { call_context: "ctx", opening_line: "hi" } });
  assert.equal(r.conversationId, "conv_9");
  assert.equal(requests[0]?.url, "https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.headers["xi-api-key"], "key-for-tests");
  assert.deepEqual(requests[0]?.body, {
    agent_id: "agent_1", agent_phone_number_id: "phnum_1", to_number: OWNER,
    conversation_initiation_client_data: { dynamic_variables: { call_context: "ctx", opening_line: "hi" } },
  });
});

test("a dial the provider rejects, or one with no conversation id, throws with the provider's message", async () => {
  const rejected = fakeFetch([{ status: 200, body: { success: false, message: "The number is unverified" } }]);
  await assert.rejects(dialerWith(rejected.impl).dial({ toNumber: OWNER, variables: {} }), /unverified/);
  const http = fakeFetch([{ status: 422, body: { detail: "bad" } }]);
  await assert.rejects(dialerWith(http.impl).dial({ toNumber: OWNER, variables: {} }), /422/);
});

test("a conversation counts as ended once its status is done or failed", async () => {
  const { impl } = fakeFetch([
    { status: 200, body: { status: "initiated" } }, { status: 200, body: { status: "in-progress" } },
    { status: 200, body: { status: "processing" } }, { status: 200, body: { status: "done" } },
    { status: 200, body: { status: "failed" } }, { status: 404, body: {} },
  ]);
  const d = dialerWith(impl);
  assert.deepEqual(
    [await d.isEnded("c"), await d.isEnded("c"), await d.isEnded("c"), await d.isEnded("c"), await d.isEnded("c"), await d.isEnded("c")],
    [false, false, true, true, true, false],
  );
});
