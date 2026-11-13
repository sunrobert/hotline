import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import { setup, U, ALICE, PIN } from "./helpers.ts";

const SECRET = "tool-secret-for-tests";
const OWNER = "+15125550147";
const AGENT = "+17375550100";

function harness(opts: { outbound?: string[] } = {}) {
  const ctx = setup();
  const outbound = new Set(opts.outbound ?? []);
  const app = createApp({
    engine: ctx.engine,
    cfg: { secret: SECRET, ownerNumbers: [OWNER], dashboardToken: "dash-token-for-tests" },
    isOutbound: (id) => outbound.has(id),
  });
  const call = async (tool: string, body: Record<string, unknown>, headers: Record<string, string> = { "x-hotline-secret": SECRET }) => {
    const res = await app.request(`/tools/${tool}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  // An inbound call: the owner dialled the agent's number.
  const inbound = (extra: Record<string, unknown> = {}) => ({ caller_id: OWNER, called_number: AGENT, conversation_id: "in-1", ...extra });
  return { ...ctx, app, call, inbound };
}

test("health answers without a secret", async () => {
  const { app } = harness();
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("a tool call without the shared secret is rejected before anything runs", async () => {
  const { call, inbound, ledger } = harness();
  const missing = await call("propose_action", inbound({ to_label: "alice", amount_usdc: 5 }), {});
  const wrong = await call("propose_action", inbound({ to_label: "alice", amount_usdc: 5 }), { "x-hotline-secret": "nope" });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(ledger.recent(10).length, 0);
});

test("a caller who is not the owner is refused and nothing is logged as an action", async () => {
  const { call, wallet, ledger } = harness();
  const r = await call("propose_action", { caller_id: "+19995550000", called_number: AGENT, conversation_id: "x", to_label: "alice", amount_usdc: 5 });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "not_owner");
  assert.equal(wallet.sends.length, 0);
  assert.equal(ledger.recent(10).length, 0);
});

test("the owner calling in can propose, and the caller and conversation are recorded", async () => {
  const { call, inbound, ledger, wallet } = harness();
  const r = await call("propose_action", inbound({ to_label: "alice", amount_usdc: 5 }));
  assert.equal(r.status, 200);
  assert.equal(r.json.decision, "AUTO");
  assert.deepEqual(wallet.sends.map((s) => [s.to, s.amount]), [[ALICE, 5 * U]]);
  const row = ledger.get(r.json.action_code);
  assert.equal(row?.caller_id, OWNER);
  assert.equal(row?.conversation_id, "in-1");
  assert.equal(row?.source, "voice");
});

test("the owner's number is recognized however the carrier formats it", async () => {
  const { call } = harness();
  const r = await call("get_status", { caller_id: "1 (512) 555-0147", called_number: AGENT, conversation_id: "in-1" });
  assert.equal(r.status, 200);
});

test("on an outbound call the owner is the called party, and that passes the gate", async () => {
  const { call } = harness();
  const r = await call("get_status", { caller_id: AGENT, called_number: OWNER, conversation_id: "out-1" });
  assert.equal(r.status, 200);
});

test("a conversation the backend itself placed passes the gate even without numbers", async () => {
  const { call } = harness({ outbound: ["out-9"] });
  assert.equal((await call("get_status", { conversation_id: "out-9" })).status, 200);
  assert.equal((await call("get_status", { conversation_id: "out-unknown" })).status, 403);
});

test("a tool call with no conversation id is a bad request", async () => {
  const { call } = harness();
  const r = await call("get_status", { caller_id: OWNER, called_number: AGENT });
  assert.equal(r.status, 400);
});

test("a body that is not JSON is a bad request", async () => {
  const { app } = harness();
  const res = await app.request("/tools/get_status", { method: "POST", headers: { "x-hotline-secret": SECRET, "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
});

test("amounts arriving as strings from the model are read as numbers", async () => {
  const { call, inbound, wallet } = harness();
  const r = await call("propose_action", inbound({ to_label: "alice", amount_usdc: "5" }));
  assert.equal(r.json.decision, "AUTO");
  assert.equal(wallet.sends[0]?.amount, 5 * U);
});

test("a raw address in place of a label is blocked", async () => {
  const { call, inbound, wallet } = harness();
  const r = await call("propose_action", inbound({ to_label: ALICE, amount_usdc: 5 }));
  assert.equal(r.json.decision, "BLOCK");
  assert.equal(r.json.rule, "not_allowlisted");
  assert.equal(wallet.sends.length, 0);
});

test("propose then confirm with the PIN executes over the wire", async () => {
  const { call, inbound, wallet } = harness();
  const proposed = await call("propose_action", inbound({ to_label: "alice", amount_usdc: 80 }));
  assert.equal(proposed.json.decision, "CALL");
  const confirmed = await call("confirm_action", inbound({ approved: true, pin: "5 7 2 9" }));
  assert.equal(confirmed.json.ok, true);
  assert.deepEqual(wallet.sends.map((s) => s.amount), [80 * U]);
});

test("approved arriving as the string \"false\" is a no, not a yes", async () => {
  const { call, inbound, wallet, ledger } = harness();
  const proposed = await call("propose_action", inbound({ to_label: "alice", amount_usdc: 80 }));
  const r = await call("confirm_action", inbound({ approved: "false", pin: PIN }));
  assert.equal(r.json.ok, true);
  assert.equal(ledger.get(proposed.json.action_code)?.status, "cancelled");
  assert.equal(wallet.sends.length, 0);
});

test("confirm_action without an explicit approved value is refused", async () => {
  const { call, inbound, wallet } = harness();
  await call("propose_action", inbound({ to_label: "alice", amount_usdc: 80 }));
  const r = await call("confirm_action", inbound({ pin: PIN }));
  assert.equal(r.status, 400);
  assert.equal(wallet.sends.length, 0);
});

test("get_action_status reports the latest action on the call with a short hash to read out", async () => {
  const { call, inbound, engine } = harness();
  await call("propose_action", inbound({ to_label: "alice", amount_usdc: 5 }));
  await engine.idle();
  const r = await call("get_action_status", inbound());
  assert.equal(r.json.status, "complete");
  assert.match(r.json.tx_hash_short, /^0x[0-9a-f]{6}$/);
});

test("get_action_status says so when the call has no action", async () => {
  const { call, inbound } = harness();
  const r = await call("get_action_status", inbound());
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "none");
});

test("get_rules never exposes an address", async () => {
  const { call, inbound } = harness();
  const r = await call("get_rules", inbound());
  assert.equal(r.json.approval_threshold_usdc, 50);
  assert.doesNotMatch(JSON.stringify(r.json), /0x[0-9a-f]{40}/i);
});

test("pause works by voice; there is no unpause tool", async () => {
  const { call, inbound } = harness();
  assert.equal((await call("pause", inbound())).json.paused, true);
  assert.equal((await call("propose_action", inbound({ to_label: "alice", amount_usdc: 5 }))).json.rule, "paused");
  assert.equal((await call("unpause", inbound())).status, 404);
});

test("there is no tool for changing rules by voice", async () => {
  const { call, inbound } = harness();
  assert.equal((await call("set_rule", inbound({ per_tx_cap_usdc: 99999 }))).status, 404);
});

// ---------- conversation-initiation hook ----------

const initHook = async (h: ReturnType<typeof harness>, body: Record<string, unknown>, secret: string | null = SECRET) => {
  const res = await h.app.request("/hooks/conversation-init", {
    method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-hotline-secret": secret } : {}) }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

test("the call-start hook needs the shared secret", async () => {
  const h = harness();
  assert.equal((await initHook(h, { caller_id: OWNER, conversation_id: "in-1" }, null)).status, 401);
});

test("the call-start hook returns every variable the agent's prompt uses", async () => {
  const h = harness();
  const r = await initHook(h, { caller_id: OWNER, called_number: AGENT, conversation_id: "in-1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.type, "conversation_initiation_client_data");
  assert.match(r.json.dynamic_variables.call_context, /owner called/i);
  assert.ok(r.json.dynamic_variables.opening_line);
});

test("the call-start hook tells the agent about a waiting sweep and binds it to the call", async () => {
  const h = harness();
  h.wallet.balanceMicros = 60 * U;
  await h.deposit(200 * U);
  const code = h.ledger.pendingSweep()!.code;
  const r = await initHook(h, { caller_id: OWNER, called_number: AGENT, conversation_id: "in-5" });
  assert.match(r.json.dynamic_variables.call_context, /159 USDC/);
  assert.match(r.json.dynamic_variables.call_context, /savings/);
  assert.equal(h.ledger.get(code)?.conversation_id, "in-5");
});

test("the call-start hook tells the agent to refuse a caller who is not the owner, and binds nothing", async () => {
  const h = harness();
  h.wallet.balanceMicros = 60 * U;
  await h.deposit(200 * U);
  const r = await initHook(h, { caller_id: "+19995550000", called_number: AGENT, conversation_id: "in-6" });
  assert.equal(r.status, 200);
  assert.match(r.json.dynamic_variables.call_context, /not the owner/i);
  assert.doesNotMatch(r.json.dynamic_variables.call_context, /159/);
  assert.equal(h.ledger.pendingSweep()?.conversation_id, null);
});
