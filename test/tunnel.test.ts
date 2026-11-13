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
