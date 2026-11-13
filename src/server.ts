// HTTP surface. The voice agent reaches the engine only through /tools/*.
//
// Every tool call must (1) carry the shared secret and (2) come from a conversation
// with the owner. There are deliberately no tools for unpausing or changing rules:
// those live on the dashboard, behind a different credential.

import { Hono } from "hono";
import type { Context } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Engine } from "./engine.ts";
import type { ServerConfig } from "./config.ts";
import { normalizeE164 } from "./phone.ts";

export interface AppDeps {
  engine: Engine;
  cfg: ServerConfig;
  /** True for conversations this backend dialled itself. Filled in by the call queue. */
  isOutbound?: (conversationId: string) => boolean;
}

type Body = Record<string, unknown>;

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();
const secretMatches = (given: string | undefined, expected: string): boolean =>
  typeof given === "string" && timingSafeEqual(sha(given), sha(expected));

/** LLMs send booleans as booleans, strings, or not at all. Only an explicit value counts. */
function readBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return undefined;
}

const readString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function createApp({ engine, cfg, isOutbound = () => false }: AppDeps): Hono {
  const app = new Hono();
  const owners = new Set(cfg.ownerNumbers);

  app.get("/health", (c) => c.json({ ok: true }));

  /**
   * Who is on the line? Inbound: the caller must be an owner. Outbound: the owner is the
   * called party, or the conversation is one we placed. Caller ID can be spoofed, which is
   * why anything over the threshold also needs the PIN.
   */
  const isOwnerConversation = (body: Body, conversationId: string): boolean => {
    const caller = normalizeE164(body.caller_id);
    const called = normalizeE164(body.called_number);
    return (caller !== null && owners.has(caller)) || (called !== null && owners.has(called)) || isOutbound(conversationId);
  };

  const tools: Record<string, (c: Context, body: Body, conversationId: string) => Promise<Response>> = {
    get_status: async (c) => c.json(await engine.status()),

    get_rules: async (c) => c.json(engine.rules()),

    propose_action: async (c, body, conversationId) => {
      const amount = typeof body.amount_usdc === "string" ? Number(body.amount_usdc) : body.amount_usdc;
      const result = await engine.propose({
        kind: "send",
        toLabel: readString(body.to_label) ?? "",
        amountUsdc: typeof amount === "number" ? amount : Number.NaN,
        source: "voice",
        callerId: normalizeE164(body.caller_id) ?? undefined,
        conversationId,
      });
      return c.json(result);
    },

    confirm_action: async (c, body, conversationId) => {
      const approved = readBoolean(body.approved);
      if (approved === undefined) return c.json({ ok: false, error: "approved_required", message: "approved must be true or false." }, 400);
      const pin = typeof body.pin === "number" ? String(body.pin) : readString(body.pin);
      return c.json(await engine.confirm({ conversationId, approved, pin }));
    },

    get_action_status: async (c, _body, conversationId) => {
      const action = engine.actionStatus(conversationId);
      if (!action) return c.json({ status: "none", message: "No action on this call yet." });
      return c.json({ ...action, tx_hash_short: action.tx_hash ? action.tx_hash.slice(0, 8) : null });
    },

    pause: async (c) => {
      engine.pause();
      return c.json({ paused: true, message: "Paused. Nothing moves until it is unpaused from the dashboard." });
    },
  };

  app.post("/tools/:tool", async (c) => {
    if (!secretMatches(c.req.header("x-hotline-secret"), cfg.secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const handler = Object.hasOwn(tools, c.req.param("tool")) ? tools[c.req.param("tool")] : undefined;
    if (!handler) return c.json({ error: "unknown_tool" }, 404);

    let body: Body;
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Body;
    } catch {
      return c.json({ error: "bad_request", message: "Body must be a JSON object." }, 400);
    }

    const conversationId = readString(body.conversation_id);
    if (!conversationId) return c.json({ error: "bad_request", message: "conversation_id is required." }, 400);

    if (!isOwnerConversation(body, conversationId)) {
      return c.json({ error: "not_owner", message: "This number is not allowed to use this agent. Say you cannot help and end the call." }, 403);
    }
    return handler(c, body, conversationId);
  });

  app.onError((err, c) => {
    console.error("[server]", err);
    return c.json({ error: "internal", message: "Something went wrong on our side. Nothing was sent." }, 500);
  });

  return app;
}
