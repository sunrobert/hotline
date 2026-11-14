// The selling side of x402: Hono middleware that puts a price on a route.
//
//   no PAYMENT-SIGNATURE   -> 402 + PAYMENT-REQUIRED
//   bad payment            -> 402 + PAYMENT-REQUIRED with the reason
//   good payment           -> run the route; only if it succeeds, settle on chain;
//                             settled -> the data + PAYMENT-RESPONSE
//                             not settled -> 402 + PAYMENT-RESPONSE, data withheld
//
// The seller is its own facilitator (no public facilitator serves Arc testnet), so
// "facilitator" here is a local object, not an HTTP service.

import type { Context, MiddlewareHandler } from "hono";
import { X402_VERSION, decodeHeader, encodeHeader, verifyPayment } from "./protocol.ts";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettlementResponse, VerifyResponse } from "./protocol.ts";

export interface Facilitator {
  /** The on-chain half of verification: balance, nonce unused, and a dry run. */
  check(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse>;
  /** Broadcast transferWithAuthorization and wait for it to land. */
  settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettlementResponse>;
}

export function paywall(opts: {
  requirements: PaymentRequirements;
  facilitator: Facilitator;
  description?: string;
  mimeType?: string;
  /** Unix seconds. Injected by tests. */
  nowSec?: () => number;
}): MiddlewareHandler {
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  /** Nonces this seller has accepted. The chain refuses reuse too; this stops a race before it costs gas. */
  const spent = new Set<string>();

  const askForPayment = (c: Context, error?: string, message?: string) => {
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error ? { error } : {}),
      resource: { url: c.req.url, description: opts.description, mimeType: opts.mimeType ?? "application/json" },
      accepts: [opts.requirements],
    };
    c.header("PAYMENT-REQUIRED", encodeHeader(body));
    return c.json({ ...body, ...(message ? { message } : {}) }, 402);
  };

  return async (c, next) => {
    const raw = c.req.header("PAYMENT-SIGNATURE");
    if (!raw) return askForPayment(c, "PAYMENT-SIGNATURE header is required");

    let payload: PaymentPayload;
    try { payload = decodeHeader<PaymentPayload>(raw); } catch {
      return c.json({ error: "invalid_payload", message: "PAYMENT-SIGNATURE is not base64 JSON." }, 400);
    }

    const offline = await verifyPayment(payload, opts.requirements, nowSec());
    if (!offline.isValid) return askForPayment(c, offline.invalidReason, offline.invalidMessage);

    const nonceKey = `${payload.payload.authorization.from.toLowerCase()}:${payload.payload.authorization.nonce}`;
    if (spent.has(nonceKey)) return askForPayment(c, "invalid_payload", "This authorization was already used.");

    const onchain = await opts.facilitator.check(payload, opts.requirements);
    if (!onchain.isValid) return askForPayment(c, onchain.invalidReason, onchain.invalidMessage);

    spent.add(nonceKey);
    await next();
    if (c.res.status >= 400) {
      spent.delete(nonceKey); // nothing was taken; the buyer may retry with the same authorization
      return;
    }

    let settlement: SettlementResponse;
    try {
      settlement = await opts.facilitator.settle(payload, opts.requirements);
    } catch (err) {
      settlement = { success: false, errorReason: "unexpected_settle_error", errorMessage: err instanceof Error ? err.message : String(err), transaction: "", network: opts.requirements.network };
    }
    if (!settlement.success) {
      c.res = new Response(JSON.stringify({ error: settlement.errorReason, message: settlement.errorMessage }), {
        status: 402,
        headers: { "Content-Type": "application/json", "PAYMENT-RESPONSE": encodeHeader(settlement) },
      });
      return;
    }
    c.res.headers.set("PAYMENT-RESPONSE", encodeHeader(settlement));
  };
}
