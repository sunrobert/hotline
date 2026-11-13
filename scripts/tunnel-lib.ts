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
