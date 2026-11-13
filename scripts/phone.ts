// Attaches your Twilio number to the Hotline agent on ElevenLabs, for inbound and outbound calls.
// Idempotent: if the number is already imported it is just re-assigned to the agent.
//
//   npm run phone
//
// Sends the Twilio Account SID and Auth Token to ElevenLabs, which is how its native Twilio
// integration works. Prints ids and a masked number only.

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
const sid = need("TWILIO_ACCOUNT_SID");
const token = need("TWILIO_AUTH_TOKEN");
const number = normalizeE164(need("TWILIO_PHONE_NUMBER"));
if (!number) throw new Error("TWILIO_PHONE_NUMBER is not a phone number. Use the form +15125551234.");

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
  const created = await call<{ phone_number_id: string }>("POST", "/v1/convai/phone-numbers", {
    provider: "twilio", label: "Hotline", phone_number: number, sid, token, agent_id: agentId,
    enable_sms: false, // trial numbers and unregistered US SMS do not mix; voice only
  });
  id = created.phone_number_id;
  console.log(`number   imported     ${id}  ${masked}`);
}

const ENV = ".env.local";
if (existsSync(ENV)) {
  const text = readFileSync(ENV, "utf8");
  if (!/^ELEVENLABS_PHONE_NUMBER_ID=/m.test(text)) appendFileSync(ENV, `ELEVENLABS_PHONE_NUMBER_ID=${id}\n`);
  else if (!text.includes(`ELEVENLABS_PHONE_NUMBER_ID=${id}`)) console.log(`note: .env.local has a different ELEVENLABS_PHONE_NUMBER_ID; update it to ${id}`);
}
console.log(`\nInbound calls to ${masked} now reach the Hotline agent.`);
console.log("Outbound approval calls will use it once the server is restarted.");
