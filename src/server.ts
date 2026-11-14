import { readFileSync } from "node:fs";
// HTTP surface. The voice agent reaches the engine only through /tools/*.
//
// Every tool call must (1) carry the shared secret and (2) come from a conversation
// with the owner. There are deliberately no tools for unpausing or changing rules:
// those live on the dashboard, behind a different credential.
//
// The dashboard is /dashboard (a static page) plus /api/* (bearer token). It can read the
// ledger, unpause, and start a voice session with the agent from the browser.

import { Hono } from "hono";
import type { Context } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Engine } from "./engine.ts";
import type { ServerConfig } from "./config.ts";
import { normalizeE164 } from "./phone.ts";
import { nativeToMicros } from "./money.ts";
import { DEFAULT_OPENING_LINE } from "./agent/definition.ts";
import { DASHBOARD_HTML } from "./dashboard/page.ts";
import { explorerTx } from "./wallet/arc.ts";
import { toMicros, fromMicros } from "./money.ts";

const dashboardFile = (name: string) => readFileSync(new URL(`./dashboard/${name}`, import.meta.url));
const SOUNDS: Record<string, Buffer> = {
  "intro.mp3": dashboardFile("sounds/intro.mp3"),
  "confirm.mp3": dashboardFile("sounds/confirm.mp3"),
  "blocked.mp3": dashboardFile("sounds/blocked.mp3"),
};
const SOUNDS_JS = dashboardFile("sounds.js").toString("utf8");

export interface AppDeps {
  engine: Engine;
  cfg: ServerConfig;
  /** True for conversations this backend dialled itself. Filled in by the call queue. */
  isOutbound?: (conversationId: string) => boolean;
  /** Gets a token for a browser voice session. Null when voice is not configured. */
  getConversationToken?: (() => Promise<string>) | null;
  /** Simulated deposits are a development aid. Off in production unless set. */
  allowSimulate?: boolean;
  now?: () => number;
  /** Secret QuickNode signs Stream deliveries with. No secret, no hook. */
  streamSecret?: string;
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

export function createApp(deps: AppDeps): Hono {
  const { engine, cfg, isOutbound = () => false } = deps;
  const getConversationToken = deps.getConversationToken ?? null;
  const allowSimulate = deps.allowSimulate ?? process.env.NODE_ENV !== "production";
  const now = deps.now ?? Date.now;
  const app = new Hono();
  const owners = new Set(cfg.ownerNumbers);
  /** Browser conversations the signed-in owner started from the dashboard. They have no caller number. */
  const browserCalls = new Set<string>();

  app.get("/health", (c) => c.json({ ok: true }));

  /**
   * Who is on the line? Inbound: the caller must be an owner. Outbound: the owner is the
   * called party, or the conversation is one we placed. Browser: the conversation was bound
   * from the dashboard by someone holding the dashboard token. Caller ID can be spoofed,
   * which is why anything over the threshold also needs the PIN.
   */
  const isOwnerConversation = (body: Body, conversationId: string): boolean => {
    const caller = normalizeE164(body.caller_id);
    const called = normalizeE164(body.called_number);
    return (caller !== null && owners.has(caller)) || (called !== null && owners.has(called))
      || isOutbound(conversationId) || browserCalls.has(conversationId);
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

  /**
   * ElevenLabs calls this as an inbound call connects. The answer fills the variables in
   * the agent's prompt. A waiting sweep is bound to the call here, deterministically,
   * instead of hoping the model remembers to ask.
   */
  app.post("/hooks/conversation-init", async (c) => {
    if (!secretMatches(c.req.header("x-hotline-secret"), cfg.secret)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Body;
    const conversationId = readString(body.conversation_id);
    const variables = { call_context: "", opening_line: DEFAULT_OPENING_LINE };

    if (!conversationId || !isOwnerConversation(body, conversationId)) {
      variables.call_context = "This caller is NOT the owner. Do not use any tools. Say you cannot help with this number and end the call.";
      variables.opening_line = "Hotline.";
    } else {
      const waiting = await engine.offerPendingTo(conversationId);
      variables.call_context = waiting
        ? `The owner called you. One action is waiting for their approval on this call: ${waiting.summary}, because money arrived and their standing rule moves the excess to savings. Tell them about it first and ask for a yes or no and the PIN.`
        : "The owner called you. Nothing is waiting for approval.";
    }
    return c.json({ type: "conversation_initiation_client_data", dynamic_variables: variables });
  });

  /**
   * QuickNode Stream deliveries. Each one is signed: HMAC-SHA256 over nonce + timestamp + body,
   * keyed with the Stream's security token. Anything that fails that check is refused. Anything
   * signed is acknowledged with 200 even when it carries nothing useful, because a non-2xx makes
   * QuickNode retry and eventually pause the Stream.
   */
  app.post("/hooks/quicknode", async (c) => {
    if (!deps.streamSecret) return c.json({ error: "not_found" }, 404);
    const raw = await c.req.text();
    const nonce = c.req.header("x-qn-nonce"), timestamp = c.req.header("x-qn-timestamp"), given = c.req.header("x-qn-signature");
    if (!nonce || !timestamp || !given || !/^[0-9a-f]{64}$/i.test(given)) return c.json({ error: "unauthorized" }, 401);
    const expected = createHmac("sha256", deps.streamSecret).update(nonce + timestamp + raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(given, "hex"))) return c.json({ error: "unauthorized" }, 401);

    let parsed: unknown = null;
    try { parsed = JSON.parse(raw); } catch { /* acknowledged below */ }
    const items = parsed && typeof parsed === "object" && Array.isArray((parsed as Body).deposits) ? (parsed as { deposits: unknown[] }).deposits : [];
    const agent = engine.walletAddress.toLowerCase();
    let accepted = 0, duplicates = 0, ignored = 0;
    for (const item of items) {
      const d = item as Record<string, unknown>;
      const ok = typeof d.tx_hash === "string" && Number.isInteger(d.log_index) && typeof d.from === "string"
        && typeof d.to === "string" && typeof d.value === "string" && /^\d+$/.test(d.value) && Number.isInteger(d.block_number);
      if (!ok || (d.to as string).toLowerCase() !== agent) { ignored++; continue; }
      const amount = nativeToMicros(BigInt(d.value as string));
      if (amount <= 0) { ignored++; continue; }
      const result = await engine.handleDeposit({
        tx_hash: d.tx_hash as string, log_index: d.log_index as number, from_addr: d.from as string,
        amount, block_number: d.block_number as number, via: "stream", now: now(),
      });
      if (result.duplicate) duplicates++; else accepted++;
    }
    if (accepted) console.log(`[stream] ${accepted} deposit(s) from QuickNode`);
    return c.json({ accepted, duplicates, ignored });
  });

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

  // ---------- dashboard ----------

  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));

  // Original sounds made with ElevenLabs sound effects. Only these three names exist; nothing
  // else on disk can be requested through this route.
  app.get("/dashboard/sounds/:file", (c) => {
    const audio = Object.hasOwn(SOUNDS, c.req.param("file")) ? SOUNDS[c.req.param("file")] : undefined;
    if (!audio) return c.json({ error: "not_found" }, 404);
    return c.body(new Uint8Array(audio), 200, { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" });
  });
  app.get("/dashboard/sounds.js", (c) =>
    c.body(SOUNDS_JS, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }));

  // Everything under /api needs the dashboard token, in a header. Never in the URL, where it would end up in logs.
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!secretMatches(given, cfg.dashboardToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  const readJson = async (c: Context): Promise<Body> => {
    const parsed: unknown = await c.req.json().catch(() => ({}));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Body) : {};
  };

  app.get("/api/state", async (c) => {
    const status = await engine.status();
    return c.json({
      wallet_address: engine.walletAddress,
      balance_usdc: status.balance_usdc,
      paused: status.paused,
      rules: engine.rules(),
      pending_actions: status.pending_actions,
      ledger: engine.history(50).map((entry) => ({ ...entry, explorer_url: entry.tx_hash ? explorerTx(entry.tx_hash) : null })),
      voice_configured: getConversationToken !== null,
      simulate_allowed: allowSimulate,
    });
  });

  app.post("/api/unpause", (c) => {
    engine.unpause();
    return c.json({ paused: false });
  });

  /** Step one of a browser call: a token for the session and what the agent should know going in. */
  app.post("/api/call/start", async (c) => {
    if (!getConversationToken) {
      return c.json({ error: "voice_not_configured", message: "Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID, then restart the server." }, 503);
    }
    // Recompute now, bind later: the call does not have a conversation id until it connects.
    const waiting = await engine.previewPending();
    let token: string;
    try {
      token = await getConversationToken();
    } catch (err) {
      console.error("[dashboard] conversation token:", err instanceof Error ? err.message : err);
      return c.json({ error: "token_failed", message: "Could not get a call token from ElevenLabs. Check the API key and agent id." }, 502);
    }
    const signedIn = "The owner opened this voice session from their dashboard, where they are signed in. Treat them as the owner.";
    return c.json({
      conversation_token: token,
      dynamic_variables: {
        call_context: waiting
          ? `${signedIn} One action is waiting for their approval on this call: ${waiting.summary}, because money arrived and their standing rule moves the excess to savings. Tell them about it first and ask for a yes or no and the PIN.`
          : `${signedIn} Nothing is waiting for approval.`,
        opening_line: waiting ? "Hotline here. There's one thing waiting for your approval." : DEFAULT_OPENING_LINE,
      },
    });
  });

  /** Step two: the call connected. Let its tool calls through, and tie any waiting sweep to it. */
  app.post("/api/call/bind", async (c) => {
    const conversationId = readString((await readJson(c)).conversation_id);
    if (!conversationId) return c.json({ error: "bad_request", message: "conversation_id is required." }, 400);
    browserCalls.add(conversationId);
    return c.json({ ok: true, waiting: engine.bindPendingTo(conversationId) });
  });

  app.post("/api/call/end", async (c) => {
    const conversationId = readString((await readJson(c)).conversation_id);
    if (!conversationId) return c.json({ error: "bad_request", message: "conversation_id is required." }, 400);
    engine.callEnded(conversationId);
    return c.json({ ok: true });
  });

  /**
   * Development aid: run the deposit path without a chain transfer. It does not credit the
   * real wallet, so against a real wallet the sweep rule still works from the real balance.
   */
  let simulated = 0;
  app.post("/api/simulate-deposit", async (c) => {
    if (!allowSimulate) return c.json({ error: "not_found" }, 404);
    let amount: number;
    try { amount = toMicros((await readJson(c)).amount_usdc as number); } catch {
      return c.json({ error: "bad_request", message: "amount_usdc must be a positive number." }, 400);
    }
    const at = now();
    const result = await engine.handleDeposit({
      tx_hash: `simulated-${at}-${++simulated}`, log_index: 0, from_addr: "simulated", amount, block_number: 0, via: "simulated", now: at,
    });
    const row = result.action;
    return c.json({
      duplicate: result.duplicate,
      action: row ? { code: row.code, decision: row.decision, rule: row.rule, status: row.status, reason: row.reason, to_label: row.to_label, amount_usdc: fromMicros(row.amount) } : null,
    });
  });

  app.onError((err, c) => {
    console.error("[server]", err);
    return c.json({ error: "internal", message: "Something went wrong on our side. Nothing was sent." }, 500);
  });

  return app;
}
