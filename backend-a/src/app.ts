/**
 * Backend A HTTP app.
 *
 * A is a STATIC agent (plan §6/§13 C1): no skill ingest route exists — the
 * skill is served purely from the image. A still shares the egress/secret
 * seam by design, so POST /sessions/:id/provision seeds the single static
 * bearer mapping KV[containerId] = STATIC_BEARER before the first prompt
 * (the frontend awaits the 2xx before chatting).
 */
import { getSandbox } from '@cloudflare/sandbox';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { apiKeyGuard, buildSkillCheckCommand, SkillCheckError, kvSecretBroker, isValidSessionId } from '@hoth/core';

type Env = {
  Sandbox: DurableObjectNamespace;
  SECRETS: KVNamespace;
  STATIC_BEARER: string;
  API_TOKEN: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());
// Every route except /health requires Authorization: Bearer <API_TOKEN>.
// Fail-closed if API_TOKEN is unset (503). This covers the flue() agent/stream
// routes too, since the guard runs before app.route('/', flue()).
app.use('*', apiKeyGuard());

app.get('/health', (c) => c.json({ ok: true, backend: 'a', delivery: 'image-baked' }));

app.post('/sessions/:id/provision', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);

  // Derive the container id exactly as the SDK does (plan §7): our ids are a
  // fixed point of sanitizeSandboxId, so idFromName(id) is the SDK's identity.
  const containerId = c.env.Sandbox.idFromName(id).toString();
  const broker = kvSecretBroker(c.env.SECRETS);
  await broker.put(containerId, c.env.STATIC_BEARER, 'static-a');

  return c.json({ ok: true, backend: 'a', sessionId: id, containerId });
});

// Deterministic skill-check (plan §13): drives the fixed core commands in this
// session's sandbox, isolating the A/B comparison from LLM nondeterminism. NOT
// arbitrary exec — the command is built server-side from a bounded op + strictly
// validated params (see @hoth/core buildSkillCheckCommand). Behind the API-key
// guard like every other route.
app.post('/sessions/:id/skill-check', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  let command: string;
  try {
    command = buildSkillCheckCommand(await c.req.json());
  } catch (err) {
    if (err instanceof SkillCheckError) return c.json({ error: err.message }, 422);
    throw err;
  }
  const sandbox = getSandbox(c.env.Sandbox, id);
  const result = await sandbox.exec(command, { cwd: '/workspace' });
  return c.json({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
});

app.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidSessionId(id)) return c.json({ error: 'invalid session id' }, 400);
  const containerId = c.env.Sandbox.idFromName(id).toString();
  await kvSecretBroker(c.env.SECRETS).remove(containerId);
  return c.json({ ok: true });
});

app.route('/', flue());

export default app;
