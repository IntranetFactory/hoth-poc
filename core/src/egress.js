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
