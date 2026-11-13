export type Sound = "intro" | "confirm" | "blocked";
export interface LedgerLike { code: string; kind: string; source: string; status: string; }
export function soundsFor(prev: LedgerLike[] | null, next: LedgerLike[]): Sound[];
