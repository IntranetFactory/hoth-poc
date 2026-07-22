/**
 * Egress/Secret broker seam (plan §2/§7): the one capability Flue does not
 * abstract. The POC ships only the Cloudflare (outbound-handler) consumer of
 * this interface; a Docker egress-proxy sidecar is future work behind the
 * same seam.
 *
 * The broker resolves per-container credentials at egress time. The sandbox
 * never holds the raw token; handlers must resolve from containerId on EVERY
 * invocation — no closure/module caching (plan §7/§9.2: the handler registry
 * is isolate-global, caching bleeds across concurrent sessions).
 *
 * @typedef {Object} SecretBroker
 * @property {(containerId: string) => Promise<{ bearer: string, tenantTag: string | null } | null>} resolve
 * @property {(containerId: string, bearer: string, tenantTag: string | null, ttlSeconds?: number) => Promise<void>} put
 * @property {(containerId: string) => Promise<void>} remove
 */

export const BEARER_KEY_PREFIX = 'bearer:';
export const TAG_KEY_PREFIX = 'tag:';
export const DEFAULT_SECRET_TTL_SECONDS = 24 * 60 * 60;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Does `host` match a single whitelist glob? Supports an exact host or a
 * `*.suffix` subdomain wildcard. `*.semantius.ai` matches `tests.semantius.ai`
 * but NOT the bare apex `semantius.ai`, nor look-alikes like
 * `evil-semantius.ai` or `tests.semantius.ai.evil.com` (the leading dot in the
 * suffix is load-bearing).
 */
function hostMatchesPattern(host, pattern) {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // keep the leading dot: ".semantius.ai"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return false;
}

/** True when `host` matches any glob in `whitelist` (see DOMAIN_WHITELIST). */
export function isWhitelistedHost(host, whitelist) {
  return whitelist.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * Catch-all secret broker with a domain whitelist (plan §7 secret-at-egress).
 * The container holds only the placeholder `sentinel`; the real key lives here
 * in the Worker and never enters the sandbox. Policy per outbound request:
 *
 *   host whitelisted + sentinel present -> swap sentinel→secret in every header, forward
 *   host whitelisted + no sentinel      -> forward as-is (e.g. follow-up JWT calls)
 *   host NOT whitelisted                -> reject (a sentinel here is an
 *                                          exfiltration attempt — never leak the key)
 *
 * Matching is by substring, not whole-value equality: semantius sends the key
 * on an MCP `Authorization: Bearer <key>` header, so the value is
 * `Bearer __sak__` — replacing just the sentinel span preserves the `Bearer `
 * scheme; a bare `__sak__` value becomes exactly `secret`.
 *
 * @param {Request} request
 * @param {{ whitelist: string[], sentinel: string, secret: string | undefined }} policy
 * @param {typeof fetch} fetchImpl
 */
export async function brokerEgress(request, policy, fetchImpl = fetch) {
  const { whitelist, sentinel, secret } = policy;
  const host = new URL(request.url).hostname;
  const headers = new Headers(request.headers);
  // Collect first, then set — mutating Headers mid-iteration is unsafe.
  const hits = [];
  for (const [name, value] of headers) {
    if (value.includes(sentinel)) hits.push([name, value]);
  }

  if (!isWhitelistedHost(host, whitelist)) {
    // Deny by default. If the request carried the sentinel this is an attempt to
    // send the real key somewhere it shouldn't go — reject WITHOUT swapping.
    return jsonResponse(403, {
      error: hits.length
        ? 'egress denied: credential sentinel present but host not in whitelist'
        : 'egress denied: host not in whitelist',
      host,
    });
  }

  // Whitelisted host, no credential to inject: legitimate follow-up traffic
  // (e.g. JWT-bearing MCP calls). Forward unchanged.
  if (hits.length === 0) return fetchImpl(request);

  if (!secret) {
    // Never forward the raw placeholder.
    return jsonResponse(503, { error: 'egress misconfigured: no real secret bound server-side' });
  }
  for (const [name, value] of hits) headers.set(name, value.replaceAll(sentinel, secret));
  return fetchImpl(new Request(request, { headers }));
}

/**
 * KV-backed SecretBroker (the Cloudflare implementation of the seam).
 * `kv` is anything with get/put/delete(key) — a Workers KV namespace binding,
 * or an in-memory Map adapter in tests.
 *
 * @param {{ get(k: string): Promise<string | null>, put(k: string, v: string, o?: object): Promise<void>, delete(k: string): Promise<void> }} kv
 * @returns {SecretBroker}
 */
export function kvSecretBroker(kv) {
  return {
    async resolve(containerId) {
      const bearer = await kv.get(BEARER_KEY_PREFIX + containerId);
      if (!bearer) return null; // fail closed (plan §13 C5)
      const tenantTag = await kv.get(TAG_KEY_PREFIX + containerId);
      return { bearer, tenantTag: tenantTag ?? null };
    },
    async put(containerId, bearer, tenantTag, ttlSeconds = DEFAULT_SECRET_TTL_SECONDS) {
      // TTL + delete-on-session-end: defence-in-depth even though ids are unique (plan §7)
      await kv.put(BEARER_KEY_PREFIX + containerId, bearer, { expirationTtl: ttlSeconds });
      if (tenantTag) await kv.put(TAG_KEY_PREFIX + containerId, tenantTag, { expirationTtl: ttlSeconds });
    },
    async remove(containerId) {
      await kv.delete(BEARER_KEY_PREFIX + containerId);
      await kv.delete(TAG_KEY_PREFIX + containerId);
    },
  };
}

/**
 * Build the egress response for an intercepted request: inject the
 * per-container bearer (and tenant tag) that the sandbox never held, or fail
 * closed when no mapping exists. Host-agnostic — the Cloudflare outbound
 * handler calls this with its own fetch.
 *
 * @param {Request} request
 * @param {SecretBroker} broker
 * @param {string} containerId
 * @param {typeof fetch} fetchImpl
 */
export async function injectAndForward(request, broker, containerId, fetchImpl = fetch) {
  const creds = await broker.resolve(containerId);
  if (!creds) {
    return new Response(
      JSON.stringify({ error: 'egress denied: no credential mapping for this container' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${creds.bearer}`);
  if (creds.tenantTag) headers.set('x-tenant-tag', creds.tenantTag);
  return fetchImpl(new Request(request, { headers }));
}
