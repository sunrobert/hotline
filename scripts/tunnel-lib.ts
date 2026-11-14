// Pure helpers for scripts/tunnel.ts.

/** The public URL of a cloudflared quick tunnel, once it appears in the log. */
export function findTunnelUrl(log: string): string | null {
  for (const match of log.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/g)) {
    if (match[1] !== "api") return `https://${match[1]}.trycloudflare.com`;
  }
  return null;
}

/** Set KEY=value in .env text: replace the line if it exists, otherwise append it. */
export function setEnvValue(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, "m");
  if (line.test(text)) return text.replace(line, `${key}=${value}`);
  return `${text.endsWith("\n") || text === "" ? text : text + "\n"}${key}=${value}\n`;
}

export interface WatchState { failures: number; }
export type WatchAction = "ok" | "wait" | "restart" | "server_down";

/**
 * One watchdog check. Quick-tunnel addresses can silently stop resolving after a few hours, so
 * a run of failed public checks restarts the tunnel. If the local server is the thing that is
 * down, restarting the tunnel would only change the address, so that is reported instead.
 */
export function watchStep(
  state: WatchState,
  check: { localOk: boolean; publicOk: boolean },
  threshold = 3,
): { state: WatchState; action: WatchAction } {
  if (!check.localOk) return { state: { failures: 0 }, action: "server_down" };
  if (check.publicOk) return { state: { failures: 0 }, action: "ok" };
  const failures = state.failures + 1;
  return failures >= threshold ? { state: { failures: 0 }, action: "restart" } : { state: { failures }, action: "wait" };
}
