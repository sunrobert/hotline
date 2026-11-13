// Attaches your phone number to the Hotline agent on ElevenLabs, for inbound and outbound calls.
// Works with a Telnyx number over a SIP trunk (TELNYX_* settings) or a purchased Twilio number (TWILIO_* settings).
// Idempotent: if the number is already imported it is just re-assigned to the agent.
//
//   npm run phone
//
// Sends the provider credentials to ElevenLabs, which is how its phone integrations work.
// Prints ids and a masked number only.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { normalizeE164 } from "../src/phone.ts";

const API = "https://api.elevenlabs.io";
const need = (key: string): string => {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`${key} is required in .env.local`);
  return v;
};
const apiKey = need("ELEVENLABS_API_KEY");
const agentId = need("ELEVENLABS_AGENT_ID");
// A Telnyx number (SIP trunk) takes priority if both are configured.
const provider: "sip_trunk" | "twilio" = process.env.TELNYX_PHONE_NUMBER?.trim() ? "sip_trunk" : "twilio";
const numberKey = provider === "sip_trunk" ? "TELNYX_PHONE_NUMBER" : "TWILIO_PHONE_NUMBER";
const number = normalizeE164(need(numberKey));
if (!number) throw new Error(`${numberKey} is not a phone number. Use the form +15125551234.`);

const importBody = provider === "sip_trunk"
  ? {
      provider: "sip_trunk", label: "Hotline", phone_number: number, agent_id: agentId,
      // ElevenLabs sends outbound calls to Telnyx with the credentials set on the SIP connection.
      outbound_trunk_config: {
        address: process.env.TELNYX_SIP_ADDRESS?.trim() || "sip.telnyx.com",
        transport: "tcp",
        credentials: { username: need("TELNYX_SIP_USERNAME"), password: need("TELNYX_SIP_PASSWORD") },
      },
      // Telnyx inbound trunks do not use digest authentication.
      inbound_trunk_config: {},
    }
  : {
      provider: "twilio", label: "Hotline", phone_number: number, agent_id: agentId,
      sid: need("TWILIO_ACCOUNT_SID"), token: need("TWILIO_AUTH_TOKEN"),
      enable_sms: false, // voice only
    };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method, headers: { "xi-api-key": apiKey, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const masked = number.replace(/\d(?=\d{4})/g, "*");
const existing = await call<{ phone_number_id: string; phone_number: string }[]>("GET", "/v1/convai/phone-numbers");
let id = existing.find((p) => normalizeE164(p.phone_number) === number)?.phone_number_id;

if (id) {
  await call("PATCH", `/v1/convai/phone-numbers/${id}`, { agent_id: agentId });
  console.log(`number   re-assigned  ${id}  ${masked}`);
} else {
  const created = await call<{ phone_number_id: string }>("POST", "/v1/convai/phone-numbers", importBody);
  id = created.phone_number_id;
  console.log(`number   imported     ${id}  ${masked}`);
}

const ENV = ".env.local";
if (existsSync(ENV)) {
  const text = readFileSync(ENV, "utf8");
  if (!/^ELEVENLABS_PHONE_NUMBER_ID=/m.test(text)) appendFileSync(ENV, `ELEVENLABS_PHONE_NUMBER_ID=${id}\nELEVENLABS_PHONE_PROVIDER=${provider}\n`);
  else if (!text.includes(`ELEVENLABS_PHONE_NUMBER_ID=${id}`)) console.log(`note: .env.local has a different ELEVENLABS_PHONE_NUMBER_ID; update it to ${id}`);
}
console.log(`\nInbound calls to ${masked} now reach the Hotline agent.`);
console.log("Outbound approval calls will use it once the server is restarted.");
