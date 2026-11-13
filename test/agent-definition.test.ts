import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools, buildAgent, TOOL_SECRET_NAME } from "../src/agent/definition.ts";
import { createApp } from "../src/server.ts";
import { setup } from "./helpers.ts";

const BASE = "https://hotline.example.com";
const SECRET_ID = "secret_abc123";
const tools = () => buildTools({ baseUrl: BASE, secretId: SECRET_ID });
const byName = (name: string) => {
  const tool = tools().find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool;
};
const agent = () => buildAgent({ toolIds: ["tool_1", "tool_2"], llm: "claude-sonnet-5-5" });

test("every tool the agent is given exists on the server, and nothing else is offered", async () => {
  const { engine } = setup();
  const app = createApp({ engine, cfg: { secret: "s", ownerNumbers: ["+15125550147"], dashboardToken: "d" } });
  const names = tools().map((t) => t.name).sort();
  assert.deepEqual(names, ["confirm_action", "get_action_status", "get_rules", "get_status", "pause", "propose_action"]);
  for (const tool of tools()) {
    const url = new URL(tool.api_schema.url);
    const res = await app.request(url.pathname, {
      method: tool.api_schema.method, headers: { "x-hotline-secret": "s", "content-type": "application/json" },
      body: JSON.stringify({ caller_id: "+15125550147", conversation_id: "c1", approved: false }),
    });
    assert.notEqual(res.status, 404, `${tool.name} must be a real endpoint`);
  }
});

test("each tool posts to its own endpoint under the base URL, with or without a trailing slash", () => {
  for (const base of [BASE, BASE + "/"]) {
    for (const tool of buildTools({ baseUrl: base, secretId: SECRET_ID })) {
      assert.equal(tool.api_schema.url, `${BASE}/tools/${tool.name}`);
      assert.equal(tool.api_schema.method, "POST");
    }
  }
});

test("the shared secret is sent as a reference to a stored secret, never as a literal", () => {
  for (const tool of tools()) {
    assert.deepEqual(tool.api_schema.request_headers["X-Hotline-Secret"], { secret_id: SECRET_ID });
  }
  assert.equal(TOOL_SECRET_NAME, "hotline_tool_secret");
});

test("who is on the line comes from the platform, not from the model", () => {
  for (const tool of tools()) {
    const props = tool.api_schema.request_body_schema.properties;
    assert.equal(props.caller_id?.dynamic_variable, "system__caller_id");
    assert.equal(props.called_number?.dynamic_variable, "system__called_number");
    assert.equal(props.conversation_id?.dynamic_variable, "system__conversation_id");
    for (const key of ["caller_id", "called_number", "conversation_id"]) {
      assert.equal(props[key]?.description, undefined, `${tool.name}.${key} must not be model-provided`);
    }
  }
});

test("propose_action asks the model for a recipient label and a numeric amount, both required", () => {
  const schema = byName("propose_action").api_schema.request_body_schema;
  assert.equal(schema.properties.to_label?.type, "string");
  assert.equal(schema.properties.amount_usdc?.type, "number");
  assert.ok(schema.properties.to_label?.description);
  assert.ok(schema.properties.amount_usdc?.description);
  assert.ok(schema.required.includes("to_label") && schema.required.includes("amount_usdc"));
});

test("confirm_action requires an explicit approved boolean; the PIN is optional so a no needs none", () => {
  const schema = byName("confirm_action").api_schema.request_body_schema;
  assert.equal(schema.properties.approved?.type, "boolean");
  assert.equal(schema.properties.pin?.type, "string");
  assert.ok(schema.required.includes("approved"));
  assert.ok(!schema.required.includes("pin"));
});

test("tool errors are passed through so the agent can say what the backend said", () => {
  for (const tool of tools()) assert.equal(tool.tool_error_handling_mode, "passthrough");
});

test("the agent can switch language, hang up, and detect voicemail", () => {
  const built = agent().conversation_config.agent.prompt.built_in_tools;
  assert.equal(built.language_detection.params.system_tool_type, "language_detection");
  assert.equal(built.end_call.params.system_tool_type, "end_call");
  assert.equal(built.voicemail_detection.params.system_tool_type, "voicemail_detection");
});

test("the agent is wired to the tool ids and model it was given", () => {
  const prompt = agent().conversation_config.agent.prompt;
  assert.deepEqual(prompt.tool_ids, ["tool_1", "tool_2"]);
  assert.equal(prompt.llm, "claude-sonnet-5-5");
  assert.equal(prompt.temperature, 0);
});

test("the default language is English and the presets cover Mandarin and the other major languages", () => {
  const cfg = agent().conversation_config;
  assert.equal(cfg.agent.language, "en");
  const presets = Object.keys(cfg.language_presets);
  for (const code of ["zh", "es", "hi", "ar", "fr", "pt", "ja", "ko", "de"]) assert.ok(presets.includes(code), `missing ${code}`);
  assert.ok(presets.length >= 20);
  assert.ok(!presets.includes("en"));
});

test("the base speech model is the one ElevenLabs requires for an English-default agent", () => {
  // The platform rejects anything else ("English Agents must use turbo or flash v2") and
  // switches to its v2.5 multilingual model by itself for the preset languages.
  assert.equal(agent().conversation_config.tts.model_id, "eleven_flash_v2");
});

test("every variable used in the prompt or first message has a default", () => {
  const a = agent().conversation_config.agent;
  const used = new Set([...`${a.prompt.prompt}\n${a.first_message}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!));
  const custom = [...used].filter((name) => !name.startsWith("system__"));
  assert.ok(custom.length > 0);
  for (const name of custom) {
    assert.ok(a.dynamic_variables.dynamic_variable_placeholders[name], `no placeholder for ${name}`);
  }
});

test("the prompt carries no wallet address and no digit run that could be a PIN", () => {
  const text = JSON.stringify(agent());
  assert.doesNotMatch(text, /0x[0-9a-fA-F]{40}/);
  assert.doesNotMatch(agent().conversation_config.agent.prompt.prompt, /\d{4,}/);
});

test("the prompt states the rules the agent must never break", () => {
  const p = agent().conversation_config.agent.prompt.prompt;
  assert.match(p, /never (say|repeat|reveal)[^.]*PIN/i);
  assert.match(p, /read back/i);
  assert.match(p, /not_owner/);
  assert.match(p, /dashboard/i);
  assert.match(p, /split/i);
});

test("calls cannot run away: silence ends the call and there is a hard time limit", () => {
  const cfg = agent().conversation_config;
  assert.ok(cfg.turn.silence_end_call_timeout > 0 && cfg.turn.silence_end_call_timeout <= 60);
  assert.ok(cfg.conversation.max_duration_seconds <= 600);
});

test("the call-start webhook is only switched on when asked, since an unreachable hook breaks inbound calls", () => {
  const off = buildAgent({ toolIds: [], llm: "claude-sonnet-5-5" }) as { platform_settings?: unknown };
  assert.equal(off.platform_settings, undefined);
  const on = buildAgent({ toolIds: [], llm: "claude-sonnet-5-5", initiationWebhook: true });
  assert.equal(on.platform_settings?.overrides.enable_conversation_initiation_client_data_from_webhook, true);
});
