// USDC amounts are integer micro-USDC (6 decimals) everywhere inside Hotline.
// Arc's native unit is 18 decimals; the ERC-20 view of the same balance is 6.
// Converting native -> micros floors, so we never credit more than arrived.

const MICROS_PER_USDC = 1_000_000;
const NATIVE_PER_MICRO = 10n ** 12n;

export function toMicros(usdc: number): number {
  if (typeof usdc !== "number" || !Number.isFinite(usdc) || usdc <= 0) {
    throw new Error(`invalid amount: ${String(usdc)}`);
  }
  return Math.round(usdc * MICROS_PER_USDC);
}

export function fromMicros(micros: number): number {
  return micros / MICROS_PER_USDC;
}

export function formatUsdc(micros: number): string {
  return String(fromMicros(micros));
}

export function nativeToMicros(native: bigint): number {
  return Number(native / NATIVE_PER_MICRO);
}

export function microsToNative(micros: number): bigint {
  return BigInt(micros) * NATIVE_PER_MICRO;
}
