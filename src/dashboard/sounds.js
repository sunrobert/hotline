// Which sounds the dashboard plays, decided by comparing two refreshes of the ledger.
// Plain JavaScript so the page can load it as-is; types live in sounds.d.ts.
//
//   intro    money arrived and the agent is about to ring the owner
//   blocked  a limit refused a send
//   confirm  a send completed on chain
//
// The first refresh (prev === null) plays nothing, so opening the page never replays history.

const ORDER = ["intro", "blocked", "confirm"];

export function soundsFor(prev, next) {
  if (prev === null) return [];
  const before = new Map(prev.map((row) => [row.code, row]));
  const play = new Set();
  for (const row of next) {
    const was = before.get(row.code);
    if (row.kind === "send" && row.status === "complete" && was?.status !== "complete") play.add("confirm");
    if (!was && row.status === "blocked") play.add("blocked");
    if (!was && row.status === "pending" && row.source === "stream") play.add("intro");
  }
  return ORDER.filter((sound) => play.has(sound));
}
