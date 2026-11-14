import { test } from "node:test";
import assert from "node:assert/strict";
import { findTunnelUrl, setEnvValue } from "../scripts/tunnel-lib.ts";

test("finds the quick-tunnel URL in cloudflared's log output", () => {
  const log = [
    "2026-11-13T16:20:01Z INF Thank you for trying Cloudflare Tunnel.",
    "2026-11-13T16:20:02Z INF +--------------------------------------------------------------------------------------------+",
    "2026-11-13T16:20:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
    "2026-11-13T16:20:02Z INF |  https://brave-otter-lamp-sunset.trycloudflare.com                                         |",
  ].join("\n");
  assert.equal(findTunnelUrl(log), "https://brave-otter-lamp-sunset.trycloudflare.com");
});

test("ignores Cloudflare's own links and returns null until the tunnel URL appears", () => {
  assert.equal(findTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com..."), null);
  assert.equal(findTunnelUrl("see https://developers.cloudflare.com/cloudflare-one/"), null);
  assert.equal(findTunnelUrl("https://api.trycloudflare.com/tunnel"), null);
});

test("setEnvValue replaces an existing key in place and keeps everything else", () => {
  const before = "A=1\nPUBLIC_URL=https://old.example\nB=2\n";
  assert.equal(setEnvValue(before, "PUBLIC_URL", "https://new.example"), "A=1\nPUBLIC_URL=https://new.example\nB=2\n");
});

test("setEnvValue appends a key that is missing", () => {
  assert.equal(setEnvValue("A=1\n", "PUBLIC_URL", "https://x.example"), "A=1\nPUBLIC_URL=https://x.example\n");
  assert.equal(setEnvValue("A=1", "PUBLIC_URL", "https://x.example"), "A=1\nPUBLIC_URL=https://x.example\n");
});

test("setEnvValue does not touch a key that merely contains the name", () => {
  const before = "OLD_PUBLIC_URL=keep\n";
  assert.equal(setEnvValue(before, "PUBLIC_URL", "https://x.example"), "OLD_PUBLIC_URL=keep\nPUBLIC_URL=https://x.example\n");
});

// ---------- watchdog ----------
import { watchStep } from "../scripts/tunnel-lib.ts";

test("while the public address answers, the watchdog does nothing and keeps no failure count", () => {
  assert.deepEqual(watchStep({ failures: 2 }, { localOk: true, publicOk: true }), { state: { failures: 0 }, action: "ok" });
});

test("a single failed public check is tolerated as a blip", () => {
  assert.deepEqual(watchStep({ failures: 0 }, { localOk: true, publicOk: false }), { state: { failures: 1 }, action: "wait" });
});

test("three failed public checks in a row, with the server fine, restart the tunnel", () => {
  let state = { failures: 0 };
  const actions: string[] = [];
  for (let i = 0; i < 3; i++) { const r = watchStep(state, { localOk: true, publicOk: false }); state = r.state; actions.push(r.action); }
  assert.deepEqual(actions, ["wait", "wait", "restart"]);
  assert.equal(state.failures, 0);
});

test("if the local server is down, the tunnel is not restarted; restarting would only change the address", () => {
  const r = watchStep({ failures: 2 }, { localOk: false, publicOk: false });
  assert.equal(r.action, "server_down");
  assert.equal(r.state.failures, 0);
});

test("the restart threshold can be raised", () => {
  const r = watchStep({ failures: 2 }, { localOk: true, publicOk: false }, 5);
  assert.equal(r.action, "wait");
});
