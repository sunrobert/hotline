// Gives the backend on this laptop a public HTTPS address, for free, and points the
// ElevenLabs agent at it.
//
//   npm run tunnel        (in a second terminal, with `npm start` running in the first)
//
// Uses a Cloudflare quick tunnel: no account, no card. The address changes every time
// this starts, so it rewrites PUBLIC_URL in .env.local and re-runs `npm run agent` each
// time. Leave it running. When it stops, the agent's tools stop working until it runs again.

import { spawn, spawnSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { get } from "node:https";
import type { LookupFunction } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { findTunnelUrl, setEnvValue } from "./tunnel-lib.ts";

const port = Number(process.env.PORT || 8787);
const ENV = ".env.local";

const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
tunnel.on("error", () => {
  console.error("cloudflared is not installed. Run: brew install cloudflared");
  process.exit(1);
});

let log = "";
let url: string | null = null;
const onOutput = (chunk: Buffer) => {
  if (url) return;
  log += chunk.toString();
  url = findTunnelUrl(log);
  if (url) void ready(url);
};
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);

async function ready(publicUrl: string) {
  console.log(`tunnel   ${publicUrl} -> http://localhost:${port}`);

  // Wait until the address actually reaches the backend before telling ElevenLabs about it.
  // A brand-new tunnel's DNS record takes a few seconds to exist, and asking the Mac's resolver
  // too early makes it cache "no such host" for minutes. So: wait first, then resolve through
  // Cloudflare's own resolver and connect to that address directly.
  await new Promise((r) => setTimeout(r, 15_000));
  let reachable = false;
  for (let i = 0; i < 15 && !reachable; i++) {
    reachable = await healthy(publicUrl);
    if (!reachable) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!reachable) console.log(`warning  ${publicUrl}/health is not answering. Is \`npm start\` running on port ${port}?`);

  writeFileSync(ENV, setEnvValue(readFileSync(ENV, "utf8"), "PUBLIC_URL", publicUrl), { mode: 0o600 });
  console.log(`env      PUBLIC_URL updated in ${ENV}`);

  const agent = spawnSync(process.execPath, ["--env-file=.env.local", "scripts/agent.ts"], { stdio: "inherit" });
  if (agent.status !== 0) console.log("warning  updating the agent failed; see above");
  // If a QuickNode Stream is running, point it at the new address too.
  if (process.env.QUICKNODE_API_KEY || /^QUICKNODE_API_KEY=./m.test(readFileSync(ENV, "utf8"))) {
    spawnSync(process.execPath, ["--env-file=.env.local", "scripts/stream.ts", "retarget"], { stdio: "inherit" });
  }
  console.log(`\nReady. Dashboard: ${publicUrl}/dashboard  (also http://localhost:${port}/dashboard)`);
  console.log("Leave this running. Ctrl-C to stop.");
}

async function healthy(publicUrl: string): Promise<boolean> {
  const host = new URL(publicUrl).hostname;
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  let ip: string | undefined;
  try { ip = (await resolver.resolve4(host))[0]; } catch { return false; }
  if (!ip) return false;
  const address = ip;
  return new Promise((resolve) => {
    const req = get(`${publicUrl}/health`, {
      timeout: 8000,
      lookup: ((_host, opts, cb) =>
        opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)) as LookupFunction,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

const stop = () => { tunnel.kill("SIGTERM"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
tunnel.on("exit", (code) => {
  console.log(`cloudflared exited (${code}). The agent's tools are unreachable until this runs again.`);
  process.exit(code ?? 1);
});
