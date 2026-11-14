// The QuickNode Stream that watches for USDC arriving at the agent wallet.
// Billing is per block processed, and Arc testnet makes about 105,000 blocks a day, so the
// Stream is meant to run only while it is needed (rehearsals, recording, the demo). It always
// starts at the chain tip: switching it on never pays for history.

import { buildStreamFilter } from "./stream-filter.ts";

/** Lets scripts/stream.ts find our Stream among others in the account. */
export const STREAM_EXTERNAL_ID = "hotline-deposits";

export interface StreamConfig {
  name: string;
  external_id: string;
  network: string;
  dataset: "logs";
  region: "usa_east";
  dataset_batch_size: number;
  elastic_batch_enabled: true;
  destination: "webhook";
  destination_attributes: {
    url: string;
    compression: "none";
    security_token: string;
    max_retry: number;
    retry_interval_sec: number;
    post_timeout_sec: number;
  };
  filter_function: string;
  fix_block_reorgs: 0;
  keep_distance_from_tip: 0;
  status: "active";
}

export function buildStreamConfig(opts: { agent: string; publicUrl: string; secret: string; network: string }): StreamConfig {
  if (opts.secret.length < 32) throw new Error("QuickNode requires a security token of at least 32 characters");
  return {
    name: "Hotline: USDC deposits to the agent",
    external_id: STREAM_EXTERNAL_ID,
    network: opts.network,
    dataset: "logs",
    region: "usa_east",
    // QuickNode requires at least 5 for tip Streams on chains with sub-second blocks. Elastic
    // batching delivers whatever is ready instead of waiting for 5, so latency stays low.
    dataset_batch_size: 5,
    elastic_batch_enabled: true,
    destination: "webhook",
    destination_attributes: {
      url: `${opts.publicUrl.replace(/\/+$/, "")}/hooks/quicknode`,
      compression: "none",
      security_token: opts.secret,
      // Ten tries a second apart covers a blip. A longer outage pauses the Stream, which also
      // stops it billing while the laptop is asleep.
      max_retry: 10,
      retry_interval_sec: 1,
      post_timeout_sec: 10,
    },
    filter_function: Buffer.from(buildStreamFilter(opts.agent), "utf8").toString("base64"),
    // Arc has deterministic finality: blocks do not reorg.
    fix_block_reorgs: 0,
    keep_distance_from_tip: 0,
    status: "active",
  };
}
