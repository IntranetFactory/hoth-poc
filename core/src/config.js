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

/**
 * Egress domain whitelist for the catch-all secret broker (brokerEgress). A
 * request may leave the sandbox — and is eligible for the __sak__ → real-key
 * swap — only when its host matches one of these globs. Everything else is
 * rejected, including a sentinel-bearing request to a non-whitelisted host,
 * which is treated as an exfiltration attempt (the real key is never sent
 * there). `*.<domain>` matches any subdomain of <domain>, not the bare apex.
 */
export const DOMAIN_WHITELIST = ['*.semantius.ai'];

/** Default LLM settings; override per-worker with the LLM_PROVIDER /
 * LLM_MODEL / LLM_BASE_URL vars and the LLM_API_KEY secret. Provider
 * "cloudflare" uses the Workers AI binding and needs no key. */
export const DEFAULT_LLM = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' };

/**
 * Env-driven LLM setup shared by both backends. Registers any provider
 * override with Flue and returns the model specifier to hand to defineAgent.
 *
 * LLM_PROVIDER: "cloudflare" (AI binding, keyless) | "openrouter" |
 * "custom" (any OpenAI-compatible endpoint at LLM_BASE_URL). LLM_API_KEY and
 * LLM_BASE_URL apply to every provider except "cloudflare". Takes Flue's
 * registerProvider as a parameter so core stays dependency-free.
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

/** Session ids are server-minted lowercase UUIDs (plan §6/§9.6). This shape is
 * a fixed point of the sandbox SDK's sanitizeSandboxId, which keeps
 * `containerId = idFromName(id)` derivable in the Worker. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{6,61}[a-z0-9]$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && !id.startsWith('-') && !id.endsWith('-');
}
