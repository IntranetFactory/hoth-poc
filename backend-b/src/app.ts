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
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  BundleValidationError,
  buildOracleCommand,
  OracleError,
  isValidSessionId,
  kvSecretBroker,
  provisionSkill,
  resolveSandboxBinding,
  validateBundle,
} from '@hoth/core';

type Env = {
  Sandbox: DurableObjectNamespace;
  STORE: KVNamespace;
};

const BUNDLE_TTL_SECONDS = 24 * 60 * 60;

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/health', (c) => c.json({ ok: true, backend: 'b', delivery: 'dynamic-bundle' }));

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

// Deterministic acceptance oracle (plan §13): NOT arbitrary exec — the command
// is built server-side from a bounded op + validated params. Before running it
// this replays EXACTLY the agent initializer's cold-container path — read
// stored bundle, absent→write reconstruction — so cold-recovery is testable
// without an LLM turn.
app.post('/sessions/:id/oracle', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  let command: string;
  try {
    command = buildOracleCommand(await c.req.json<Record<string, unknown>>());
  } catch (err) {
    if (err instanceof OracleError) return c.json({ error: err.message }, 422);
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
  return c.json({ ok: true });
});

app.route('/', flue());

export default app;
