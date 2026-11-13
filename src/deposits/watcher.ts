// Turns Arc's USDC Transfer logs into deposits for the engine.
//
// Arc logs every USDC movement from one system address, at 18 decimals. The ERC-20
// contract logs the same movement again at 6 decimals for ERC-20 calls. Only the
// system emitter is trusted here, so a transfer is counted once however it was sent.

import { createPublicClient, http, parseAbiItem } from "viem";
import type { Deposit } from "../ledger.ts";
import { ARC_TESTNET, USDC_SYSTEM_EMITTER } from "../wallet/arc.ts";
import { nativeToMicros } from "../money.ts";

export interface TransferLog {
  address: string;
  transactionHash: string | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  args: { from?: string; to?: string; value?: bigint };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function depositFromLog(log: TransferLog, agent: string, via: Deposit["via"], now: number): Deposit | null {
  if (!same(log.address, USDC_SYSTEM_EMITTER)) return null;
  if (!log.transactionHash || log.logIndex === null || log.blockNumber === null) return null;
  const { from, to, value } = log.args;
  if (!from || !to || value === undefined || !same(to, agent)) return null;
  const amount = nativeToMicros(value);
  if (amount <= 0) return null;
  return {
    tx_hash: log.transactionHash, log_index: log.logIndex, from_addr: from, amount,
    block_number: Number(log.blockNumber), via, now,
  };
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/**
 * Polls the RPC for Transfer logs to the agent. This is the fallback trigger: it needs no
 * account and keeps the phone ringing even if the QuickNode Stream is slow or down. Both
 * can run at once; the ledger's (tx_hash, log_index) key makes the second arrival a no-op.
 */
export function startDepositPoller(opts: {
  rpcUrl: string;
  agent: string;
  onDeposit: (d: Deposit) => void | Promise<void>;
  pollingIntervalMs?: number;
}): () => void {
  const client = createPublicClient({ chain: ARC_TESTNET, transport: http(opts.rpcUrl, { retryCount: 3 }) });
  return client.watchEvent({
    address: USDC_SYSTEM_EMITTER,
    event: TRANSFER,
    args: { to: opts.agent as `0x${string}` },
    poll: true,
    pollingInterval: opts.pollingIntervalMs ?? 2000,
    onLogs: (logs) => {
      for (const log of logs) {
        const deposit = depositFromLog(log, opts.agent, "poller", Date.now());
        if (deposit) void Promise.resolve(opts.onDeposit(deposit)).catch((err) => console.error("[deposits]", err));
      }
    },
    onError: (err) => console.error("[deposits] poll error:", err.message),
  });
}
