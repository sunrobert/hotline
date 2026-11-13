// The outbound call queue: turns "this action needs the owner on the phone" into a call.
//
// One call at a time. Each action gets two attempts, ninety seconds apart. The amount
// spoken is recomputed at dial time. Driven by tick(), so it has no timers of its own.

import type { Engine } from "../engine.ts";
import type { ActionRow } from "../ledger.ts";
import { formatUsdc } from "../money.ts";

export interface Dialer {
  dial(req: { toNumber: string; variables: Record<string, string> }): Promise<{ conversationId: string }>;
  isEnded(conversationId: string): Promise<boolean>;
}

/** What the agent is told, and what it says first, on a call it places. No addresses, no codes. */
export function callScript(row: ActionRow): { call_context: string; opening_line: string } {
  const amount = formatUsdc(row.amount);
  const to = row.to_label ?? "the recipient";
  const waiting = `One action is waiting for approval on this call: Send ${amount} USDC to ${to}.`;
  const after = "You have already said the opening line. Wait for the owner's answer and follow the approval rules.";
  if (row.origin === "sweep") {
    return {
      call_context: `You placed this call to the owner. USDC arrived in the wallet and the owner's standing rule moves the excess to ${to}. ${waiting} ${after}`,
      opening_line: `This is Hotline. Money just arrived in your wallet, and your rule moves the extra to ${to}. I'd send ${amount} U S D C to ${to}. Yes or no, and your PIN?`,
    };
  }
  return {
    call_context: `You placed this call to the owner. They asked by text to send ${amount} USDC to ${to}, and that amount needs their spoken approval. ${waiting} ${after}`,
    opening_line: `This is Hotline. You asked me to send ${amount} U S D C to ${to}, and that needs your approval. Yes or no, and your PIN?`,
  };
}

const MAX_ATTEMPTS = 2;

interface Job {
  code: string;
  attempts: number;
  state: "waiting" | "live";
  notBefore: number;
  conversationId?: string;
  dialledAt?: number;
}

export class CallQueue {
  readonly #engine: Engine;
  readonly #dialer: Dialer;
  readonly #ownerNumber: string;
  readonly #now: () => number;
  readonly #retryDelayMs: number;
  readonly #maxCallMs: number;
  readonly #jobs: Job[] = [];
  readonly #placed = new Set<string>();
  #ticking = false;

  constructor(opts: { engine: Engine; dialer: Dialer; ownerNumber: string; now?: () => number; retryDelayMs?: number; maxCallMs?: number }) {
    this.#engine = opts.engine;
    this.#dialer = opts.dialer;
    this.#ownerNumber = opts.ownerNumber;
    this.#now = opts.now ?? Date.now;
    this.#retryDelayMs = opts.retryDelayMs ?? 90_000;
    this.#maxCallMs = opts.maxCallMs ?? 6 * 60_000;
  }

  get size(): number { return this.#jobs.length; }

  enqueue(code: string): void {
    if (!this.#jobs.some((j) => j.code === code)) this.#jobs.push({ code, attempts: 0, state: "waiting", notBefore: 0 });
  }

  /** True for conversations this queue dialled. The server's owner gate accepts these. */
  isOutbound(conversationId: string): boolean {
    return this.#placed.has(conversationId);
  }

  /** Advance by one step: wrap up a finished call, or place the next one. Safe to call often. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const live = this.#jobs.find((j) => j.state === "live");
      if (live) {
        const overdue = this.#now() - (live.dialledAt ?? 0) > this.#maxCallMs;
        if (overdue || await this.#dialer.isEnded(live.conversationId!)) this.#wrapUp(live);
        return;
      }
      const next = this.#jobs.find((j) => j.notBefore <= this.#now());
      if (next) await this.#dial(next);
    } finally {
      this.#ticking = false;
    }
  }

  async #dial(job: Job): Promise<void> {
    const row = await this.#engine.prepareCall(job.code);
    if (!row) { this.#remove(job); return; }
    job.attempts++;
    try {
      const { conversationId } = await this.#dialer.dial({ toNumber: this.#ownerNumber, variables: callScript(row) });
      this.#engine.bindCall(job.code, conversationId);
      this.#placed.add(conversationId);
      job.state = "live";
      job.conversationId = conversationId;
      job.dialledAt = this.#now();
      console.log(`[calls] dialled owner about ${job.code} (attempt ${job.attempts}), conversation ${conversationId}`);
    } catch (err) {
      console.error(`[calls] dial failed for ${job.code}:`, err instanceof Error ? err.message : err);
      this.#missed(job);
    }
  }

  #wrapUp(job: Job): void {
    if (job.conversationId) this.#engine.callEnded(job.conversationId);
    if (this.#engine.statusOf(job.code) === "pending") this.#missed(job);
    else this.#remove(job);
  }

  #missed(job: Job): void {
    if (job.attempts >= MAX_ATTEMPTS) {
      this.#engine.noAnswer(job.code);
      this.#remove(job);
      console.log(`[calls] no answer for ${job.code} after ${job.attempts} attempts`);
      return;
    }
    job.state = "waiting";
    job.notBefore = this.#now() + this.#retryDelayMs;
  }

  #remove(job: Job): void {
    const i = this.#jobs.indexOf(job);
    if (i >= 0) this.#jobs.splice(i, 1);
  }
}
