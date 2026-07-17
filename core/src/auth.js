/**
 * Shared API-key gate for both backends (app-level auth, plan §9.6 is the
 * production successor). A single shared secret in `env.API_TOKEN`, supplied
 * per-request as `Authorization: Bearer <API_TOKEN>`.
 *
 * Fail-closed: if API_TOKEN is not configured on the Worker, protected routes
 * return 503 rather than silently running wide open. `/health` stays public.
 *
 * This is a gate against outside abuse, NOT per-tenant identity — the token
 * is shared by every caller. Real multi-tenant auth verifies a token → tenant
 * and keys all state by a server-derived id (plan §9.6/§12).
 *
 * Returns a Hono middleware. Usage: `app.use('*', apiKeyGuard())`.
 */
export function apiKeyGuard(options = {}) {
  const publicPaths = new Set(options.publicPaths ?? ['/health']);
  return async (c, next) => {
    if (publicPaths.has(new URL(c.req.url).pathname)) return next();

    const expected = c.env?.API_TOKEN;
    if (!expected) {
      return c.json({ error: 'server not configured: API_TOKEN is unset' }, 503);
    }
    const provided = c.req.header('authorization');
    if (provided !== `Bearer ${expected}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}
