// Arc's mempool silently drops any transaction whose maxFeePerGas is under 20 gwei:
// no error, no receipt. Every send goes through this floor.

export const ARC_MIN_FEE_PER_GAS = 20_000_000_000n;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export function withFeeFloor(estimate: Fees): Fees {
  const maxFeePerGas = estimate.maxFeePerGas > ARC_MIN_FEE_PER_GAS ? estimate.maxFeePerGas : ARC_MIN_FEE_PER_GAS;
  const maxPriorityFeePerGas = estimate.maxPriorityFeePerGas < maxFeePerGas ? estimate.maxPriorityFeePerGas : maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}
