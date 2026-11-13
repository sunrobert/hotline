// The policy engine. Pure: no I/O, no clock. Given what is being asked and the
// wallet's current state, it answers AUTO, CALL (ask the owner by voice), or BLOCK.
// Rules run in a fixed order and the first match wins, so every decision names
// exactly one rule. All amounts are integer micro-USDC.

import { formatUsdc } from "./money.ts";

export type Decision = "AUTO" | "CALL" | "BLOCK";
export type Rule =
  | "paused" | "invalid_amount" | "not_allowlisted" | "per_tx_cap" | "daily_cap" | "gas_reserve"
  | "approval_threshold" | "stream_source" | "auto";
export type Source = "voice" | "text" | "stream" | "agent";

export interface PolicyConfig {
  perTxCap: number;
  dailyCap: number;
  approvalThreshold: number;
  gasReserve: number;
  /** label -> address. Recipients are only ever named by label. */
  allowlist: Record<string, string>;
}

export interface PolicyState {
  paused: boolean;
  /** Outflows already submitted or complete since the daily reset. */
  spentToday: number;
  /** Wallet balance minus outflows already committed (pending, approved, submitted). */
  available: number;
}

export interface PolicyInput {
  amount: number;
  toLabel: string;
  source: Source;
}

export interface PolicyResult {
  decision: Decision;
  rule: Rule;
  reason: string;
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function decide(input: PolicyInput, state: PolicyState, cfg: PolicyConfig): PolicyResult {
  const { amount, source } = input;
  const block = (rule: Rule, reason: string): PolicyResult => ({ decision: "BLOCK", rule, reason });

  if (state.paused) {
    return block("paused", "The agent is paused. Nothing moves until it is unpaused from the dashboard.");
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return block("invalid_amount", "The amount has to be a positive number of USDC.");
  }
  if (!Object.hasOwn(cfg.allowlist, normalizeLabel(input.toLabel))) {
    return block("not_allowlisted", `"${input.toLabel.trim()}" is not on the allowlist. Recipients can only be added from the dashboard.`);
  }
  if (amount > cfg.perTxCap) {
    return block("per_tx_cap", `${formatUsdc(amount)} USDC is over the per-transaction cap of ${formatUsdc(cfg.perTxCap)} USDC.`);
  }
  if (state.spentToday + amount > cfg.dailyCap) {
    return block("daily_cap", `That would pass the daily cap of ${formatUsdc(cfg.dailyCap)} USDC. ${formatUsdc(state.spentToday)} USDC has gone out today.`);
  }
  if (state.available - amount < cfg.gasReserve) {
    return block("gas_reserve", `That would leave less than the ${formatUsdc(cfg.gasReserve)} USDC kept back for gas.`);
  }
  if (source === "stream") {
    return { decision: "CALL", rule: "stream_source", reason: "Nobody asked for this just now, so the owner has to approve it by voice." };
  }
  if (amount > cfg.approvalThreshold) {
    return { decision: "CALL", rule: "approval_threshold", reason: `${formatUsdc(amount)} USDC is over the ${formatUsdc(cfg.approvalThreshold)} USDC auto-approve limit, so it needs a spoken yes and the PIN.` };
  }
  return { decision: "AUTO", rule: "auto", reason: "Within every limit." };
}
