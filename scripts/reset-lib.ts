// Pure planning for scripts/reset-demo.ts: which transfers put the demo wallets back
// in their starting positions after a rehearsal. Amounts are integer micro-USDC.

export type Wallet = "agent" | "sender" | "savings" | "alice";
export interface Transfer { from: Wallet; to: Wallet; amount: number; }
export interface ResetPlan {
  transfers: Transfer[];
  /** How much more the sender needs before the agent can be topped up. 0 when it can. */
  shortfall: number;
  agentAfter: number;
  senderAfter: number;
}

const CENT = 10_000;
const floorCents = (micros: number): number => Math.floor(micros / CENT) * CENT;
const ceilCents = (micros: number): number => Math.ceil(micros / CENT) * CENT;

/**
 * Money that left during a rehearsal (to savings and alice) goes back to the sender. The agent
 * ends between `agentTarget` and `agentTarget + headroom + a cent`; the headroom covers gas on
 * the rehearsal's own sends so the sweep amount read out on stage stays the same every time.
 * Each sending wallet keeps `gasBuffer` back, because on Arc gas is paid in the same USDC.
 */
export function planReset(input: {
  balances: Record<Wallet, number>;
  agentTarget: number;
  headroom: number;
  gasBuffer: number;
}): ResetPlan {
  const { agentTarget, headroom, gasBuffer } = input;
  const b = { ...input.balances };
  const transfers: Transfer[] = [];
  let shortfall = 0;

  for (const from of ["savings", "alice"] as const) {
    const amount = floorCents(b[from] - gasBuffer);
    if (amount > 0) {
      transfers.push({ from, to: "sender", amount });
      b[from] -= amount;
      b.sender += amount;
    }
  }

  if (b.agent < agentTarget) {
    const amount = ceilCents(agentTarget + headroom - b.agent);
    const spare = b.sender - gasBuffer;
    if (amount <= spare) {
      transfers.push({ from: "sender", to: "agent", amount });
      b.sender -= amount;
      b.agent += amount;
    } else {
      shortfall = amount - spare;
    }
  } else {
    const amount = floorCents(b.agent - agentTarget - headroom);
    if (amount >= CENT) {
      transfers.push({ from: "agent", to: "sender", amount });
      b.agent -= amount;
      b.sender += amount;
    }
  }

  return { transfers, shortfall, agentAfter: b.agent, senderAfter: b.sender };
}
