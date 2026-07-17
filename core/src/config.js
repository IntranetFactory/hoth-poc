/**
 * POC-wide constants shared by both backends (code sharing only — the
 * backends share no runtime resources, plan §13 C5).
 */

/** The mock Hoth Tourism API (HTTP echo endpoint, plan §7/§14). */
export const ECHO_HOST = 'postman-echo.com';

/** Default model; override per-worker with the MODEL var. Workers AI models
 * need no API key on the Cloudflare target. */
export const DEFAULT_MODEL = 'cloudflare/@cf/moonshotai/kimi-k2.6';

/** Session ids are server-minted lowercase UUIDs (plan §6/§9.6). This shape is
 * a fixed point of the sandbox SDK's sanitizeSandboxId, which keeps
 * `containerId = idFromName(id)` derivable in the Worker. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{6,61}[a-z0-9]$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && !id.startsWith('-') && !id.endsWith('-');
}
