// Gets a short-lived token that lets the browser open a voice session with the agent.
// The ElevenLabs API key stays on the server; the browser only ever sees the token.

export function createTokenProvider(opts: { apiKey: string; agentId: string; fetch?: typeof fetch }): () => Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  return async () => {
    const res = await doFetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(opts.agentId)}`,
      { headers: { "xi-api-key": opts.apiKey } },
    );
    if (!res.ok) throw new Error(`conversation token request failed with status ${res.status}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error("conversation token response had no token");
    return body.token;
  };
}
