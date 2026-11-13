// Test utilities. Nothing in src/ imports this file.
import { Ledger } from "../src/ledger.ts";
import { Engine } from "../src/engine.ts";
import type { EngineConfig, Wallet } from "../src/engine.ts";
import type { ActionRow } from "../src/ledger.ts";

export const U = 1_000_000;
export const T0 = Date.UTC(2026, 10, 13, 15, 0);
export const ALICE = "0x00000000000000000000000000000000000a11ce";
export const SAVINGS = "0x000000000000000000000000000000000005a7e5";
export const PIN = "5729";

/** The demo configuration from the design doc. */
export const demoConfig = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  perTxCap: 250 * U, dailyCap: 1000 * U, approvalThreshold: 50 * U, gasReserve: 1 * U,
  allowlist: { alice: ALICE, savings: SAVINGS },
  aliases: { alice: ["爱丽丝"], savings: ["储蓄", "存款"] },
  sweepThreshold: 100 * U, savingsLabel: "savings",
  ownerPin: PIN, pendingTtlMs: 600_000, dailyResetHourUtc: 0,
  ...over,
});

/** An in-memory wallet that behaves like a chain account: sends debit, reverts refund. */
export class FakeWallet implements Wallet {
  readonly address = "0x0000000000000000000000000000000000a9e417";
  balanceMicros: number;
  sends: { to: string; amount: number; hash: string }[] = [];
  failNextSend: string | null = null;
  failNextReceipt: string | null = null;
  constructor(balanceMicros: number) { this.balanceMicros = balanceMicros; }
  async balance(): Promise<number> { return this.balanceMicros; }
  async send(to: string, amount: number): Promise<string> {
    if (this.failNextSend) { const msg = this.failNextSend; this.failNextSend = null; throw new Error(msg); }
    this.balanceMicros -= amount;
    const hash = "0x" + (this.sends.length + 1).toString(16).padStart(64, "0");
    this.sends.push({ to, amount, hash });
    return hash;
  }
  async waitForReceipt(hash: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.failNextReceipt) {
      const error = this.failNextReceipt; this.failNextReceipt = null;
      const sent = this.sends.find((s) => s.hash === hash);
      if (sent) this.balanceMicros += sent.amount;
      return { ok: false, error };
    }
    return { ok: true };
  }
  /** Money arriving from outside. */
  credit(amount: number): void { this.balanceMicros += amount; }
}

export function setup(opts: { balance?: number; cfg?: Partial<EngineConfig> } = {}) {
  const ledger = new Ledger(":memory:");
  const wallet = new FakeWallet(opts.balance ?? 260 * U);
  const clock = { t: T0 };
  const calls: ActionRow[] = [];
  const engine = new Engine({
    ledger, wallet, cfg: demoConfig(opts.cfg), now: () => clock.t,
    hooks: { needsCall: (row) => { calls.push(row); } },
  });
  let n = 0;
  /** Credit the wallet and deliver the matching deposit log to the engine. */
  const deposit = async (amount: number, over: { tx_hash?: string; log_index?: number; via?: "stream" | "poller" } = {}) => {
    wallet.credit(amount);
    return engine.handleDeposit({
      tx_hash: over.tx_hash ?? `0xdep${++n}`, log_index: over.log_index ?? 0, from_addr: "0xfeed",
      amount, block_number: 100 + n, via: over.via ?? "stream", now: clock.t,
    });
  };
  return { ledger, wallet, clock, calls, engine, deposit };
}
