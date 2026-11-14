// x402 v2, the parts Hotline uses: the `exact` scheme on EVM with EIP-3009.
//
// Spec: github.com/x402-foundation/x402, specs/x402-specification-v2.md,
// specs/schemes/exact/scheme_exact_evm.md, specs/transports-v2/http.md.
//
// The buyer signs a USDC TransferWithAuthorization for the exact price. The seller
// (acting as its own facilitator) checks it, broadcasts it, and pays the gas. Arc's
// USDC supports EIP-3009 on its ERC-20 interface (6 decimals), domain "USDC" version "2".
//
// This file is pure: no network, no clock. Signature recovery is local math.

import { getAddress, isAddress, isHex, recoverTypedDataAddress } from "viem";
import { arcTestnet } from "viem/chains";
import { USDC_ERC20 } from "../wallet/arc.ts";

export const X402_VERSION = 2;
export const ARC_NETWORK = `eip155:${arcTestnet.id}`;
/** An authorization must outlive verification by this much, or it could lapse while the transaction is in flight. */
export const SETTLEMENT_MARGIN_SECONDS = 6;

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  /** Atomic units of `asset`: for USDC, micro-USDC. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod?: "eip3009" };
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { signature: `0x${string}`; authorization: Authorization };
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  /** Empty when nothing was broadcast. */
  transaction: string;
  network: string;
  amount?: string;
}

/** What a seller on Arc testnet asks for: exact USDC, paid by EIP-3009 authorization. */
export function arcUsdcRequirements(opts: { amountMicros: number; payTo: string; maxTimeoutSeconds?: number }): PaymentRequirements {
  if (!Number.isInteger(opts.amountMicros) || opts.amountMicros <= 0) throw new Error(`price must be a positive integer of micro-USDC, got ${opts.amountMicros}`);
  if (!isAddress(opts.payTo)) throw new Error(`payTo is not an address: ${opts.payTo}`);
  return {
    scheme: "exact",
    network: ARC_NETWORK,
    amount: String(opts.amountMicros),
    asset: USDC_ERC20,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  };
}

/** True if Hotline can pay this option: exact USDC on Arc by EIP-3009. */
export function isPayableOnArc(r: PaymentRequirements): boolean {
  return r?.scheme === "exact"
    && r.network === ARC_NETWORK
    && typeof r.asset === "string" && r.asset.toLowerCase() === USDC_ERC20.toLowerCase()
    && (r.extra?.assetTransferMethod ?? "eip3009") === "eip3009"
    && typeof r.extra?.name === "string" && typeof r.extra?.version === "string"
    && isAddress(r.payTo) && /^[1-9]\d*$/.test(r.amount);
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T = unknown>(raw: string): T {
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(raw.trim())) throw new Error("not base64");
  return JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8")) as T;
}

/** The EIP-712 message the payer signs. Same shape the USDC contract hashes in transferWithAuthorization. */
export function authorizationTypedData(req: PaymentRequirements, a: Authorization) {
  return {
    domain: {
      name: req.extra.name,
      version: req.extra.version,
      chainId: Number(req.network.split(":")[1]),
      verifyingContract: getAddress(req.asset),
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: getAddress(a.from),
      to: getAddress(a.to),
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
  };
}

const invalid = (invalidReason: string, invalidMessage: string): VerifyResponse => ({ isValid: false, invalidReason, invalidMessage });
const sameAddress = (a: string, b: string): boolean => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
const isUint = (s: unknown): s is string => typeof s === "string" && /^\d{1,78}$/.test(s);

function isPayload(p: unknown): p is PaymentPayload {
  const x = p as PaymentPayload | null;
  const a = x?.payload?.authorization;
  return typeof x === "object" && x !== null && typeof x.accepted === "object" && x.accepted !== null
    && typeof x.payload?.signature === "string" && typeof a === "object" && a !== null
    && isAddress(String(a.from)) && isAddress(String(a.to)) && isUint(a.value) && isUint(a.validAfter) && isUint(a.validBefore)
    && isHex(a.nonce) && a.nonce.length === 66;
}

/**
 * Everything a seller can check without a chain: shape, version, scheme, network,
 * asset, recipient, exact amount, time window, and that the signature is the payer's.
 * The on-chain half (balance, nonce unused, simulation) is the facilitator's job.
 */
export async function verifyPayment(p: unknown, required: PaymentRequirements, nowSec: number): Promise<VerifyResponse> {
  if (!isPayload(p)) return invalid("invalid_payload", "Not an x402 payment payload.");
  if (p.x402Version !== X402_VERSION) return invalid("invalid_x402_version", `Only x402 version ${X402_VERSION} is accepted.`);
  if (p.accepted.scheme !== "exact") return invalid("unsupported_scheme", "Only the exact scheme is accepted.");
  if (p.accepted.network !== required.network) return invalid("invalid_network", `Payment must be on ${required.network}.`);
  if (!sameAddress(p.accepted.asset, required.asset) || !sameAddress(p.accepted.payTo, required.payTo) || p.accepted.amount !== required.amount) {
    return invalid("invalid_payment_requirements", "The payment was made against different terms than the ones offered.");
  }

  const a = p.payload.authorization;
  if (!sameAddress(a.to, required.payTo)) return invalid("invalid_exact_evm_payload_recipient_mismatch", "The authorization pays someone else.");
  if (a.value !== required.amount) return invalid("invalid_exact_evm_payload_authorization_value_mismatch", `The price is exactly ${required.amount}.`);
  if (BigInt(a.validAfter) > BigInt(nowSec)) return invalid("invalid_exact_evm_payload_authorization_valid_after", "The authorization is not valid yet.");
  if (BigInt(a.validBefore) < BigInt(nowSec + SETTLEMENT_MARGIN_SECONDS)) {
    return invalid("invalid_exact_evm_payload_authorization_valid_before", "The authorization expires too soon to settle.");
  }

  let signer: string;
  try {
    signer = await recoverTypedDataAddress({ ...authorizationTypedData(required, a), signature: p.payload.signature });
  } catch {
    return invalid("invalid_exact_evm_payload_signature", "The signature could not be read.");
  }
  if (!sameAddress(signer, a.from)) return invalid("invalid_exact_evm_payload_signature", "The signature is not the payer's.");
  return { isValid: true, payer: getAddress(a.from) };
}
