// The ledger: every decision Hotline makes, the rule that fired, and what happened next.
// SQLite via node:sqlite. Synchronous on purpose: one process, one writer, no races
// between reading state and writing the decision made from it.

import { DatabaseSync } from "node:sqlite";
import { randomInt } from "node:crypto";
import type { Source, Rule } from "./policy.ts";

/**
 * Lifecycle only. `decision` records what the policy said; `status` records where the action is.
 *   pending  -> approved | cancelled | expired | expired_no_answer
 *   approved -> submitted -> complete | failed
 * AUTO actions start at approved. BLOCK rows are `blocked`; deposits that need nothing are `observed`.
 */
export type Status =
  | "pending" | "approved" | "submitted" | "complete" | "failed"
  | "cancelled" | "expired" | "expired_no_answer" | "blocked" | "observed";

export type LedgerDecision = "AUTO" | "CALL" | "BLOCK" | "observed";

export interface ActionRow {
  code: string;
  created_at: number;
  updated_at: number;
  source: Source;
  /** `sweep` actions are created by the standing rule, not asked for by a person. */
  origin: "request" | "sweep";
  caller_id: string | null;
  /** The conversation this action was last proposed or presented in. Confirmation binds to this. */
  conversation_id: string | null;
  bound_at: number | null;
  kind: string;
  to_label: string | null;
  to_addr: string | null;
  amount: number;
  decision: LedgerDecision;
  rule: Rule | string;
  status: Status;
  /** Why it was cancelled, blocked, or observed, in a word. */
  reason: string | null;
  error: string | null;
  tx_hash: string | null;
  submitted_at: number | null;
  deposit_tx: string | null;
  deposit_log_index: number | null;
  pin_attempts: number;
  /** 1 while an outbound approval call for this action is in progress. */
  call_live: number;
  transcript_snippet: string | null;
}

export type NewAction = { now: number }
  & Pick<ActionRow, "source" | "origin" | "kind" | "amount" | "decision" | "rule" | "status">
  & Partial<Omit<ActionRow, "code" | "created_at" | "updated_at">>;

export interface Deposit {
  tx_hash: string;
  log_index: number;
  from_addr: string;
  amount: number;
  block_number: number;
  via: "stream" | "poller" | "simulated";
  now: number;
}

const COLUMNS = [
  "code", "created_at", "updated_at", "source", "origin", "caller_id", "conversation_id", "bound_at",
  "kind", "to_label", "to_addr", "amount", "decision", "rule", "status", "reason", "error",
  "tx_hash", "submitted_at", "deposit_tx", "deposit_log_index", "pin_attempts", "call_live", "transcript_snippet",
] as const;
const COLUMN_SET: ReadonlySet<string> = new Set(COLUMNS);

// No 0/O or 1/I: codes get read aloud and typed from a phone.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = (): string =>
  "H-" + Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  origin TEXT NOT NULL,
  caller_id TEXT,
  conversation_id TEXT,
  bound_at INTEGER,
  kind TEXT NOT NULL,
  to_label TEXT,
  to_addr TEXT,
  amount INTEGER NOT NULL,
  decision TEXT NOT NULL,
  rule TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  error TEXT,
  tx_hash TEXT,
  submitted_at INTEGER,
  deposit_tx TEXT,
  deposit_log_index INTEGER,
  pin_attempts INTEGER NOT NULL DEFAULT 0,
  call_live INTEGER NOT NULL DEFAULT 0,
  transcript_snippet TEXT
);
CREATE INDEX IF NOT EXISTS actions_status ON actions (status);
CREATE INDEX IF NOT EXISTS actions_conversation ON actions (conversation_id);
CREATE TABLE IF NOT EXISTS deposits (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  from_addr TEXT NOT NULL,
  amount INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  via TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const SELECT = `SELECT ${COLUMNS.join(", ")} FROM actions`;

export class Ledger {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  insert(draft: NewAction): ActionRow {
    const { now, ...fields } = draft;
    const row: ActionRow = {
      caller_id: null, conversation_id: null, bound_at: null, to_label: null, to_addr: null,
      reason: null, error: null, tx_hash: null, submitted_at: null, deposit_tx: null,
      deposit_log_index: null, pin_attempts: 0, call_live: 0, transcript_snippet: null,
      ...fields,
      code: "", created_at: now, updated_at: now,
    };
    const stmt = this.#db.prepare(
      `INSERT INTO actions (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
    );
    for (let attempt = 0; ; attempt++) {
      row.code = newCode();
      try {
        stmt.run(...COLUMNS.map((c) => row[c]));
        return row;
      } catch (err) {
        const collision = err instanceof Error && /UNIQUE constraint failed: actions\.code/.test(err.message);
        if (!collision || attempt >= 20) throw err;
      }
    }
  }

  get(code: string): ActionRow | undefined {
    return this.#one(`${SELECT} WHERE code = ?`, code);
  }

  update(code: string, patch: Partial<Omit<ActionRow, "code" | "created_at">>, now: number): ActionRow {
    const entries = Object.entries({ ...patch, updated_at: now }).filter(([k]) => COLUMN_SET.has(k));
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    const result = this.#db.prepare(`UPDATE actions SET ${sets} WHERE code = ?`)
      .run(...entries.map(([, v]) => v as string | number | null), code);
    if (result.changes !== 1) throw new Error(`no such action: ${code}`);
    return this.get(code)!;
  }

  /** Outflows that have left or are leaving the wallet since `ts`. Feeds the daily cap. */
  spentSince(ts: number): number {
    return this.#sum(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM actions
       WHERE status IN ('submitted', 'complete') AND submitted_at >= ?`, ts);
  }

  /** Outflows promised but possibly not yet off the balance. Subtracted to get what is free to move. */
  committed(excludeCode?: string): number {
    return this.#sum(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM actions
       WHERE status IN ('pending', 'approved', 'submitted') AND code != ?`, excludeCode ?? "");
  }

  /** True if this log is new. At-least-once delivery from two sources makes duplicates normal. */
  recordDeposit(d: Deposit): boolean {
    const result = this.#db.prepare(
      `INSERT OR IGNORE INTO deposits (tx_hash, log_index, from_addr, amount, block_number, via, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(d.tx_hash, d.log_index, d.from_addr, d.amount, d.block_number, d.via, d.now);
    return result.changes === 1;
  }

  boundTo(conversationId: string): ActionRow | undefined {
    return this.#one(`${SELECT} WHERE conversation_id = ? ORDER BY bound_at DESC, seq DESC LIMIT 1`, conversationId);
  }

  pendingSweep(): ActionRow | undefined {
    return this.#one(`${SELECT} WHERE status = 'pending' AND origin = 'sweep' ORDER BY seq DESC LIMIT 1`);
  }

  byStatus(status: Status): ActionRow[] {
    return this.#all(`${SELECT} WHERE status = ? ORDER BY seq DESC`, status);
  }

  recent(limit: number): ActionRow[] {
    return this.#all(`${SELECT} ORDER BY seq DESC LIMIT ?`, limit);
  }

  isPaused(): boolean {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'paused'").get() as { value: string } | undefined;
    return row?.value === "1";
  }

  setPaused(paused: boolean): void {
    this.#db.prepare(
      "INSERT INTO settings (key, value) VALUES ('paused', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(paused ? "1" : "0");
  }

  #one(sql: string, ...params: (string | number)[]): ActionRow | undefined {
    const row = this.#db.prepare(sql).get(...params);
    return row ? ({ ...row } as unknown as ActionRow) : undefined;
  }

  #all(sql: string, ...params: (string | number)[]): ActionRow[] {
    return this.#db.prepare(sql).all(...params).map((r) => ({ ...r }) as unknown as ActionRow);
  }

  #sum(sql: string, ...params: (string | number)[]): number {
    return Number((this.#db.prepare(sql).get(...params) as { total: number }).total);
  }
}

