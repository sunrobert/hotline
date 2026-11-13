/** Phone numbers arrive in whatever shape the carrier likes. Compare them only after this. */
export function normalizeE164(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (hasPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
