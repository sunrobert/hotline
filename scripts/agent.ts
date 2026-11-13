// Creates or updates the Hotline voice agent on ElevenLabs from src/agent/definition.ts.
// Idempotent and stateless: everything is found by name, so re-running updates in place.
//
//   npm run agent                 # uses PUBLIC_URL from .env.local
//   PUBLIC_URL=https://... npm run agent
//
// Sends HOTLINE_SECRET to ElevenLabs' secret store so tool calls can carry it. Prints ids only.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { buildTools, buildAgent, TOOL_SECRET_NAME } from "../src/agent/definition.ts";

const API = "https://api.elevenlabs.io";
const apiKey = process.env.ELEVENLABS_API_KEY;
const toolSecret = process.env.HOTLINE_SECRET;
const baseUrl = process.env.PUBLIC_URL || "https://hotline-not-deployed.invalid";
const llm = process.env.AGENT_LLM || "claude-sonnet-5-5";
const agentName = process.env.AGENT_NAME || "Hotline";

if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required");
if (!toolSecret) throw new Error("HOTLINE_SECRET is required");

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { "xi-api-key": apiKey!, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// 1. The shared secret, stored on ElevenLabs and referenced by id from each tool.
const { secrets } = await call<{ secrets: { secret_id: string; name: string }[] }>("GET", "/v1/convai/secrets");
let secretId = secrets.find((s) => s.name === TOOL_SECRET_NAME)?.secret_id;
if (secretId) {
  await call("PATCH", `/v1/convai/secrets/${secretId}`, { type: "update", name: TOOL_SECRET_NAME, value: toolSecret });
  console.log(`secret   updated  ${secretId}`);
} else {
  secretId = (await call<{ secret_id: string }>("POST", "/v1/convai/secrets", { type: "new", name: TOOL_SECRET_NAME, value: toolSecret })).secret_id;
  console.log(`secret   created  ${secretId}`);
}

// 2. The six webhook tools.
const existingTools = (await call<{ tools: { id: string; tool_config: { name: string; type: string } }[] }>("GET", "/v1/convai/tools")).tools;
const toolIds: string[] = [];
for (const tool of buildTools({ baseUrl, secretId })) {
  const found = existingTools.find((t) => t.tool_config.name === tool.name && t.tool_config.type === "webhook");
  if (found) {
    await call("PATCH", `/v1/convai/tools/${found.id}`, { tool_config: tool });
    toolIds.push(found.id);
    console.log(`tool     updated  ${found.id}  ${tool.name}`);
  } else {
    const created = await call<{ id: string }>("POST", "/v1/convai/tools", { tool_config: tool });
    toolIds.push(created.id);
    console.log(`tool     created  ${created.id}  ${tool.name}`);
  }
}

// 3. The agent.
// Inbound calls ask the backend who is calling. Only wire that up once the backend has a real address.
const deployed = !baseUrl.endsWith(".invalid");
if (deployed) {
  await call("PATCH", "/v1/convai/settings", {
    conversation_initiation_client_data_webhook: {
      url: `${baseUrl.replace(/\/+$/, "")}/hooks/conversation-init`,
      request_headers: { "X-Hotline-Secret": { secret_id: secretId } },
    },
  });
  console.log("webhook  call-start hook set");
}
const definition = buildAgent({ toolIds, llm, name: agentName, initiationWebhook: deployed });
const { agents } = await call<{ agents: { agent_id: string; name: string }[] }>("GET", `/v1/convai/agents?search=${encodeURIComponent(agentName)}`);
let agentId = agents.find((a) => a.name === agentName)?.agent_id;
if (agentId) {
  await call("PATCH", `/v1/convai/agents/${agentId}`, definition);
  console.log(`agent    updated  ${agentId}`);
} else {
  agentId = (await call<{ agent_id: string }>("POST", "/v1/convai/agents/create", definition)).agent_id;
  console.log(`agent    created  ${agentId}`);
}

// Remember the id locally for the backend and other scripts.
const ENV = ".env.local";
if (existsSync(ENV) && !/^ELEVENLABS_AGENT_ID=/m.test(readFileSync(ENV, "utf8"))) {
  appendFileSync(ENV, `ELEVENLABS_AGENT_ID=${agentId}\n`);
}

console.log(`\nllm        ${llm}`);
console.log(`tools ->   ${baseUrl}/tools/*${baseUrl.endsWith(".invalid") ? "   (placeholder: set PUBLIC_URL once the backend is deployed, then re-run)" : ""}`);
console.log(`languages  en + ${Object.keys(definition.conversation_config.language_presets).length} more`);
console.log(`dashboard  https://elevenlabs.io/app/agents/agents/${agentId}`);
