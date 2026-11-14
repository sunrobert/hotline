// Pure checks for `npm run preflight`: given what was observed, what is ready and what is not.
// "fail" blocks a demo. "warn" is survivable but worth fixing. Anything not observed is never "ok".

export interface PreflightFacts {
  serverUp: boolean;
  publicUrl: string | null;
  publicUp: boolean;
  /** Base URL the agent's webhook tools call, as stored on ElevenLabs. */
  agentToolsUrl: string | null;
  /** The workspace call-start webhook URL, as stored on ElevenLabs. */
  callStartHookUrl: string | null;
  phoneNumberAssigned: boolean;
  voiceConfigured: boolean;
  streamRunning: boolean;
  streamUrl: string | null;
  streamHookConfigured: boolean;
  paused: boolean | null;
  pendingActions: number | null;
  /** Micro-USDC. */
  agentBalance: number | null;
  senderBalance: number | null;
  elevenLabsCreditsLeft: number | null;
  quickNodeCreditsLeft: number | null;
}

export type Level = "ok" | "warn" | "fail";
export interface Check { name: string; level: Level; message: string; fix?: string; }

const U = 1_000_000;
/** About one full demo run: inbound call plus approval call, roughly 4 minutes. */
const ONE_RUN_CREDITS = 2_500;
const usdc = (micros: number) => String(Math.round(micros / 10_000) / 100);
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export function evaluatePreflight(f: PreflightFacts): Check[] {
  const checks: Check[] = [];
  const add = (name: string, level: Level, message: string, fix?: string) => checks.push({ name, level, message, ...(fix ? { fix } : {}) });
  const base = f.publicUrl ? trimSlash(f.publicUrl) : null;

  add("server", f.serverUp ? "ok" : "fail", f.serverUp ? "Backend answers on localhost." : "Backend is not answering on localhost.", f.serverUp ? undefined : "Run `npm start`.");

  if (!base) add("tunnel", "fail", "No PUBLIC_URL set.", "Run `npm run tunnel`.");
  else add("tunnel", f.publicUp ? "ok" : "fail", f.publicUp ? `Public address answers: ${base}` : `Public address is not answering: ${base}`, f.publicUp ? undefined : "Restart `npm run tunnel` (it repairs itself within about 3 minutes if left running).");

  const agentOk = base !== null && f.agentToolsUrl !== null && trimSlash(f.agentToolsUrl) === base;
  add("agent", agentOk ? "ok" : "fail",
    agentOk ? "Agent tools point at the current tunnel." : `Agent tools point at ${f.agentToolsUrl ?? "nothing"}, not the current tunnel.`,
    agentOk ? undefined : "Run `npm run agent` (or restart `npm run tunnel`, which does it).");

  const hookOk = base !== null && f.callStartHookUrl === `${base}/hooks/conversation-init`;
  add("call_start_hook", hookOk ? "ok" : "warn",
    hookOk ? "Inbound call-start hook points at the current tunnel." : "Inbound call-start hook is not on the current tunnel; inbound calls may not know a sweep is waiting.",
    hookOk ? undefined : "Run `npm run agent`.");

  add("phone", f.phoneNumberAssigned && f.voiceConfigured ? "ok" : "fail",
    f.phoneNumberAssigned && f.voiceConfigured ? "Phone number is attached and the server can place calls." : "No phone number attached, or the server has no voice settings.",
    f.phoneNumberAssigned && f.voiceConfigured ? undefined : "Run `npm run phone`, then restart `npm start`.");

  if (!f.streamRunning) add("stream", "warn", "QuickNode Stream is off. The RPC poller will still catch deposits, but the judge won't see the Stream.", "Run `npm run stream -- on`.");
  else if (!base || !f.streamUrl || trimSlash(f.streamUrl) !== `${base}/hooks/quicknode`) add("stream", "fail", `Stream delivers to ${f.streamUrl ?? "nowhere"}, not the current tunnel.`, "Run `npm run stream -- retarget`.");
  else if (!f.streamHookConfigured) add("stream", "fail", "Stream is on, but the server has no QUICKNODE_STREAM_SECRET, so it refuses deliveries.", "Restart `npm start`.");
  else add("stream", "ok", "QuickNode Stream is on and delivers to the current tunnel.");

  if (f.paused === null) add("paused", "warn", "Could not read the pause flag.");
  else add("paused", f.paused ? "fail" : "ok", f.paused ? "Agent is paused: every send will be blocked." : "Agent is not paused.", f.paused ? "Unpause from the dashboard." : undefined);

  if (f.pendingActions === null) add("pending", "warn", "Could not read pending approvals.");
  else add("pending", f.pendingActions > 0 ? "fail" : "ok", f.pendingActions > 0 ? `${f.pendingActions} approval(s) left over from earlier; one could be confirmed by mistake.` : "No leftover approvals.", f.pendingActions > 0 ? "Run `npm run reset-demo`." : undefined);

  if (f.agentBalance === null) add("agent_balance", "warn", "Could not read the agent's balance.");
  else if (f.agentBalance < 14 * U) add("agent_balance", "fail", `Agent holds ${usdc(f.agentBalance)} USDC; the demo expects about 15.`, "Run `npm run reset-demo`.");
  else if (f.agentBalance > 16 * U) add("agent_balance", "warn", `Agent holds ${usdc(f.agentBalance)} USDC; the sweep read out on stage will be larger than 15.`, "Run `npm run reset-demo`.");
  else add("agent_balance", "ok", `Agent holds ${usdc(f.agentBalance)} USDC.`);

  if (f.senderBalance === null) add("sender_balance", "warn", "Could not read the sender's balance.");
  else add("sender_balance", f.senderBalance >= 20 * U ? "ok" : "fail", `Sender holds ${usdc(f.senderBalance)} USDC${f.senderBalance >= 20 * U ? "." : "; the demo deposit is 20."}`, f.senderBalance >= 20 * U ? undefined : "Run `npm run reset-demo`, or use the Circle faucet.");

  if (f.elevenLabsCreditsLeft === null) add("elevenlabs_credits", "warn", "Could not read ElevenLabs credits.");
  else if (f.elevenLabsCreditsLeft < ONE_RUN_CREDITS) add("elevenlabs_credits", "fail", `Only ${f.elevenLabsCreditsLeft} ElevenLabs credits left; a full run needs about ${ONE_RUN_CREDITS}.`);
  else if (f.elevenLabsCreditsLeft < 10 * ONE_RUN_CREDITS) add("elevenlabs_credits", "warn", `${f.elevenLabsCreditsLeft} ElevenLabs credits left: fewer than 10 full runs.`);
  else add("elevenlabs_credits", "ok", `${f.elevenLabsCreditsLeft} ElevenLabs credits left (about ${Math.floor(f.elevenLabsCreditsLeft / ONE_RUN_CREDITS)} full runs).`);

  if (f.quickNodeCreditsLeft === null) add("quicknode_credits", "warn", "Could not read QuickNode credits.");
  else add("quicknode_credits", f.quickNodeCreditsLeft > 1_000_000 ? "ok" : "warn", `${f.quickNodeCreditsLeft} QuickNode credits left.`);

  return checks;
}
