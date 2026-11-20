// Gives the backend on this laptop a public HTTPS address, for free, points the ElevenLabs agent
// and any running QuickNode Stream at it, and keeps it alive.
//
//   npm run tunnel        (in a second terminal, with `npm start` running in the first)
//
// Uses a Cloudflare quick tunnel: no account, no card. Its address changes on every start, and
// it can silently stop resolving after a few hours. So this script:
//   - rewrites PUBLIC_URL in .env.local and re-runs `npm run agent` for each new address,
//   - retargets a running QuickNode Stream,
//   - checks the public address every minute and starts a fresh tunnel after 3 failures in a row,
//   - restarts cloudflared if it exits.
// Leave it running. Ctrl-C stops it.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { findTunnelUrl, setEnvValue, watchStep } from "./tunnel-lib.ts";
import { publicHealthy } from "./net.ts";
import type { WatchState } from "./tunnel-lib.ts";

const port = Number(process.env.PORT || 8787);
const ENV = ".env.local";
const CHECK_EVERY_MS = 60_000;
const stamp = () => new Date().toLocaleTimeString();

let child: ChildProcess | null = null;
let currentUrl: string | null = null;
let generation = 0;
let stopping = false;
let watch: WatchState = { failures: 0 };

function start(): void {
  const myGeneration = ++generation;
  currentUrl = null;
  const proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  child = proc;
  proc.on("error", () => {
    console.error("cloudflared is not installed. Run: brew install cloudflared");
    process.exit(1);
  });
  let log = "";
  const onOutput = (chunk: Buffer) => {
    if (currentUrl || myGeneration !== generation) return;
    log += chunk.toString();
    const found = findTunnelUrl(log);
    if (found) { currentUrl = found; void ready(found, myGeneration); }
  };
  proc.stdout?.on("data", onOutput);
  proc.stderr?.on("data", onOutput);
  proc.on("exit", (code) => {
    if (stopping || myGeneration !== generation) return;
    console.log(`${stamp()} cloudflared exited (${code}); starting a new tunnel in 5 s`);
    setTimeout(() => { if (!stopping && myGeneration === generation) start(); }, 5000);
  });
}

function restart(reason: string): void {
  console.log(`${stamp()} restarting tunnel: ${reason}`);
  const old = child;
  generation++; // the old process's exit handler now ignores itself
  old?.kill("SIGTERM");
  start();
}

async function ready(publicUrl: string, myGeneration: number) {
  console.log(`tunnel   ${publicUrl} -> http://localhost:${port}`);

  // A brand-new tunnel's DNS record takes a few seconds to exist, and asking the Mac's resolver
  // too early makes it cache "no such host" for minutes. So: wait, then resolve through
  // Cloudflare's own resolver and connect to that address directly.
  await new Promise((r) => setTimeout(r, 15_000));
  let reachable = false;
  for (let i = 0; i < 15 && !reachable && myGeneration === generation; i++) {
    reachable = await publicHealthy(publicUrl);
    if (!reachable) await new Promise((r) => setTimeout(r, 3000));
  }
  if (myGeneration !== generation) return;
  if (!reachable) console.log(`warning  ${publicUrl}/health is not answering. Is \`npm start\` running on port ${port}?`);

  writeFileSync(ENV, setEnvValue(readFileSync(ENV, "utf8"), "PUBLIC_URL", publicUrl), { mode: 0o600 });
  console.log(`env      PUBLIC_URL updated in ${ENV}`);

  const agent = spawnSync(process.execPath, ["--env-file=.env.local", "scripts/agent.ts"], { stdio: "inherit" });
  if (agent.status !== 0) console.log("warning  updating the agent failed; see above");
  if (/^QUICKNODE_API_KEY=./m.test(readFileSync(ENV, "utf8"))) {
    spawnSync(process.execPath, ["--env-file=.env.local", "scripts/stream.ts", "retarget"], { stdio: "inherit" });
  }
  watch = { failures: 0 };
  console.log(`\nReady. Dashboard: ${publicUrl}/dashboard  (also http://localhost:${port}/dashboard)`);
  console.log("Leave this running. It checks the public address every minute and repairs it. Ctrl-C to stop.");
}

async function localHealthy(): Promise<boolean> {
  try { return (await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; }
}

setInterval(async () => {
  const url = currentUrl;
  if (!url || stopping) return;
  const [localOk, publicOk] = await Promise.all([localHealthy(), publicHealthy(url)]);
  if (url !== currentUrl) return; // a restart happened while checking
  const step = watchStep(watch, { localOk, publicOk });
  watch = step.state;
  if (step.action === "wait") console.log(`${stamp()} public address did not answer (${watch.failures}/3)`);
  if (step.action === "server_down") console.log(`${stamp()} the local server is not answering on port ${port}; start it with \`npm start\``);
  if (step.action === "restart") restart("public address stopped answering");
}, CHECK_EVERY_MS).unref();

const stop = () => { stopping = true; child?.kill("SIGTERM"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

start();
// Keep the process alive even though the watchdog interval is unref'd.
setInterval(() => {}, 1 << 30);
