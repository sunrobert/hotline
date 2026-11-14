import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStreamConfig, STREAM_EXTERNAL_ID } from "../src/deposits/stream-config.ts";
import { buildStreamFilter } from "../src/deposits/stream-filter.ts";

const AGENT = "0x354ea63B9120b9d98fd8FbD18145055561EFBa9D";
const cfg = () => buildStreamConfig({ agent: AGENT, publicUrl: "https://example.trycloudflare.com/", secret: "s".repeat(40), network: "arc-testnet" });

test("the Stream reads Arc testnet logs and is tagged so the script can find it again", () => {
  const c = cfg();
  assert.equal(c.network, "arc-testnet");
  assert.equal(c.dataset, "logs");
  assert.equal(c.external_id, STREAM_EXTERNAL_ID);
  assert.equal(c.status, "active");
});

test("it starts at the chain tip, never from history, so switching it on never bills a backfill", () => {
  const c = cfg() as unknown as Record<string, unknown>;
  assert.equal(c.start_range, undefined);
  assert.equal(c.end_range, undefined);
});

test("batching follows QuickNode's rule for sub-second chains: at least 5 blocks, delivered as soon as available", () => {
  const c = cfg();
  assert.ok(c.dataset_batch_size >= 5);
  assert.equal(c.elastic_batch_enabled, true);
});

test("deliveries go to the backend's QuickNode hook, signed with our secret, uncompressed", () => {
  const d = cfg().destination_attributes;
  assert.equal(cfg().destination, "webhook");
  assert.equal(d.url, "https://example.trycloudflare.com/hooks/quicknode");
  assert.equal(d.security_token, "s".repeat(40));
  assert.equal(d.compression, "none");
});

test("a short outage is retried, but a long one pauses the Stream instead of burning credits", () => {
  const d = cfg().destination_attributes;
  assert.ok(d.max_retry >= 3 && d.max_retry <= 20);
  assert.ok(d.retry_interval_sec >= 1);
});

test("the filter is our deposit filter, base64-encoded as the API requires", () => {
  assert.equal(Buffer.from(cfg().filter_function, "base64").toString("utf8"), buildStreamFilter(AGENT));
});

test("a security token shorter than QuickNode's 32-character minimum is refused", () => {
  assert.throws(() => buildStreamConfig({ agent: AGENT, publicUrl: "https://x.example", secret: "short", network: "arc-testnet" }), /32/);
});
