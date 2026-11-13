// The real wallet: a key held by the backend, talking to Arc testnet through viem.
//
// USDC is Arc's native asset, so a transfer is a plain value send. Arc logs every such
// movement as a Transfer event from a system address (EIP-7708), which is what the
// deposit trigger listens for. Native amounts are 18 decimals; Hotline works in 6.

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import type { Wallet } from "../engine.ts";
import { microsToNative, nativeToMicros } from "../money.ts";
import { withFeeFloor } from "./fees.ts";

export const ARC_TESTNET = arcTestnet;
/** Emits a Transfer log (18 decimals) for every USDC movement, native or ERC-20. */
export const USDC_SYSTEM_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE" as const;
/** The optional ERC-20 view of the same balance (6 decimals). Not used for deposit detection: it would double-count. */
export const USDC_ERC20 = "0x3600000000000000000000000000000000000000" as const;

export const explorerTx = (hash: string): string => `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;

export function createArcWallet(opts: { rpcUrl: string; privateKey: `0x${string}` }): Wallet {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl, { retryCount: 3, timeout: 15_000 });
  const reader = createPublicClient({ chain: arcTestnet, transport });
  const signer = createWalletClient({ account, chain: arcTestnet, transport });

  return {
    address: account.address,

    async balance() {
      return nativeToMicros(await reader.getBalance({ address: account.address }));
    },

    async send(to, micros) {
      if (!isAddress(to)) throw new Error(`not an address: ${to}`);
      const fees = withFeeFloor(await reader.estimateFeesPerGas());
      return signer.sendTransaction({ to, value: microsToNative(micros), ...fees });
    },

    async waitForReceipt(txHash) {
      // Arc finality is deterministic: one confirmation is final.
      const receipt = await reader.waitForTransactionReceipt({ hash: txHash as `0x${string}`, confirmations: 1, timeout: 60_000 });
      return receipt.status === "success" ? { ok: true } : { ok: false, error: "reverted" };
    },
  };
}
