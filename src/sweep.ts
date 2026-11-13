// The one standing rule in the build: keep `threshold` on hand, sweep the rest.
// Pure functions; amounts are integer micro-USDC.

export interface SweepInput {
  /** Wallet balance right now. */
  balance: number;
  /** Outflows already promised to other actions (pending, approved, submitted). */
  committed: number;
  threshold: number;
  gasReserve: number;
}

/** How much to move to savings, or null when there is nothing worth sweeping. */
export function computeSweep({ balance, committed, threshold, gasReserve }: SweepInput): number | null {
  const available = balance - committed;
  if (available <= threshold) return null;
  // Whole USDC only. Gas leaves fractions behind, and "fourteen point nine eight" is a bad thing
  // to hear on an approval call. The fraction stays in the wallet as extra buffer.
  const amount = Math.floor((available - threshold - gasReserve) / 1_000_000) * 1_000_000;
  return amount > 0 ? amount : null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Epoch ms of the most recent daily reset (at `resetHourUtc`:00 UTC) at or before `now`. */
export function dailyResetBoundary(now: number, resetHourUtc: number): number {
  const midnight = Math.floor(now / DAY_MS) * DAY_MS;
  const todayReset = midnight + resetHourUtc * HOUR_MS;
  return todayReset <= now ? todayReset : todayReset - DAY_MS;
}
