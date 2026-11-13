// The action engine: the decision loop.
//
//   intent (voice, text, or an onchain deposit)
//     -> normalize to an action
//     -> policy: AUTO | CALL | BLOCK          (src/policy.ts)
//     -> AUTO: send now.  CALL: wait for a spoken yes + PIN.  BLOCK: log the rule, do nothing.
//     -> every path writes a ledger row       (src/ledger.ts)
//
// The engine knows nothing about phones or HTTP. It asks for a call through a hook
// and is told about conversations by id.

import { timingSafeEqual } from "node:crypto";
import type { Ledger, ActionRow, Deposit, NewAction } from "./ledger.ts";
import { decide, normalizeLabel } from "./policy.ts";
import type { PolicyConfig, PolicyState, Source } from "./policy.ts";
import { computeSweep, dailyResetBoundary } from "./sweep.ts";
import { toMicros, fromMicros, formatUsdc } from "./money.ts";

export interface Wallet {
  readonly address: string;
  /** Spendable balance in micro-USDC. */
  balance(): Promise<number>;
  /** Broadcast a USDC transfer. Resolves with the tx hash as soon as the node accepts it. */
  send(to: string, micros: number): Promise<string>;
  waitForReceipt(txHash: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface EngineConfig extends PolicyConfig {
  /** label -> other names the owner might say for it, in any language. */
  aliases?: Record<string, string[]>;
  sweepThreshold: number;
  savingsLabel: string;
  ownerPin: string;
  pendingTtlMs: number;
  dailyResetHourUtc: number;
}

export interface EngineHooks {
  /** A pending action needs the owner on the phone. The call queue picks this up. */
  needsCall?(row: ActionRow): void;
}

export interface ActionView {
  action_code: string;
  kind: string;
  to_label: string | null;
  amount_usdc: number;
  decision: string;
  rule: string;
  status: string;
  reason: string | null;
  summary: string;
  tx_hash: string | null;
}

/** One ledger row as shown on the dashboard. */
export interface LedgerEntry {
  code: string;
  /** Epoch milliseconds when the action was created. */
  time: number;
  source: string;
  kind: string;
  to_label: string | null;
  amount_usdc: number;
  decision: string;
  rule: string;
  status: string;
  reason: string | null;
  tx_hash: string | null;
  error: string | null;
}

export interface ProposeRequest {
  kind: "send";
  toLabel: string;
  amountUsdc: number;
  source: Source;
  callerId?: string;
  conversationId?: string;
}

export interface ConfirmResult extends Partial<ActionView> {
  ok: boolean;
  error?: "nothing_pending" | "expired" | "already_decided" | "pin_required" | "bad_pin" | "blocked" | "no_longer_needed";
  retry?: boolean;
  repeat?: boolean;
  message?: string;
}

export interface StatusView {
  balance_usdc: number;
  gas_reserve_usdc: number;
  paused: boolean;
  pending_actions: ActionView[];
  recent: ActionView[];
}

export interface RulesView {
  per_tx_cap_usdc: number;
  daily_cap_usdc: number;
  approval_threshold_usdc: number;
  gas_reserve_usdc: number;
  sweep_threshold_usdc: number;
  savings_label: string;
  paused: boolean;
  recipients: { label: string; aliases: string[] }[];
}

const MAX_PIN_ATTEMPTS = 2;
const digitsOnly = (s: string): string => s.replace(/\D/g, "");

function pinMatches(given: string, expected: string): boolean {
  const a = Buffer.from(digitsOnly(given));
  const b = Buffer.from(digitsOnly(expected));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function view(row: ActionRow): ActionView {
  const what = row.kind === "deposit"
    ? `Deposit of ${formatUsdc(row.amount)} USDC`
    : `Send ${formatUsdc(row.amount)} USDC to ${row.to_label ?? "?"}`;
  return {
    action_code: row.code, kind: row.kind, to_label: row.to_label, amount_usdc: fromMicros(row.amount),
    decision: row.decision, rule: row.rule, status: row.status, reason: row.reason, summary: what, tx_hash: row.tx_hash,
  };
}

export class Engine {
  readonly #ledger: Ledger;
  readonly #wallet: Wallet;
  readonly #cfg: EngineConfig;
  readonly #now: () => number;
  readonly #hooks: EngineHooks;
  readonly #aliasToLabel = new Map<string, string>();
  readonly #inFlight = new Set<Promise<void>>();

  constructor(deps: { ledger: Ledger; wallet: Wallet; cfg: EngineConfig; now?: () => number; hooks?: EngineHooks }) {
    this.#ledger = deps.ledger;
    this.#wallet = deps.wallet;
    this.#now = deps.now ?? Date.now;
    this.#hooks = deps.hooks ?? {};
    const allowlist: Record<string, string> = {};
    for (const [label, addr] of Object.entries(deps.cfg.allowlist)) allowlist[normalizeLabel(label)] = addr;
    this.#cfg = { ...deps.cfg, allowlist, savingsLabel: normalizeLabel(deps.cfg.savingsLabel) };
    for (const [label, names] of Object.entries(deps.cfg.aliases ?? {})) {
      for (const name of names) this.#aliasToLabel.set(normalizeLabel(name), normalizeLabel(label));
    }
  }

  // ---------- requests ----------

  async propose(req: ProposeRequest): Promise<ActionView & { message: string }> {
    const now = this.#now();
    const label = this.#resolveLabel(req.toLabel);
    let amount = 0;
    try { amount = toMicros(req.amountUsdc); } catch { /* left at 0: the policy reports invalid_amount */ }

    const result = decide({ amount, toLabel: label, source: req.source }, await this.#policyState(), this.#cfg);
    const draft: NewAction = {
      now, source: req.source, origin: "request", kind: req.kind,
      to_label: label, to_addr: this.#cfg.allowlist[label] ?? null, amount,
      decision: result.decision, rule: result.rule, status: "blocked",
      caller_id: req.callerId ?? null,
      conversation_id: req.conversationId ?? null, bound_at: req.conversationId ? now : null,
    };

    if (result.decision === "BLOCK") {
      const row = this.#ledger.insert({ ...draft, status: "blocked", reason: result.rule });
      return { ...view(row), message: result.reason };
    }

    if (result.decision === "CALL") {
      if (req.conversationId) this.#supersedePendingIn(req.conversationId);
      const row = this.#ledger.insert({ ...draft, status: "pending" });
      // By voice the owner is already on the line. Anything else has to ring them.
      if (req.source !== "voice") this.#hooks.needsCall?.(row);
      return { ...view(row), message: result.reason };
    }

    const row = this.#ledger.insert({ ...draft, status: "approved" });
    const after = await this.#execute(row.code);
    return { ...view(after), message: after.status === "failed" ? `It did not go through: ${after.error}` : "Sending now." };
  }

  async confirm(req: { conversationId: string; approved: boolean; pin?: string }): Promise<ConfirmResult> {
    const row = this.#ledger.boundTo(req.conversationId);
    if (!row) return { ok: false, error: "nothing_pending", message: "There is nothing waiting for a decision on this call." };

    if (row.status !== "pending") return this.#alreadyDecided(row, req.approved);

    if (!req.approved) {
      const cancelled = this.#cancel(row.code, "declined");
      return { ok: true, ...view(cancelled), message: "Cancelled. Nothing was sent." };
    }

    if (!req.pin || digitsOnly(req.pin).length === 0) {
      return { ok: false, error: "pin_required", ...view(row), message: "A yes needs the PIN." };
    }
    if (!pinMatches(req.pin, this.#cfg.ownerPin)) {
      const attempts = row.pin_attempts + 1;
      if (attempts >= MAX_PIN_ATTEMPTS) {
        const cancelled = this.#cancel(row.code, "bad_pin", { pin_attempts: attempts });
        return { ok: false, error: "bad_pin", retry: false, ...view(cancelled), message: "Wrong PIN twice. Cancelled; nothing was sent." };
      }
      const updated = this.#ledger.update(row.code, { pin_attempts: attempts }, this.#now());
      return { ok: false, error: "bad_pin", retry: true, ...view(updated), message: "That PIN did not match. One more try." };
    }

    // The world may have moved since the question was asked. Decide again on today's facts.
    let amount = row.amount;
    if (row.origin === "sweep") {
      const fresh = await this.#sweepAmount(row.code);
      if (fresh === null) {
        const cancelled = this.#cancel(row.code, "no_longer_needed");
        return { ok: false, error: "no_longer_needed", ...view(cancelled), message: "The balance changed and there is nothing left to sweep." };
      }
      // Never send more than the amount the owner heard and said yes to.
      amount = Math.min(row.amount, fresh);
    }
    const recheck = decide(
      { amount, toLabel: row.to_label ?? "", source: row.source },
      await this.#policyState(row.code), this.#cfg,
    );
    if (recheck.decision === "BLOCK") {
      const cancelled = this.#cancel(row.code, `blocked_at_confirm:${recheck.rule}`);
      return { ok: false, error: "blocked", ...view(cancelled), rule: recheck.rule, message: recheck.reason };
    }

    this.#ledger.update(row.code, { status: "approved", amount, call_live: 0 }, this.#now());
    const after = await this.#execute(row.code);
    return after.status === "failed"
      ? { ok: false, ...view(after), message: `It did not go through: ${after.error}. Nothing was sent.` }
      : { ok: true, ...view(after), message: "Approved. Sending now." };
  }

  /** The latest action tied to this conversation, for "did it go through?". */
  actionStatus(conversationId: string): ActionView | undefined {
    const row = this.#ledger.boundTo(conversationId);
    return row ? view(row) : undefined;
  }

  // ---------- calls ----------

  /**
   * Dial time, step one. Recomputes a sweep against the current balance so the amount the
   * agent reads out is current. Returns null, cancelling if need be, when there is no
   * longer anything to ask.
   */
  async prepareCall(code: string): Promise<ActionRow | null> {
    const row = this.#ledger.get(code);
    if (!row || row.status !== "pending") return null;
    if (row.origin !== "sweep") return row;
    const fresh = await this.#sweepAmount(code);
    if (fresh === null) { this.#cancel(code, "no_longer_needed"); return null; }
    return fresh === row.amount ? row : this.#ledger.update(code, { amount: fresh }, this.#now());
  }

  /**
   * Dial time, step two. Ties the action to the conversation and marks the call live.
   * Never changes the amount: what was read out is what a yes approves.
   */
  bindCall(code: string, conversationId: string): void {
    const now = this.#now();
    this.#ledger.update(code, { conversation_id: conversationId, bound_at: now, call_live: 1 }, now);
  }

  /** Both steps at once, for a call that already exists (the owner called in). */
  async present(code: string, conversationId: string): Promise<ActionRow | null> {
    if (!(await this.prepareCall(code))) return null;
    this.bindCall(code, conversationId);
    return this.#ledger.get(code) ?? null;
  }

  statusOf(code: string): string | undefined {
    return this.#ledger.get(code)?.status;
  }

  /**
   * The owner called in while a sweep was waiting. Tie it to this call so a yes here can
   * approve it. Returns null if nothing is waiting or the owner is already being asked elsewhere.
   */
  async offerPendingTo(conversationId: string): Promise<ActionView | null> {
    const waiting = this.#ledger.pendingSweep();
    if (!waiting || waiting.call_live) return null;
    const presented = await this.present(waiting.code, conversationId);
    return presented ? view(presented) : null;
  }

  // ---------- reads and binding for the dashboard ----------

  /** The agent's own address. Public by nature; recipients' addresses are never exposed. */
  get walletAddress(): string {
    return this.#wallet.address;
  }

  /** The ledger, newest first, for display. Carries labels, never recipient addresses. */
  history(limit: number): LedgerEntry[] {
    return this.#ledger.recent(limit).map((r) => ({
      code: r.code, time: r.created_at, source: r.source, kind: r.kind, to_label: r.to_label,
      amount_usdc: fromMicros(r.amount), decision: r.decision, rule: r.rule, status: r.status,
      reason: r.reason, tx_hash: r.tx_hash, error: r.error,
    }));
  }

  /** A waiting sweep at its current amount, without tying it to any call. For telling the agent before a call connects. */
  async previewPending(): Promise<ActionView | null> {
    const waiting = this.#ledger.pendingSweep();
    if (!waiting || waiting.call_live) return null;
    const row = await this.prepareCall(waiting.code);
    return row ? view(row) : null;
  }

  /**
   * Tie the waiting sweep to a call that has just connected. Does not recompute: the agent
   * was already told an amount by previewPending, and that is the amount a yes approves.
   */
  bindPendingTo(conversationId: string): ActionView | null {
    const waiting = this.#ledger.pendingSweep();
    if (!waiting || waiting.call_live) return null;
    this.bindCall(waiting.code, conversationId);
    return view(this.#ledger.get(waiting.code)!);
  }

  callEnded(conversationId: string): void {
    const row = this.#ledger.boundTo(conversationId);
    if (row?.call_live) this.#ledger.update(row.code, { call_live: 0 }, this.#now());
  }

  /** The owner could not be reached after the retry. */
  noAnswer(code: string): void {
    const row = this.#ledger.get(code);
    if (row?.status === "pending") this.#ledger.update(code, { status: "expired_no_answer", call_live: 0 }, this.#now());
  }

  // ---------- deposits ----------

  async handleDeposit(d: Deposit): Promise<{ duplicate: boolean; action?: ActionRow }> {
    if (!this.#ledger.recordDeposit(d)) return { duplicate: true };
    return { duplicate: false, action: await this.#evaluateSweep(d) };
  }

  async #evaluateSweep(deposit?: Deposit): Promise<ActionRow | undefined> {
    const now = this.#now();
    const observed = (reason: string, rule = "sweep_rule", amount = deposit?.amount ?? 0): ActionRow =>
      this.#ledger.insert({
        now, source: "stream", origin: "sweep", kind: "deposit", amount, decision: "observed", rule,
        status: "observed", reason, deposit_tx: deposit?.tx_hash ?? null, deposit_log_index: deposit?.log_index ?? null,
      });

    const existing = this.#ledger.pendingSweep();
    if (existing?.call_live) {
      // The owner is being asked right now. Leave the question alone; the remainder is picked up afterwards.
      return deposit ? observed("sweep_pending") : undefined;
    }

    const amount = await this.#sweepAmount(existing?.code);
    if (amount === null) {
      if (existing) this.#cancel(existing.code, "no_longer_needed");
      return deposit ? observed("below_threshold") : undefined;
    }
    if (existing) this.#cancel(existing.code, "superseded");

    const label = this.#cfg.savingsLabel;
    const result = decide({ amount, toLabel: label, source: "stream" }, await this.#policyState(), this.#cfg);
    if (result.decision === "BLOCK") return observed("sweep_blocked", result.rule);

    const row = this.#ledger.insert({
      now, source: "stream", origin: "sweep", kind: "send", to_label: label, to_addr: this.#cfg.allowlist[label] ?? null,
      amount, decision: "CALL", rule: result.rule, status: "pending",
      deposit_tx: deposit?.tx_hash ?? null, deposit_log_index: deposit?.log_index ?? null,
    });
    this.#hooks.needsCall?.(row);
    return row;
  }

  // ---------- housekeeping ----------

  /** Pending actions nobody decided within the TTL. Returns how many expired. */
  expireStale(): number {
    const cutoff = this.#now() - this.#cfg.pendingTtlMs;
    const stale = this.#ledger.byStatus("pending").filter((r) => r.created_at < cutoff);
    for (const row of stale) this.#ledger.update(row.code, { status: "expired", call_live: 0 }, this.#now());
    return stale.length;
  }

  /** Run once at boot. Never re-sends: an action interrupted before broadcast fails closed. */
  async recover(): Promise<void> {
    const now = this.#now();
    for (const row of this.#ledger.byStatus("approved")) {
      this.#ledger.update(row.code, { status: "failed", error: "interrupted before broadcast; not sent" }, now);
    }
    for (const row of this.#ledger.byStatus("submitted")) {
      if (row.tx_hash) this.#track(this.#settle(row.code, row.tx_hash));
    }
    for (const row of this.#ledger.byStatus("pending")) {
      if (row.call_live) this.#ledger.update(row.code, { call_live: 0 }, now);
    }
    this.expireStale();
    await this.idle();
  }

  pause(): void { this.#ledger.setPaused(true); }
  unpause(): void { this.#ledger.setPaused(false); }

  async status(): Promise<StatusView> {
    return {
      balance_usdc: fromMicros(await this.#wallet.balance()),
      gas_reserve_usdc: fromMicros(this.#cfg.gasReserve),
      paused: this.#ledger.isPaused(),
      pending_actions: this.#ledger.byStatus("pending").map(view),
      recent: this.#ledger.recent(3).map(view),
    };
  }

  rules(): RulesView {
    const aliases = this.#cfg.aliases ?? {};
    return {
      per_tx_cap_usdc: fromMicros(this.#cfg.perTxCap),
      daily_cap_usdc: fromMicros(this.#cfg.dailyCap),
      approval_threshold_usdc: fromMicros(this.#cfg.approvalThreshold),
      gas_reserve_usdc: fromMicros(this.#cfg.gasReserve),
      sweep_threshold_usdc: fromMicros(this.#cfg.sweepThreshold),
      savings_label: this.#cfg.savingsLabel,
      paused: this.#ledger.isPaused(),
      recipients: Object.keys(this.#cfg.allowlist).map((label) => ({
        label,
        aliases: Object.entries(aliases).find(([l]) => normalizeLabel(l) === label)?.[1] ?? [],
      })),
    };
  }

  /** Resolves when every background settlement has finished. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  // ---------- internals ----------

  #resolveLabel(raw: string): string {
    const label = normalizeLabel(String(raw ?? ""));
    return this.#aliasToLabel.get(label) ?? label;
  }

  async #policyState(excludeCode?: string): Promise<PolicyState> {
    const balance = await this.#wallet.balance();
    return {
      paused: this.#ledger.isPaused(),
      spentToday: this.#ledger.spentSince(dailyResetBoundary(this.#now(), this.#cfg.dailyResetHourUtc)),
      available: balance - this.#ledger.committed(excludeCode),
    };
  }

  async #sweepAmount(excludeCode?: string): Promise<number | null> {
    return computeSweep({
      balance: await this.#wallet.balance(),
      committed: this.#ledger.committed(excludeCode),
      threshold: this.#cfg.sweepThreshold,
      gasReserve: this.#cfg.gasReserve,
    });
  }

  #cancel(code: string, reason: string, extra: Partial<ActionRow> = {}): ActionRow {
    return this.#ledger.update(code, { ...extra, status: "cancelled", reason, call_live: 0 }, this.#now());
  }

  #supersedePendingIn(conversationId: string): void {
    const prior = this.#ledger.boundTo(conversationId);
    if (prior?.status === "pending") this.#cancel(prior.code, "superseded");
  }

  #alreadyDecided(row: ActionRow, approved: boolean): ConfirmResult {
    if (row.status === "expired" || row.status === "expired_no_answer") {
      return { ok: false, error: "expired", ...view(row), message: "That request expired. Ask again to start over." };
    }
    const wasApproved = ["approved", "submitted", "complete", "failed"].includes(row.status);
    if (wasApproved !== approved) {
      return { ok: false, error: "already_decided", ...view(row), message: `That was already ${wasApproved ? "approved" : "cancelled"}.` };
    }
    return { ok: true, repeat: true, ...view(row), message: "Already done. Nothing new was sent." };
  }

  /** Broadcast an approved action. Returns as soon as the node has the transaction. */
  async #execute(code: string): Promise<ActionRow> {
    const row = this.#ledger.get(code);
    if (!row || row.status !== "approved" || !row.to_addr) throw new Error(`cannot execute ${code}`);
    let txHash: string;
    try {
      txHash = await this.#wallet.send(row.to_addr, row.amount);
    } catch (err) {
      return this.#ledger.update(code, { status: "failed", error: err instanceof Error ? err.message : String(err) }, this.#now());
    }
    const now = this.#now();
    const submitted = this.#ledger.update(code, { status: "submitted", tx_hash: txHash, submitted_at: now }, now);
    this.#track(this.#settle(code, txHash));
    return submitted;
  }

  async #settle(code: string, txHash: string): Promise<void> {
    let receipt: { ok: true } | { ok: false; error: string };
    try {
      receipt = await this.#wallet.waitForReceipt(txHash);
    } catch (err) {
      receipt = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const row = receipt.ok
      ? this.#ledger.update(code, { status: "complete" }, this.#now())
      : this.#ledger.update(code, { status: "failed", error: receipt.error }, this.#now());
    // A sweep may have been capped at what the owner heard. If there is still excess, ask again.
    if (row.status === "complete" && row.origin === "sweep") await this.#evaluateSweep();
  }

  #track(p: Promise<void>): void {
    const guarded = p.catch((err) => { console.error("[engine] settlement error:", err); });
    this.#inFlight.add(guarded);
    void guarded.finally(() => this.#inFlight.delete(guarded));
  }
}
