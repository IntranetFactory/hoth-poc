/**
 * Backend B HTTP app — the dynamic-bundle ingest surface (plan §6/§8).
 *
 * POST /sessions/:id/skills:
 *  (a) validates the untrusted bundle before anything else,
 *  (b) stores it keyed by session id (read back by the agent initializer),
 *  (c) mints a per-session bearer + tenant tag and writes the
 *      KV[containerId] mapping the outbound handler resolves at egress,
 *  (d) pre-warms: eagerly boots the container and reconstructs the skill so
 *      the 1-3 s cold boot overlaps the user typing (plan §15 P1).
 *
 * The route STORES the bundle — reconstruction also lives in the initializer,
 * which self-heals every cold container. A bundle is immutable per id: a
 * reused id is rejected (plan §6/§13 C5).
 */
import { getSandbox } from '@cloudflare/sandbox';
import { getRun, listRuns } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  apiKeyGuard,
  BundleValidationError,
  buildSkillCheckCommand,
  SkillCheckError,
  isValidSessionId,
  kvSecretBroker,
  putSessionIndex,
  removeSessionIndex,
  adminCollections,
  listCollectionRecords,
  readCollectionRecord,
  provisionSkill,
  resolveSandboxBinding,
  validateBundle,
} from '@hoth/core';
import { channel } from './channels/github';

type Env = {
  Sandbox: DurableObjectNamespace;
  STORE: KVNamespace;
  API_TOKEN: string;
};

const BUNDLE_TTL_SECONDS = 24 * 60 * 60;

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// GitHub webhook (POST /channels/github/webhook). Registered BEFORE the API
// key guard: GitHub can't send our bearer — the channel authenticates each
// delivery itself via X-Hub-Signature-256 over the raw body.
for (const route of channel.routes) {
  app.on(route.method, `/channels/github${route.path}`, route.handler);
}

// Every route except /health requires Authorization: Bearer <API_TOKEN>.
// Fail-closed if API_TOKEN is unset (503). Covers the flue() agent/stream
// routes too, since the guard runs before app.route('/', flue()).
app.use('*', apiKeyGuard());

app.get('/health', (c) => c.json({ ok: true, backend: 'b', delivery: 'dynamic-bundle' }));

// Read-only data browser (behind the API-key guard). Presents every backing
// store as a generic collection so the frontend is a plain entities -> records
// -> record tree. Never mutates. `deps` injects the KV binding and the Flue run
// registry API (getRun/listRuns) into the host-agnostic core resolver.
const adminDeps = (c: { env: Env }) => ({ kv: c.env.STORE, listRuns: () => listRuns({ limit: 100 }), getRun });
app.get('/admin/collections', (c) => c.json({ backend: 'b', collections: adminCollections('STORE') }));
app.get('/admin/collections/:cid/records', async (c) => {
  const result = await listCollectionRecords(c.req.param('cid'), adminDeps(c));
  if (!result) return c.json({ error: 'unknown collection' }, 404);
  return c.json(result);
});
app.get('/admin/collections/:cid/record', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id query param required' }, 400);
  const record = await readCollectionRecord(c.req.param('cid'), id, adminDeps(c));
  if (!record) return c.json({ error: 'not found' }, 404);
  return c.json(record);
});

app.post('/sessions/:id/skills', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);

  // Session-id uniqueness guard: a bundle is immutable per id (plan §6).
  if (await c.env.STORE.get(`bundle:${id}`)) {
    return c.json({ error: 'session id already has a bundle; a changed skill is a new session id' }, 409);
  }

  let bundle;
  let tenantTag: string;
  try {
    const body = (await c.req.json()) as { bundle?: unknown; tenantTag?: unknown };
    bundle = validateBundle(body.bundle ?? body);
    tenantTag =
      typeof body.tenantTag === 'string' && /^[a-z0-9-]{1,64}$/.test(body.tenantTag)
        ? body.tenantTag
        : `tenant-${id.slice(0, 8)}`;
  } catch (err) {
    if (err instanceof BundleValidationError || err instanceof SyntaxError) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 422);
    }
    throw err;
  }

  // Select the Sandbox binding from the bundle's baseImage; BOTH getSandbox
  // and the bearer KV key must derive from this same binding (plan §7/§16).
  const binding = resolveSandboxBinding(bundle.baseImage);
  const namespace = (c.env as unknown as Record<string, DurableObjectNamespace>)[binding];
  const containerId = namespace.idFromName(id).toString();

  const bearer = `hoth-b-bearer-${id.slice(0, 8)}-${crypto.randomUUID()}`;
  await c.env.STORE.put(`bundle:${id}`, JSON.stringify(bundle), { expirationTtl: BUNDLE_TTL_SECONDS });
  await kvSecretBroker(c.env.STORE).put(containerId, bearer, tenantTag);

  // Index the session so the data browser can enumerate conversations without
  // knowing ids upfront (best-effort — never fail provisioning over the index).
  await putSessionIndex(c.env.STORE, id, {
    backend: 'b',
    containerId,
    tenantTag,
    skillName: bundle.skillName,
    version: bundle.version,
    createdAt: new Date().toISOString(),
  }).catch(() => {});

  // Pre-warm + eager reconstruction (plan §8/§15 P1). The initializer will
  // find the dir present and no-op; on a later cold container it re-creates.
  const provision = await provisionSkill(getSandbox(namespace, id), bundle);

  return c.json({
    ok: true,
    backend: 'b',
    sessionId: id,
    containerId,
    skillName: bundle.skillName,
    version: bundle.version,
    tenantTag,
    reconstructed: provision.reconstructed,
  });
});

// Deterministic skill-check (plan §13): NOT arbitrary exec — the command is
// built server-side from a bounded op + validated params. Before running it
// this replays EXACTLY the agent initializer's cold-container path — read
// stored bundle, absent→write reconstruction — so cold-recovery is testable
// without an LLM turn. Behind the API-key guard like every other route.
app.post('/sessions/:id/skill-check', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  let command: string;
  try {
    command = buildSkillCheckCommand(await c.req.json<Record<string, unknown>>());
  } catch (err) {
    if (err instanceof SkillCheckError) return c.json({ error: err.message }, 422);
    throw err;
  }

  const raw = await c.env.STORE.get(`bundle:${id}`);
  const binding = raw ? resolveSandboxBinding((JSON.parse(raw) as { baseImage: string }).baseImage) : 'Sandbox';
  const namespace = (c.env as unknown as Record<string, DurableObjectNamespace>)[binding];
  const sandbox = getSandbox(namespace, id);
  let reconstructed = false;
  if (raw) {
    reconstructed = (await provisionSkill(sandbox, validateBundle(raw))).reconstructed;
  }

  const result = await sandbox.exec(command, { cwd: '/workspace' });
  return c.json({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, reconstructed });
});

app.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  const containerId = c.env.Sandbox.idFromName(id).toString();
  await kvSecretBroker(c.env.STORE).remove(containerId);
  await c.env.STORE.delete(`bundle:${id}`);
  await removeSessionIndex(c.env.STORE, id).catch(() => {});
  return c.json({ ok: true });
});

app.route('/', flue());

export default app;
