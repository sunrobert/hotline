import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, U, T0, ALICE, SAVINGS, PIN } from "./helpers.ts";

// ---------- propose ----------

test("a small send is AUTO: it is broadcast at once and completes after the receipt", async () => {
  const { engine, wallet, ledger } = setup();
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice", conversationId: "c1" });
  assert.equal(r.decision, "AUTO");
  assert.equal(r.status, "submitted");
  assert.deepEqual(wallet.sends.map((s) => [s.to, s.amount]), [[ALICE, 5 * U]]);
  await engine.idle();
  assert.equal(ledger.get(r.action_code)?.status, "complete");
});

test("an over-threshold send is CALL: it waits as pending and nothing is sent", async () => {
  const { engine, wallet, ledger } = setup();
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "c1" });
  assert.equal(r.decision, "CALL");
  assert.equal(r.status, "pending");
  assert.equal(wallet.sends.length, 0);
  assert.equal(ledger.get(r.action_code)?.conversation_id, "c1");
});

test("an over-cap send is BLOCK: it is logged as blocked with the rule and nothing is sent", async () => {
  const { engine, wallet, ledger } = setup({ balance: 5000 * U });
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 300, source: "voice", conversationId: "c1" });
  assert.equal(r.decision, "BLOCK");
  assert.equal(r.rule, "per_tx_cap");
  assert.equal(ledger.get(r.action_code)?.status, "blocked");
  assert.equal(wallet.sends.length, 0);
});

test("a nonsense amount is BLOCKED as invalid instead of throwing", async () => {
  const { engine } = setup();
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: Number.NaN, source: "voice" });
  assert.equal(r.decision, "BLOCK");
  assert.equal(r.rule, "invalid_amount");
});

test("a spoken alias resolves to its allowlist label", async () => {
  const { engine, wallet } = setup();
  const r = await engine.propose({ kind: "send", toLabel: "爱丽丝", amountUsdc: 5, source: "voice" });
  assert.equal(r.decision, "AUTO");
  assert.equal(r.to_label, "alice");
  assert.equal(wallet.sends[0]?.to, ALICE);
});

test("if the broadcast fails, the action is marked failed and says so", async () => {
  const { engine, wallet, ledger } = setup();
  wallet.failNextSend = "rpc unreachable";
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice" });
  assert.equal(r.status, "failed");
  assert.match(ledger.get(r.action_code)?.error ?? "", /rpc unreachable/);
});

test("if the transaction reverts, the action ends failed, not complete", async () => {
  const { engine, wallet, ledger } = setup();
  wallet.failNextReceipt = "reverted";
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice" });
  await engine.idle();
  const row = ledger.get(r.action_code);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "reverted");
});

test("the daily cap counts what has already gone out today", async () => {
  const { engine } = setup({ cfg: { dailyCap: 12 * U } });
  const send = () => engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice" });
  assert.equal((await send()).decision, "AUTO");
  await engine.idle();
  assert.equal((await send()).decision, "AUTO");
  await engine.idle();
  const third = await send();
  assert.equal(third.decision, "BLOCK");
  assert.equal(third.rule, "daily_cap");
});

test("money promised to a pending action cannot be spent by another one", async () => {
  const { engine } = setup({ balance: 100 * U });
  await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "c1" });
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 30, source: "voice", conversationId: "c2" });
  assert.equal(r.decision, "BLOCK");
  assert.equal(r.rule, "gas_reserve");
});

test("a counter-proposal in the same conversation supersedes the earlier pending action", async () => {
  const { engine, ledger, wallet } = setup();
  const first = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "c1" });
  const second = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 60, source: "voice", conversationId: "c1" });
  assert.equal(ledger.get(first.action_code)?.status, "cancelled");
  assert.equal(ledger.get(first.action_code)?.reason, "superseded");
  await engine.confirm({ conversationId: "c1", approved: true, pin: PIN });
  assert.deepEqual(wallet.sends.map((s) => s.amount), [60 * U]);
  await engine.idle();
  assert.equal(ledger.get(second.action_code)?.status, "complete");
});

test("a CALL-tier request by text asks for a phone call; one made by voice does not", async () => {
  const { engine, calls } = setup();
  await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "c1" });
  assert.equal(calls.length, 0);
  const byText = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 70, source: "text" });
  assert.deepEqual(calls.map((c) => c.code), [byText.action_code]);
});

// ---------- confirm ----------

const pendingEighty = async () => {
  const ctx = setup();
  const proposed = await ctx.engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "c1" });
  return { ...ctx, code: proposed.action_code };
};

test("a yes with the right PIN executes the pending action", async () => {
  const { engine, wallet, ledger, code } = await pendingEighty();
  const r = await engine.confirm({ conversationId: "c1", approved: true, pin: PIN });
  assert.equal(r.ok, true);
  assert.equal(r.status, "submitted");
  assert.deepEqual(wallet.sends.map((s) => [s.to, s.amount]), [[ALICE, 80 * U]]);
  await engine.idle();
  assert.equal(ledger.get(code)?.status, "complete");
});

test("the PIN is matched on digits only, however it was transcribed", async () => {
  const { engine, wallet } = await pendingEighty();
  const r = await engine.confirm({ conversationId: "c1", approved: true, pin: " 5-7 2, 9." });
  assert.equal(r.ok, true);
  assert.equal(wallet.sends.length, 1);
});

test("a yes without a PIN is refused and does not use up an attempt", async () => {
  const { engine, wallet, ledger, code } = await pendingEighty();
  const r = await engine.confirm({ conversationId: "c1", approved: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, "pin_required");
  assert.equal(ledger.get(code)?.pin_attempts, 0);
  assert.equal(wallet.sends.length, 0);
});

test("a wrong PIN gets one retry, then the action is cancelled", async () => {
  const { engine, wallet, ledger, code } = await pendingEighty();
  const first = await engine.confirm({ conversationId: "c1", approved: true, pin: "0000" });
  assert.equal(first.error, "bad_pin");
  assert.equal(first.retry, true);
  assert.equal(ledger.get(code)?.status, "pending");
  const second = await engine.confirm({ conversationId: "c1", approved: true, pin: "1111" });
  assert.equal(second.error, "bad_pin");
  assert.equal(second.retry, false);
  assert.equal(ledger.get(code)?.status, "cancelled");
  assert.equal(ledger.get(code)?.reason, "bad_pin");
  assert.equal(wallet.sends.length, 0);
});

test("a right PIN on the retry still works", async () => {
  const { engine, wallet } = await pendingEighty();
  await engine.confirm({ conversationId: "c1", approved: true, pin: "0000" });
  const r = await engine.confirm({ conversationId: "c1", approved: true, pin: PIN });
  assert.equal(r.ok, true);
  assert.equal(wallet.sends.length, 1);
});

test("a no cancels the action as declined and sends nothing", async () => {
  const { engine, wallet, ledger, code } = await pendingEighty();
  const r = await engine.confirm({ conversationId: "c1", approved: false });
  assert.equal(r.ok, true);
  assert.equal(ledger.get(code)?.status, "cancelled");
  assert.equal(ledger.get(code)?.reason, "declined");
  assert.equal(wallet.sends.length, 0);
});

test("confirming twice is idempotent: one transaction, same answer", async () => {
  const { engine, wallet } = await pendingEighty();
  const first = await engine.confirm({ conversationId: "c1", approved: true, pin: PIN });
  const again = await engine.confirm({ conversationId: "c1", approved: true, pin: PIN });
  assert.equal(wallet.sends.length, 1);
  assert.equal(again.ok, true);
  assert.equal(again.repeat, true);
  assert.equal(again.action_code, first.action_code);
});

test("changing the answer after the fact is an error, not a second action", async () => {
  const { engine, wallet } = await pendingEighty();
  await engine.confirm({ conversationId: "c1", approved: true, pin: PIN });
  const flip = await engine.confirm({ conversationId: "c1", approved: false });
  assert.equal(flip.ok, false);
  assert.equal(flip.error, "already_decided");
  assert.equal(wallet.sends.length, 1);
});

test("confirming in a conversation with nothing pending is an error", async () => {
  const { engine } = setup();
  const r = await engine.confirm({ conversationId: "nobody", approved: true, pin: PIN });
  assert.equal(r.ok, false);
  assert.equal(r.error, "nothing_pending");
});

test("a yes cannot execute an action that belongs to a different conversation", async () => {
  const { engine, wallet } = await pendingEighty();
  const r = await engine.confirm({ conversationId: "c2", approved: true, pin: PIN });
  assert.equal(r.error, "nothing_pending");
  assert.equal(wallet.sends.length, 0);
});

test("the policy is re-checked at confirm time: pausing after the ask stops the send", async () => {
  const { engine, wallet, ledger, code } = await pendingEighty();
  engine.pause();
  const r = await engine.confirm({ conversationId: "c1", approved: true, pin: PIN });
  assert.equal(r.ok, false);
  assert.equal(r.error, "blocked");
  assert.equal(r.rule, "paused");
  assert.equal(ledger.get(code)?.status, "cancelled");
  assert.equal(wallet.sends.length, 0);
});

test("an unanswered pending action expires after ten minutes and can no longer be confirmed", async () => {
  const { engine, wallet, ledger, clock, code } = await pendingEighty();
  clock.t += 9 * 60_000;
  assert.equal(engine.expireStale(), 0);
  clock.t += 2 * 60_000;
  assert.equal(engine.expireStale(), 1);
  assert.equal(ledger.get(code)?.status, "expired");
  const r = await engine.confirm({ conversationId: "c1", approved: true, pin: PIN });
  assert.equal(r.error, "expired");
  assert.equal(wallet.sends.length, 0);
});

// ---------- deposits and the sweep rule ----------

test("a deposit that lifts the balance over the threshold proposes a sweep and asks for a call", async () => {
  const { deposit, calls, ledger } = setup({ balance: 60 * U });
  const r = await deposit(200 * U);
  assert.equal(r.duplicate, false);
  const sweep = ledger.pendingSweep();
  assert.equal(sweep?.amount, 159 * U);
  assert.equal(sweep?.to_addr, SAVINGS);
  assert.equal(sweep?.decision, "CALL");
  assert.equal(sweep?.source, "stream");
  assert.deepEqual(calls.map((c) => c.code), [sweep?.code]);
});

test("the same deposit log delivered twice produces one action and one call", async () => {
  const { deposit, calls, ledger, engine, wallet } = setup({ balance: 60 * U });
  await deposit(200 * U, { tx_hash: "0xsame", via: "stream" });
  const again = await engine.handleDeposit({
    tx_hash: "0xsame", log_index: 0, from_addr: "0xfeed", amount: 200 * U, block_number: 101, via: "poller", now: T0,
  });
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal(ledger.byStatus("pending").length, 1);
  assert.equal(wallet.sends.length, 0);
});

test("a deposit that leaves the balance under the threshold is only observed", async () => {
  const { deposit, calls, ledger } = setup({ balance: 20 * U });
  const r = await deposit(30 * U);
  assert.equal(r.action?.decision, "observed");
  assert.equal(r.action?.reason, "below_threshold");
  assert.equal(calls.length, 0);
  assert.equal(ledger.pendingSweep(), undefined);
});

test("a sweep the policy would block is observed with the rule and never calls", async () => {
  const { deposit, calls, engine, ledger } = setup({ balance: 60 * U });
  engine.pause();
  const r = await deposit(200 * U);
  assert.equal(r.action?.decision, "observed");
  assert.equal(r.action?.rule, "paused");
  assert.equal(calls.length, 0);
  assert.equal(ledger.pendingSweep(), undefined);
});

test("a second deposit before the call supersedes the sweep with one for the combined excess", async () => {
  const { deposit, calls, ledger } = setup({ balance: 60 * U });
  await deposit(60 * U); // 120 on hand: sweep 19
  const first = ledger.pendingSweep()!;
  assert.equal(first.amount, 19 * U);
  await deposit(60 * U); // 180 on hand: sweep 79, not 19 + 79
  const second = ledger.pendingSweep()!;
  assert.equal(second.amount, 79 * U);
  assert.equal(ledger.get(first.code)?.reason, "superseded");
  assert.equal(ledger.byStatus("pending").length, 1);
  assert.equal(calls.length, 2);
});

test("presenting a sweep at dial time recomputes the amount, binds the call, and marks it live", async () => {
  const { deposit, engine, wallet, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  wallet.balanceMicros = 200 * U; // balance moved between the deposit and the dial
  const presented = await engine.present(code, "out-1");
  assert.equal(presented?.amount, 99 * U);
  assert.equal(presented?.conversation_id, "out-1");
  assert.equal(presented?.call_live, 1);
});

test("presenting a sweep that is no longer needed cancels it instead of dialling", async () => {
  const { deposit, engine, wallet, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  wallet.balanceMicros = 90 * U;
  assert.equal(await engine.present(code, "out-1"), null);
  assert.equal(ledger.get(code)?.status, "cancelled");
  assert.equal(ledger.get(code)?.reason, "no_longer_needed");
});

test("a deposit during a live approval call is observed and leaves the pending sweep alone", async () => {
  const { deposit, engine, calls, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  await engine.present(code, "out-1");
  const r = await deposit(100 * U);
  assert.equal(r.action?.decision, "observed");
  assert.equal(r.action?.reason, "sweep_pending");
  assert.equal(ledger.pendingSweep()?.code, code);
  assert.equal(ledger.get(code)?.amount, 159 * U);
  assert.equal(calls.length, 1);
});

test("a yes never sends more than the amount the owner heard; the remainder gets its own call", async () => {
  const { deposit, engine, wallet, calls, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  await engine.present(code, "out-1");
  await deposit(100 * U); // arrives mid-call; excess is now 259
  const r = await engine.confirm({ conversationId: "out-1", approved: true, pin: PIN });
  assert.equal(r.ok, true);
  assert.deepEqual(wallet.sends.map((s) => [s.to, s.amount]), [[SAVINGS, 159 * U]]);
  await engine.idle();
  const next = ledger.pendingSweep();
  assert.equal(next?.amount, 100 * U);
  assert.equal(calls.length, 2);
  // total swept once the second call is approved = 259 = the combined excess, nothing double-counted
});

test("a yes sends less than the owner heard if the balance dropped in the meantime", async () => {
  const { deposit, engine, wallet, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  await engine.present(code, "out-1");
  wallet.balanceMicros = 150 * U;
  await engine.confirm({ conversationId: "out-1", approved: true, pin: PIN });
  assert.deepEqual(wallet.sends.map((s) => s.amount), [49 * U]);
  assert.equal(ledger.get(code)?.amount, 49 * U);
});

test("a queued sweep and an inbound request are independent: each yes executes its own action", async () => {
  const { deposit, engine, wallet, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const sweep = ledger.pendingSweep()!;
  await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "in-1" });
  await engine.confirm({ conversationId: "in-1", approved: true, pin: PIN });
  assert.deepEqual(wallet.sends.map((s) => [s.to, s.amount]), [[ALICE, 80 * U]]);
  assert.equal(ledger.get(sweep.code)?.status, "pending");
});

test("when a call ends the action is no longer live; giving up marks it expired_no_answer", async () => {
  const { deposit, engine, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  await engine.present(code, "out-1");
  engine.callEnded("out-1");
  assert.equal(ledger.get(code)?.call_live, 0);
  assert.equal(ledger.get(code)?.status, "pending");
  engine.noAnswer(code);
  assert.equal(ledger.get(code)?.status, "expired_no_answer");
});

// ---------- pause, status, recovery ----------

test("pause blocks new proposals until unpaused", async () => {
  const { engine } = setup();
  engine.pause();
  const blocked = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice" });
  assert.equal(blocked.rule, "paused");
  engine.unpause();
  const ok = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice" });
  assert.equal(ok.decision, "AUTO");
});

test("status reports the balance, the pause flag, pending actions, and recent history in USDC", async () => {
  const { engine } = setup();
  await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 5, source: "voice", conversationId: "c1" });
  await engine.idle();
  const pending = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "c1" });
  const s = await engine.status();
  assert.equal(s.balance_usdc, 255);
  assert.equal(s.paused, false);
  assert.deepEqual(s.pending_actions.map((a) => [a.action_code, a.amount_usdc]), [[pending.action_code, 80]]);
  assert.equal(s.recent.length, 2);
});

test("rules lists limits in USDC and recipients by label, never by address", () => {
  const { engine } = setup();
  const rules = engine.rules();
  assert.equal(rules.per_tx_cap_usdc, 250);
  assert.equal(rules.approval_threshold_usdc, 50);
  assert.deepEqual(rules.recipients.map((r) => r.label).sort(), ["alice", "savings"]);
  assert.doesNotMatch(JSON.stringify(rules), /0x[0-9a-f]{40}/i);
});

test("on boot, submitted actions are re-checked, interrupted ones fail closed, stale ones expire", async () => {
  const { engine, ledger, wallet, clock } = setup();
  const base = { source: "voice" as const, origin: "request" as const, kind: "send", to_label: "alice", to_addr: ALICE, amount: 5 * U, rule: "auto" };
  const submitted = ledger.insert({ ...base, now: T0, decision: "AUTO", status: "submitted", tx_hash: "0xaaa", submitted_at: T0 });
  const interrupted = ledger.insert({ ...base, now: T0, decision: "AUTO", status: "approved" });
  const stale = ledger.insert({ ...base, now: T0, decision: "CALL", status: "pending", amount: 80 * U });
  const live = ledger.insert({ ...base, now: T0, decision: "CALL", status: "pending", origin: "sweep", call_live: 1 });
  clock.t = T0 + 11 * 60_000;
  await engine.recover();
  assert.equal(ledger.get(submitted.code)?.status, "complete");
  assert.equal(ledger.get(interrupted.code)?.status, "failed");
  assert.match(ledger.get(interrupted.code)?.error ?? "", /not sent/);
  assert.equal(ledger.get(stale.code)?.status, "expired");
  assert.equal(ledger.get(live.code)?.call_live, 0);
  assert.equal(wallet.sends.length, 0); // recovery never re-sends anything
});

// ---------- inbound calls picking up a waiting sweep ----------

test("an inbound call picks up a waiting sweep, so a yes on that call executes it", async () => {
  const { deposit, engine, wallet, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  const offered = await engine.offerPendingTo("in-7");
  assert.equal(offered?.action_code, code);
  assert.equal(offered?.amount_usdc, 159);
  const r = await engine.confirm({ conversationId: "in-7", approved: true, pin: PIN });
  assert.equal(r.ok, true);
  assert.deepEqual(wallet.sends.map((s) => [s.to, s.amount]), [[SAVINGS, 159 * U]]);
});

test("an inbound call is offered nothing when no sweep is waiting or one is already on a live call", async () => {
  const { deposit, engine, ledger } = setup({ balance: 60 * U });
  assert.equal(await engine.offerPendingTo("in-1"), null);
  await deposit(200 * U);
  await engine.present(ledger.pendingSweep()!.code, "out-1");
  assert.equal(await engine.offerPendingTo("in-2"), null);
  assert.equal(ledger.pendingSweep()?.conversation_id, "out-1");
});

// ---------- preparing and binding an outbound call ----------

test("prepareCall recomputes a sweep without binding it to any conversation", async () => {
  const { deposit, engine, wallet, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  wallet.balanceMicros = 200 * U;
  const row = await engine.prepareCall(code);
  assert.equal(row?.amount, 99 * U);
  assert.equal(row?.conversation_id, null);
  assert.equal(row?.call_live, 0);
});

test("prepareCall returns null for an action that is not waiting, and cancels a sweep that is no longer needed", async () => {
  const { deposit, engine, wallet, ledger } = setup({ balance: 60 * U });
  assert.equal(await engine.prepareCall("H-NOPE"), null);
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  wallet.balanceMicros = 90 * U;
  assert.equal(await engine.prepareCall(code), null);
  assert.equal(ledger.get(code)?.reason, "no_longer_needed");
});

test("bindCall ties the action to the conversation and marks it live without touching the amount", async () => {
  const { deposit, engine, wallet, ledger } = setup({ balance: 60 * U });
  await deposit(200 * U);
  const code = ledger.pendingSweep()!.code;
  wallet.balanceMicros = 500 * U; // would recompute to a larger amount; binding must not
  engine.bindCall(code, "out-3");
  const row = ledger.get(code)!;
  assert.equal(row.amount, 159 * U);
  assert.equal(row.conversation_id, "out-3");
  assert.equal(row.call_live, 1);
});

test("statusOf reports an action's lifecycle status by code", async () => {
  const { engine } = setup();
  const r = await engine.propose({ kind: "send", toLabel: "alice", amountUsdc: 80, source: "voice", conversationId: "c1" });
  assert.equal(engine.statusOf(r.action_code), "pending");
  assert.equal(engine.statusOf("H-NOPE"), undefined);
});
