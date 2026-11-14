// The facilitator on Arc testnet: checks a payment against the chain, then broadcasts
// USDC.transferWithAuthorization and pays the gas from its own key.
//
// No public x402 facilitator serves Arc testnet, so the seller runs this itself. The
// facilitator can only broadcast what the payer signed: the amount, recipient, and time
// window are inside the signature, and the USDC contract refuses a reused nonce.

import { createPublicClient, createWalletClient, getAddress, http, parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ARC_POLLING_MS, USDC_ERC20 } from "../wallet/arc.ts";
import { withFeeFloor } from "../wallet/fees.ts";
import type { Facilitator } from "./seller.ts";
import type { PaymentPayload, SettlementResponse, VerifyResponse } from "./protocol.ts";

export const USDC_EIP3009_ABI = [
  {
    type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", outputs: [],
    inputs: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
    ],
  },
  {
    type: "function", name: "authorizationState", stateMutability: "view", outputs: [{ name: "", type: "bool" }],
    inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }],
  },
  {
    type: "function", name: "balanceOf", stateMutability: "view", outputs: [{ name: "", type: "uint256" }],
    inputs: [{ name: "account", type: "address" }],
  },
] as const;

export function transferWithAuthorizationArgs(p: PaymentPayload) {
  const a = p.payload.authorization;
  const sig = parseSignature(p.payload.signature);
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
  return [
    getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce,
    v, sig.r, sig.s,
  ] as const;
}

const shortError = (err: unknown): string => {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split("\n")[0]!.slice(0, 200);
};

export function createArcFacilitator(opts: { rpcUrl: string; privateKey: `0x${string}` }): Facilitator & { address: string } {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl, { retryCount: 3, timeout: 15_000 });
  // viem's Arc entry has no blockTime, so it would poll receipts every 4 s. Arc makes ~1.2 blocks/s.
  const reader = createPublicClient({ chain: arcTestnet, transport, pollingInterval: ARC_POLLING_MS });
  const signer = createWalletClient({ account, chain: arcTestnet, transport });
  const network = `eip155:${arcTestnet.id}`;

  return {
    address: account.address,

    async check(p): Promise<VerifyResponse> {
      const a = p.payload.authorization;
      const payer = getAddress(a.from);
      try {
        const [balance, used] = await Promise.all([
          reader.readContract({ address: USDC_ERC20, abi: USDC_EIP3009_ABI, functionName: "balanceOf", args: [payer] }),
          reader.readContract({ address: USDC_ERC20, abi: USDC_EIP3009_ABI, functionName: "authorizationState", args: [payer, a.nonce] }),
        ]);
        if (balance < BigInt(a.value)) return { isValid: false, invalidReason: "insufficient_funds", invalidMessage: "The payer cannot cover the price.", payer };
        if (used) return { isValid: false, invalidReason: "invalid_payload", invalidMessage: "This authorization was already used.", payer };
        await reader.simulateContract({
          account, address: USDC_ERC20, abi: USDC_EIP3009_ABI, functionName: "transferWithAuthorization", args: transferWithAuthorizationArgs(p),
        });
        return { isValid: true, payer };
      } catch (err) {
        return { isValid: false, invalidReason: "invalid_transaction_state", invalidMessage: shortError(err), payer };
      }
    },

    async settle(p): Promise<SettlementResponse> {
      const payer = getAddress(p.payload.authorization.from);
      let hash: `0x${string}`;
      try {
        const fees = withFeeFloor(await reader.estimateFeesPerGas());
        hash = await signer.writeContract({
          address: USDC_ERC20, abi: USDC_EIP3009_ABI, functionName: "transferWithAuthorization", args: transferWithAuthorizationArgs(p), ...fees,
        });
      } catch (err) {
        return { success: false, errorReason: "unexpected_settle_error", errorMessage: shortError(err), transaction: "", network, payer };
      }
      try {
        const receipt = await reader.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 30_000 });
        if (receipt.status !== "success") return { success: false, errorReason: "invalid_transaction_state", errorMessage: "reverted", transaction: hash, network, payer };
        return { success: true, transaction: hash, network, payer, amount: p.payload.authorization.value };
      } catch (err) {
        // Broadcast, but no receipt yet: it may still land. The spec's non-terminal code.
        return { success: false, errorReason: "settlement_pending", errorMessage: shortError(err), transaction: hash, network, payer };
      }
    },
  };
}
