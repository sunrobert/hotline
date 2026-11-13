// Places and tracks outbound calls through ElevenLabs, over a Twilio number or a SIP trunk (for example Telnyx).

import type { Dialer } from "./queue.ts";

const API = "https://api.elevenlabs.io";
/** `processing` means the call is over and ElevenLabs is analysing it. */
const ENDED = new Set(["processing", "done", "failed"]);

export type PhoneProvider = "twilio" | "sip_trunk";

export function createDialer(opts: { apiKey: string; agentId: string; phoneNumberId: string; provider?: PhoneProvider; fetch?: typeof fetch }): Dialer {
  const doFetch = opts.fetch ?? fetch;
  const headers = { "xi-api-key": opts.apiKey, "content-type": "application/json" };
  // Same request either way; the number's provider decides which endpoint places the call.
  const outboundPath = opts.provider === "sip_trunk" ? "/v1/convai/sip-trunk/outbound-call" : "/v1/convai/twilio/outbound-call";

  return {
    async dial({ toNumber, variables }) {
      const res = await doFetch(`${API}${outboundPath}`, {
        method: "POST", headers,
        body: JSON.stringify({
          agent_id: opts.agentId,
          agent_phone_number_id: opts.phoneNumberId,
          to_number: toNumber,
          conversation_initiation_client_data: { dynamic_variables: variables },
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`outbound call failed: ${res.status} ${text.slice(0, 200)}`);
      const body = JSON.parse(text) as { success?: boolean; message?: string; conversation_id?: string | null };
      if (!body.success || !body.conversation_id) throw new Error(`outbound call rejected: ${body.message ?? "no conversation id"}`);
      return { conversationId: body.conversation_id };
    },

    async isEnded(conversationId) {
      const res = await doFetch(`${API}/v1/convai/conversations/${encodeURIComponent(conversationId)}`, { headers });
      if (!res.ok) return false; // not visible yet, or a blip: the queue's time limit is the backstop
      const body = (await res.json()) as { status?: string };
      return ENDED.has(body.status ?? "");
    },
  };
}
