// The paying side of x402. Hotline's agent uses this to buy data per request.
//
// Nothing is signed until `approve` says yes, and Hotline wires `approve` to the
// policy engine: the payee must be on the allowlist and the price must fit the caps,
// exactly like a spoken "send". A signed authorization moves only the exact price,
// only to the payee, and expires in about a minute.

import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import {
  X402_VERSION, authorizationTypedData, decodeHeader, encodeHeader, isPayableOnArc,
} from "./protocol.ts";
import type { Authorization, PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo, SettlementResponse } from "./protocol.ts";

/** Anything that can sign EIP-712 data: a viem LocalAccount fits. */
export interface PayerAccount {
  address: `0x${string}`;
  signTypedData(data: ReturnType<typeof authorizationTypedData>): Promise<`0x${string}`>;
}

/** Clock skew allowance: the authorization is valid from slightly before now. */
const VALID_FROM_SKEW_SECONDS = 5;

export async function createPaymentPayload(opts: {
  account: PayerAccount;
  required: PaymentRequired;
  nowSec: number;
  nonce?: `0x${string}`;
}): Promise<PaymentPayload> {
  const accepted = opts.required.accepts?.find(isPayableOnArc);
  if (!accepted) throw new Error("no payment option Hotline can pay (needs exact USDC on Arc by EIP-3009)");
  const authorization: Authorization = {
    from: getAddress(opts.account.address),
    to: getAddress(accepted.payTo),
    value: accepted.amount,
    validAfter: String(Math.max(0, opts.nowSec - VALID_FROM_SKEW_SECONDS)),
    validBefore: String(opts.nowSec + accepted.maxTimeoutSeconds),
    nonce: opts.nonce ?? (`0x${randomBytes(32).toString("hex")}` as `0x${string}`),
  };
  const signature = await opts.account.signTypedData(authorizationTypedData(accepted, authorization));
  return { x402Version: X402_VERSION, resource: opts.required.resource, accepted, payload: { signature, authorization } };
}

export type Approval = { ok: true } | { ok: false; message: string };

export type PaidResult =
  | { status: "free"; response: Response }
  | { status: "declined"; message: string }
  | { status: "paid"; body: unknown; settlement: SettlementResponse; requirements: PaymentRequirements; payer: string }
  | { status: "failed"; reason: string; message: string; settlement?: SettlementResponse; requirements?: PaymentRequirements };

function readRequired(res: Response): PaymentRequired | null {
  const raw = res.headers.get("PAYMENT-REQUIRED");
  if (!raw) return null;
  try { return decodeHeader<PaymentRequired>(raw); } catch { return null; }
}

/**
 * GET a resource, paying for it if the seller answers 402.
 * One payment attempt at most: a second 402 is reported, never paid again.
 */
export async function paidFetch(url: string, opts: {
  account: PayerAccount;
  approve(req: PaymentRequirements, resource: ResourceInfo): Promise<Approval>;
  fetch?: typeof fetch;
  nowSec?: () => number;
  timeoutMs?: number;
}): Promise<PaidResult> {
  const doFetch = opts.fetch ?? fetch;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const signal = () => AbortSignal.timeout(opts.timeoutMs ?? 20_000);

  const first = await doFetch(url, { signal: signal() });
  if (first.status !== 402) return { status: "free", response: first };

  const required = readRequired(first);
  if (!required) return { status: "failed", reason: "invalid_payment_requirements", message: "The seller asked for payment but did not say how." };
  const option = required.accepts?.find(isPayableOnArc);
  if (!option) return { status: "failed", reason: "unsupported_scheme", message: "The seller wants a kind of payment Hotline does not make." };

  const approval = await opts.approve(option, required.resource);
  if (!approval.ok) return { status: "declined", message: approval.message };

  const payment = await createPaymentPayload({ account: opts.account, required: { ...required, accepts: [option] }, nowSec: nowSec() });
  const paid = await doFetch(url, { headers: { "PAYMENT-SIGNATURE": encodeHeader(payment) }, signal: signal() });

  let settlement: SettlementResponse | undefined;
  const rawSettlement = paid.headers.get("PAYMENT-RESPONSE");
  if (rawSettlement) { try { settlement = decodeHeader<SettlementResponse>(rawSettlement); } catch { /* reported below */ } }

  if (paid.ok && settlement?.success) {
    const text = await paid.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON: keep the text */ }
    return { status: "paid", body, settlement, requirements: option, payer: payment.payload.authorization.from };
  }

  const refused = readRequired(paid);
  const reason = settlement?.errorReason ?? refused?.error ?? `http_${paid.status}`;
  const message = settlement?.errorMessage ?? (paid.ok ? "The seller sent data without proof of settlement." : `The seller refused the payment (${reason}).`);
  return { status: "failed", reason, message, settlement, requirements: option };
}
