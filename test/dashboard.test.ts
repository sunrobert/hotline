import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import type { AppDeps } from "../src/server.ts";
import { setup, U, ALICE, SAVINGS, PIN } from "./helpers.ts";

const SECRET = "tool-secret-for-tests";
const TOKEN = "dash-token-for-tests";
const OWNER = "+15125550147";

function harness(over: Partial<AppDeps> = {}, opts: { balance?: number } = {}) {
  const ctx = setup({ balance: opts.balance ?? 260 * U });
  const tokens: string[] = [];
  const app = createApp({
    engine: ctx.engine,
    cfg: { secret: SECRET, ownerNumbers: [OWNER], dashboardToken: TOKEN },
    getConversationToken: async () => { tokens.push("issued"); return "conv-token-abc"; },
    allowSimulate: true,
    now: () => ctx.clock.t,
    ...over,
  });
  const api = async (method: string, path: string, body?: unknown, auth: string | null = `Bearer ${TOKEN}`) => {
    const res = await app.request(path, {
      method, headers: { ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, type: res.headers.get("content-type") ?? "" };
  };
  const tool = async (name: string, body: Record<string, unknown>) => {
    const res = await app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-hotline-secret": SECRET }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...ctx, app, api, tool, tokens };
}

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/state"], ["POST", "/api/unpause"], ["POST", "/api/call/start"],
  ["POST", "/api/call/bind", { conversation_id: "c" }], ["POST", "/api/simulate-deposit", { amount_usdc: 5 }],
];

// ---------- auth ----------

test("every dashboard API route refuses a request without the bearer token", async () => {
  const h = harness();
  for (const [method, path, body] of ROUTES) {
    assert.equal((await h.api(method, path, body, null)).status, 401, `${method} ${path} without a token`);
    assert.equal((await h.api(method, path, body, "Bearer wrong")).status, 401, `${method} ${path} with a wrong token`);
    assert.equal((await h.api(method, path, body, TOKEN)).status, 401, `${method} ${path} without the Bearer scheme`);
  }
  assert.equal(h.tokens.length, 0);
});

test("the token is not accepted in the query string", async () => {
  const h = harness();
  assert.equal((await h.api("GET", `/api/state?token=${TOKEN}`, undefined, null)).status, 401);
});

test("the tool secret does not open the dashboard API, and the dashboard token does not open the tools", async () => {
  const h = harness();
  assert.equal((await h.api("GET", "/api/state", undefined, `Bearer ${SECRET}`)).status, 401);
  const res = await h.app.request("/tools/get_status", { method: "POST", headers: { "content-type": "application/json", "x-hotline-secret": TOKEN }, body: JSON.stringify({ caller_id: OWNER, conversation_id: "c" }) });
  assert.equal(res.status, 401);
});

// ---------- state ----------

test("state reports balance, pause flag, rules, pending actions, and the ledger newest first", async () => {
  const h = harness();
  const sent = await h.engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice", conversationId: "c1" });
  await h.engine.idle();
  const waiting = await h.engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "c1" });
  const r = await h.api("GET", "/api/state");
  assert.equal(r.status, 200);
  assert.equal(r.json.balance_usdc, 255);
  assert.equal(r.json.paused, false);
  assert.equal(r.json.rules.approval_threshold_usdc, 50);
  assert.deepEqual(r.json.pending_actions.map((a: any) => a.action_code), [waiting.action_code]);
  assert.deepEqual(r.json.ledger.map((e: any) => e.code), [waiting.action_code, sent.action_code]);
  const done = r.json.ledger[1];
  assert.deepEqual(
    { source: done.source, kind: done.kind, to_label: done.to_label, amount_usdc: done.amount_usdc, decision: done.decision, rule: done.rule, status: done.status },
    { source: "voice", kind: "send", to_label: "alice", amount_usdc: 5, decision: "AUTO", rule: "auto", status: "complete" },
  );
  assert.equal(typeof done.time, "number");
  assert.match(done.explorer_url, /^https:\/\/explorer\.testnet\.arc\.io\/tx\/0x[0-9a-f]{64}$/);
  assert.equal(r.json.ledger[0].explorer_url, null);
});

test("state exposes recipients by label and never an allowlisted address", async () => {
  const h = harness();
  await h.engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice" });
  const r = await h.api("GET", "/api/state");
  assert.deepEqual(r.json.rules.recipients.map((x: any) => x.label).sort(), ["alice", "savings"]);
  assert.ok(!r.text.toLowerCase().includes(ALICE.toLowerCase()));
  assert.ok(!r.text.toLowerCase().includes(SAVINGS.toLowerCase()));
});

test("state shows the agent's own wallet address, which is public", async () => {
  const h = harness();
  assert.equal((await h.api("GET", "/api/state")).json.wallet_address, h.wallet.address);
});

test("unpause is done from the dashboard", async () => {
  const h = harness();
  h.engine.pause();
  assert.equal((await h.api("GET", "/api/state")).json.paused, true);
  const r = await h.api("POST", "/api/unpause");
  assert.equal(r.status, 200);
  assert.equal(r.json.paused, false);
  assert.equal((await h.engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice" })).decision, "AUTO");
});

// ---------- browser calls ----------

test("starting a call returns a conversation token and every variable the agent's prompt needs", async () => {
  const h = harness();
  const r = await h.api("POST", "/api/call/start");
  assert.equal(r.status, 200);
  assert.equal(r.json.conversation_token, "conv-token-abc");
  assert.match(r.json.dynamic_variables.call_context, /owner/i);
  assert.match(r.json.dynamic_variables.call_context, /Nothing is waiting/);
  assert.ok(r.json.dynamic_variables.opening_line);
});

test("starting a call says so plainly when voice is not configured", async () => {
  const h = harness({ getConversationToken: null });
  const r = await h.api("POST", "/api/call/start");
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "voice_not_configured");
});

test("a failure to get a token is reported without leaking the provider's response", async () => {
  const h = harness({ getConversationToken: async () => { throw new Error("401 from provider: key sk_live_secret rejected"); } });
  const r = await h.api("POST", "/api/call/start");
  assert.equal(r.status, 502);
  assert.equal(r.json.error, "token_failed");
  assert.ok(!r.text.includes("sk_live_secret"));
});

test("starting a call mentions a waiting sweep with its current amount, but binds nothing yet", async () => {
  const h = harness({}, { balance: 60 * U });
  await h.deposit(200 * U);
  const r = await h.api("POST", "/api/call/start");
  assert.match(r.json.dynamic_variables.call_context, /Send 159 USDC to savings/);
  const sweep = h.ledger.pendingSweep()!;
  assert.equal(sweep.conversation_id, null);
  assert.equal(sweep.call_live, 0);
});

test("binding a browser conversation lets its tool calls through the owner gate, and only its own", async () => {
  const h = harness();
  assert.equal((await h.tool("get_status", { conversation_id: "web-1" })).status, 403);
  const bound = await h.api("POST", "/api/call/bind", { conversation_id: "web-1" });
  assert.equal(bound.status, 200);
  assert.equal((await h.tool("get_status", { conversation_id: "web-1" })).status, 200);
  assert.equal((await h.tool("get_status", { conversation_id: "web-2" })).status, 403);
});

test("binding needs a conversation id", async () => {
  const h = harness();
  assert.equal((await h.api("POST", "/api/call/bind", {})).status, 400);
  assert.equal((await h.api("POST", "/api/call/bind", { conversation_id: "  " })).status, 400);
});

test("binding ties a waiting sweep to the call at the amount the agent was told, and a yes then executes it", async () => {
  const h = harness({}, { balance: 60 * U });
  await h.deposit(200 * U);
  await h.api("POST", "/api/call/start"); // agent is told 159
  h.wallet.balanceMicros = 500 * U; // balance moves before the call connects
  const bound = await h.api("POST", "/api/call/bind", { conversation_id: "web-1" });
  assert.equal(bound.json.waiting.amount_usdc, 159);
  const sweep = h.ledger.pendingSweep()!;
  assert.equal(sweep.conversation_id, "web-1");
  assert.equal(sweep.amount, 159 * U);
  const yes = await h.tool("confirm_action", { conversation_id: "web-1", approved: true, pin: PIN });
  assert.equal(yes.json.ok, true);
  assert.deepEqual(h.wallet.sends.map((s) => [s.to, s.amount]), [[SAVINGS, 159 * U]]);
});

test("binding with nothing waiting still authorizes the call and reports nothing waiting", async () => {
  const h = harness();
  const bound = await h.api("POST", "/api/call/bind", { conversation_id: "web-1" });
  assert.equal(bound.json.waiting, null);
});

// ---------- simulated deposits ----------

test("a simulated deposit runs the sweep rule like a real one", async () => {
  const h = harness({}, { balance: 260 * U });
  const r = await h.api("POST", "/api/simulate-deposit", { amount_usdc: 200 });
  assert.equal(r.status, 200);
  assert.equal(r.json.duplicate, false);
  assert.equal(r.json.action.decision, "CALL");
  assert.equal(h.ledger.pendingSweep()?.amount, 159 * U);
  assert.equal(h.calls.length, 1);
});

test("two simulated deposits are two deposits, not a duplicate", async () => {
  const h = harness({}, { balance: 20 * U });
  const a = await h.api("POST", "/api/simulate-deposit", { amount_usdc: 5 });
  const b = await h.api("POST", "/api/simulate-deposit", { amount_usdc: 5 });
  assert.equal(a.json.duplicate, false);
  assert.equal(b.json.duplicate, false);
});

test("simulated deposits do not exist in production", async () => {
  const h = harness({ allowSimulate: false });
  const r = await h.api("POST", "/api/simulate-deposit", { amount_usdc: 200 });
  assert.equal(r.status, 404);
  assert.equal(h.ledger.recent(5).length, 0);
});

test("a simulated deposit needs a positive amount", async () => {
  const h = harness();
  for (const bad of [{}, { amount_usdc: 0 }, { amount_usdc: -5 }, { amount_usdc: "lots" }]) {
    assert.equal((await h.api("POST", "/api/simulate-deposit", bad)).status, 400);
  }
});

// ---------- the page ----------

test("the dashboard page is served without a token and contains no secret", async () => {
  const h = harness();
  const r = await h.api("GET", "/dashboard", undefined, null);
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  for (const secret of [SECRET, TOKEN, PIN, "conv-token-abc"]) assert.ok(!r.text.includes(secret));
  assert.doesNotMatch(r.text, /0x[0-9a-fA-F]{40}/);
});

test("the dashboard page loads the ElevenLabs client from a pinned version", async () => {
  const h = harness();
  const r = await h.api("GET", "/dashboard", undefined, null);
  assert.match(r.text, /cdn\.jsdelivr\.net\/npm\/@elevenlabs\/client@\d+\.\d+\.\d+\//);
});

test("the dashboard page sends its token in a header, never in a URL", async () => {
  const h = harness();
  const r = await h.api("GET", "/dashboard", undefined, null);
  assert.match(r.text, /Authorization/);
  assert.doesNotMatch(r.text, /[?&]token=/);
});

test("ending a browser call frees a waiting sweep so the next call can pick it up", async () => {
  const h = harness({}, { balance: 60 * U });
  await h.deposit(200 * U);
  await h.api("POST", "/api/call/bind", { conversation_id: "web-1" });
  assert.equal(h.ledger.pendingSweep()?.call_live, 1);
  const ended = await h.api("POST", "/api/call/end", { conversation_id: "web-1" });
  assert.equal(ended.status, 200);
  assert.equal(h.ledger.pendingSweep()?.call_live, 0);
  assert.equal(h.ledger.pendingSweep()?.status, "pending");
  assert.equal((await h.api("POST", "/api/call/end", {}, null)).status, 401);
});

// ---------- the ElevenLabs token provider ----------

import { createTokenProvider } from "../src/dashboard/token.ts";

test("the token provider asks ElevenLabs for a conversation token for this agent, with the API key in a header", async () => {
  const seen: { url: string; key: string | undefined }[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), key: (init?.headers as Record<string, string>)["xi-api-key"] });
    return new Response(JSON.stringify({ token: "tok_123" }), { status: 200 });
  }) as typeof fetch;
  const token = await createTokenProvider({ apiKey: "key-for-tests", agentId: "agent_1", fetch: fake })();
  assert.equal(token, "tok_123");
  assert.deepEqual(seen, [{ url: "https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent_1", key: "key-for-tests" }]);
});

test("the token provider throws on an error status or a missing token, without echoing the response body", async () => {
  const status = (async () => new Response("secret detail", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(createTokenProvider({ apiKey: "k", agentId: "a", fetch: status })(), (e: Error) => /401/.test(e.message) && !/secret detail/.test(e.message));
  const empty = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(createTokenProvider({ apiKey: "k", agentId: "a", fetch: empty })(), /no token/);
});

// ---------- sounds ----------

test("the three sound files are served as audio without the token", async () => {
  const { api } = harness();
  for (const name of ["intro", "confirm", "blocked"]) {
    const r = await api("GET", `/dashboard/sounds/${name}.mp3`, undefined, null);
    assert.equal(r.status, 200, name);
    assert.equal(r.type, "audio/mpeg");
  }
});

test("only those three sounds can be fetched; nothing else on disk is reachable", async () => {
  const { api } = harness();
  for (const path of ["/dashboard/sounds/other.mp3", "/dashboard/sounds/..%2F..%2Fpackage.json", "/dashboard/sounds/intro.wav", "/dashboard/sounds/%2e%2e%2fpage.html"]) {
    assert.equal((await api("GET", path, undefined, null)).status, 404, path);
  }
});

test("the sound logic is served to the page as a JavaScript module", async () => {
  const { api } = harness();
  const r = await api("GET", "/dashboard/sounds.js", undefined, null);
  assert.equal(r.status, 200);
  assert.match(r.type, /javascript/);
  assert.match(r.text, /export function soundsFor/);
});

test("each ledger row caused by a deposit says what detected it: the QuickNode Stream or the RPC poller", async () => {
  const { api, engine, wallet, clock } = harness({}, { balance: 60 * U });
  wallet.credit(200 * U);
  await engine.handleDeposit({ tx_hash: "0xstream1", log_index: 4, from_addr: "0xfeed", amount: 200 * U, block_number: 7, via: "stream", now: clock.t });
  wallet.credit(5 * U);
  await engine.handleDeposit({ tx_hash: "0xpoll1", log_index: 0, from_addr: "0xfeed", amount: 5 * U, block_number: 8, via: "poller", now: clock.t });
  const { json } = await api("GET", "/api/state");
  const bySource = Object.fromEntries(json.ledger.filter((e: any) => e.detected_by).map((e: any) => [e.detected_by, true]));
  assert.ok(bySource.stream, "a row detected by the Stream");
  assert.ok(bySource.poller, "a row detected by the poller");
  const send = json.ledger.find((e: any) => e.kind === "send" && e.to_label === "alice");
  assert.equal(send, undefined);
});

test("rows not caused by a deposit carry no detection source", async () => {
  const { api, engine } = harness();
  await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice", conversationId: "c1" });
  const { json } = await api("GET", "/api/state");
  assert.equal(json.ledger[0].detected_by, null);
});
