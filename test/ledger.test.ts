import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.ts";
import type { NewAction } from "../src/ledger.ts";

const U = 1_000_000;
const T0 = Date.UTC(2026, 10, 13, 15, 0);

const draft = (over: Partial<NewAction> = {}): NewAction => ({
  now: T0, source: "voice", origin: "request", kind: "send", to_label: "alice",
  to_addr: "0x00000000000000000000000000000000000a11ce", amount: 5 * U,
  decision: "AUTO", rule: "auto", status: "approved", ...over,
});

test("insert assigns a short speakable code and returns the stored row", () => {
  const ledger = new Ledger(":memory:");
  const row = ledger.insert(draft());
  assert.match(row.code, /^H-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(row.amount, 5 * U);
  assert.equal(row.status, "approved");
  assert.deepEqual(ledger.get(row.code), row);
});

test("codes are unique across many inserts", () => {
  const ledger = new Ledger(":memory:");
  const codes = new Set(Array.from({ length: 300 }, () => ledger.insert(draft()).code));
  assert.equal(codes.size, 300);
});

test("update patches fields and bumps updated_at", () => {
  const ledger = new Ledger(":memory:");
  const row = ledger.insert(draft());
  const after = ledger.update(row.code, { status: "submitted", tx_hash: "0xabc", submitted_at: T0 + 5 }, T0 + 5);
  assert.equal(after.status, "submitted");
  assert.equal(after.tx_hash, "0xabc");
  assert.equal(after.updated_at, T0 + 5);
  assert.equal(after.created_at, T0);
});

test("spentSince counts only submitted and complete outflows after the boundary", () => {
  const ledger = new Ledger(":memory:");
  ledger.insert(draft({ amount: 10 * U, status: "submitted", submitted_at: T0 }));
  ledger.insert(draft({ amount: 20 * U, status: "complete", submitted_at: T0 + 1 }));
  ledger.insert(draft({ amount: 40 * U, status: "complete", submitted_at: T0 - 86_400_000 })); // yesterday
  ledger.insert(draft({ amount: 80 * U, status: "pending", decision: "CALL" }));
  ledger.insert(draft({ amount: 160 * U, status: "failed", submitted_at: T0 }));
  ledger.insert(draft({ amount: 320 * U, status: "blocked", decision: "BLOCK" }));
  assert.equal(ledger.spentSince(T0 - 1000), 30 * U);
});

test("committed sums pending, approved, and submitted outflows, optionally excluding one action", () => {
  const ledger = new Ledger(":memory:");
  const pending = ledger.insert(draft({ amount: 159 * U, status: "pending", decision: "CALL" }));
  ledger.insert(draft({ amount: 5 * U, status: "approved" }));
  ledger.insert(draft({ amount: 7 * U, status: "submitted", submitted_at: T0 }));
  ledger.insert(draft({ amount: 1000 * U, status: "complete", submitted_at: T0 }));
  ledger.insert(draft({ amount: 1000 * U, status: "cancelled" }));
  assert.equal(ledger.committed(), 171 * U);
  assert.equal(ledger.committed(pending.code), 12 * U);
});

test("recordDeposit accepts a log once and reports duplicates", () => {
  const ledger = new Ledger(":memory:");
  const dep = { tx_hash: "0xdead", log_index: 0, from_addr: "0xfeed", amount: 200 * U, block_number: 42, via: "stream" as const, now: T0 };
  assert.equal(ledger.recordDeposit(dep), true);
  assert.equal(ledger.recordDeposit({ ...dep, via: "poller" }), false);
  assert.equal(ledger.recordDeposit({ ...dep, log_index: 1 }), true);
});

test("boundTo returns the action most recently bound to a conversation", () => {
  const ledger = new Ledger(":memory:");
  const first = ledger.insert(draft({ status: "pending", decision: "CALL", conversation_id: "conv-1", bound_at: T0 }));
  const second = ledger.insert(draft({ status: "pending", decision: "CALL", conversation_id: "conv-1", bound_at: T0 + 10 }));
  ledger.insert(draft({ status: "pending", decision: "CALL", conversation_id: "conv-2", bound_at: T0 + 20 }));
  assert.equal(ledger.boundTo("conv-1")?.code, second.code);
  assert.notEqual(first.code, second.code);
  assert.equal(ledger.boundTo("nobody"), undefined);
});

test("pendingSweep finds the one pending sweep-origin action", () => {
  const ledger = new Ledger(":memory:");
  ledger.insert(draft({ status: "pending", decision: "CALL" })); // a voice request, not a sweep
  assert.equal(ledger.pendingSweep(), undefined);
  const sweep = ledger.insert(draft({ status: "pending", decision: "CALL", origin: "sweep", source: "stream", to_label: "savings" }));
  assert.equal(ledger.pendingSweep()?.code, sweep.code);
});

test("byStatus and recent list rows, newest first", () => {
  const ledger = new Ledger(":memory:");
  const a = ledger.insert(draft({ now: T0, status: "submitted", submitted_at: T0 }));
  const b = ledger.insert(draft({ now: T0 + 1, status: "pending", decision: "CALL" }));
  const c = ledger.insert(draft({ now: T0 + 2, status: "submitted", submitted_at: T0 + 2 }));
  assert.deepEqual(ledger.byStatus("submitted").map((r) => r.code), [c.code, a.code]);
  assert.deepEqual(ledger.recent(2).map((r) => r.code), [c.code, b.code]);
});

test("the paused flag defaults to off and persists once set", () => {
  const ledger = new Ledger(":memory:");
  assert.equal(ledger.isPaused(), false);
  ledger.setPaused(true);
  assert.equal(ledger.isPaused(), true);
  ledger.setPaused(false);
  assert.equal(ledger.isPaused(), false);
});
