/**
 * POC-wide constants shared by both backends (code sharing only — the
 * backends share no runtime resources, plan §13 C5).
 */

/** The mock Hoth Tourism API (HTTP echo endpoint, plan §7/§14). */
export const ECHO_HOST = 'postman-echo.com';

/**
 * Placeholder the sandbox is given in place of the real Semantius API key. The
 * container only ever holds this sentinel — the real key never enters the
 * sandbox. The catch-all egress handler scans EVERY outbound request header and
 * swaps any header whose value is exactly this sentinel for the real secret
 * (see brokerEgress in egress.js). Keep this value in sync with the
 * `ENV SEMANTIUS_API_KEY` line baked into both backends' Dockerfiles.
 */
export const SEMANTIUS_KEY_SENTINEL = '__sak__';

// The egress whitelist is PER AGENT since the proxy_whitelist refactor:
// agent.jsonc `proxy_whitelist` -> bundle `proxyWhitelist` -> resolved per
// containerId at egress (backend B: KV mapping via putEgressWhitelist;
// backend A: baked build-time meta). An agent without the property gets
// DENY-ALL egress. See core/agent.schema.json and core/src/egress.js.

/** Default LLM settings; override per-worker with the LLM_PROVIDER /
 * LLM_MODEL / LLM_BASE_URL vars and the LLM_API_KEY secret. Provider
 * "cloudflare" uses the Workers AI binding and needs no key. */
export const DEFAULT_LLM = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' };

/**
 * Env-driven LLM setup shared by both backends. Registers any provider
 * override and returns the model specifier to hand to useModel().
 *
 * LLM_PROVIDER: "cloudflare" (AI binding, keyless) | "openrouter" |
 * "custom" (any OpenAI-compatible endpoint at LLM_BASE_URL). LLM_API_KEY and
 * LLM_BASE_URL apply to every provider except "cloudflare". Takes a
 * registerProvider(name, { api?, baseUrl?, apiKey? }) adapter as a parameter
 * so core stays dependency-free — each backend's llm.ts implements it (on
 * Flue v2 via setProvider + Pi's createProvider).
 */
export function configureLlm(registerProvider, env) {
  const provider = env.LLM_PROVIDER || DEFAULT_LLM.provider;
  const model = env.LLM_MODEL || DEFAULT_LLM.model;
  if (provider === 'custom') {
    if (!env.LLM_BASE_URL) throw new Error('LLM_PROVIDER=custom requires LLM_BASE_URL');
    registerProvider('custom', {
      api: 'openai-completions',
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
    });
  } else if (provider !== 'cloudflare' && (env.LLM_API_KEY || env.LLM_BASE_URL)) {
    // Built-in provider: keeps its model catalog, overrides transport/auth.
    registerProvider(provider, {
      ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}),
      ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}),
    });
  }
  return `${provider}/${model}`;
}

/**
 * durable-streams protocol response headers that the browser client MUST be
 * able to read. The Flue agent conversation endpoint (`/agents/:name/:id`)
 * carries the stream cursor in these headers — `Stream-Up-To-Date` and
 * `Stream-Next-Offset` above all. Cross-origin (the frontend Worker and these
 * backend Workers are different origins), the Fetch spec hides every response
 * header from JS EXCEPT the CORS-safelisted ones UNLESS the server names it in
 * `Access-Control-Expose-Headers`. Without this, the long-poll client never
 * observes `Stream-Up-To-Date`, so it never reaches "up-to-date", never
 * advances its offset, never switches to a held long-poll — and busy-polls
 * catch-up reads at network speed forever (a request flood when a stored
 * conversation is opened). curl sees the headers and works; the browser can't.
 * Pass this to Hono's `cors({ exposeHeaders })` in both backends.
 */
export const STREAM_PROTOCOL_HEADERS = [
  'Stream-Next-Offset',
  'Stream-Cursor',
  'Stream-Up-To-Date',
  'Stream-Closed',
  'Stream-Seq',
  'Stream-TTL',
  'Stream-Expires-At',
  'Stream-SSE-Data-Encoding',
  'Producer-Id',
  'Producer-Epoch',
  'Producer-Seq',
  'Producer-Expected-Seq',
  'Producer-Received-Seq',
];

/** Session ids are server-minted lowercase UUIDs (plan §6/§9.6). This shape is
 * a fixed point of the sandbox SDK's sanitizeSandboxId, which keeps
 * `containerId = idFromName(id)` derivable in the Worker. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{6,61}[a-z0-9]$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && !id.startsWith('-') && !id.endsWith('-');
}
