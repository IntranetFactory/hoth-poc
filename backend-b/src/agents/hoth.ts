/**
 * Backend B agent — dynamic-bundle skill delivery (plan §6).
 *
 * All per-session provisioning happens INSIDE this awaited initializer, which
 * Flue awaits before it scans .agents/skills for discovery — and the harness
 * is rebuilt (and this re-runs) on every message, so B self-heals on every
 * cold container. The ingest route only STORES the bundle; this is the
 * reconstruction site.
 *
 * A bundle is immutable per session id, so reconstruction is always
 * absent→write, never overwrite (plan §6/§8).
 *
 * ONE assistant, many channels: the persona and skill provisioning are shared;
 * a channel only changes where the bundle comes from and how the answer is
 * delivered. Chat sessions read `bundle:<sessionId>` (POSTed by the ingest
 * route) and reply in the conversation; GitHub-issue conversations read the
 * shared `bundle:github-default` and must deliver through the comment tool.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { kvSecretBroker, provisionSkill, resolveSandboxBinding, validateBundle } from '@hoth/core';
import { commentOnIssue, gitHubRefFromConversation } from '../channels/github';
import { MODEL_SPECIFIER } from '../llm';

type Env = {
  Sandbox: DurableObjectNamespace;
  STORE: KVNamespace;
};

const PERSONA =
  'You are the Hoth trip-planner assistant. Use the skills available in your workspace for any planning task they cover.';

export const route: AgentRouteHandler = async (_c, next) => next();

/**
 * Provision the skill bundle stored under `bundleKey` (absent→write self-heal:
 * no-op on a warm container, reconstructs after sleep/eviction reset the disk).
 * The bundle names the toolchain it needs; that selects the Sandbox binding
 * (plan §16) — the bearer KV key must derive from the SAME binding or
 * resolution is a silent KV miss.
 *
 * `bearerTag`: chat sessions get their egress bearer from the ingest route
 * (and its 24 h TTL expiry stays fail-closed, plan §13 C5); channel
 * conversations never pass ingest, so they pass a tag here to self-heal the
 * mapping — mint-if-absent, never rotating a warm one.
 */
async function provisionedSandbox(env: Env, id: string, bundleKey: string, bearerTag?: string) {
  const raw = await env.STORE.get(bundleKey);
  const binding = raw ? resolveSandboxBinding(JSON.parse(raw).baseImage) : 'Sandbox';
  const namespace = (env as Record<string, unknown>)[binding] as Env['Sandbox'];
  const sandbox = getSandbox(namespace, id);

  if (raw) {
    await provisionSkill(sandbox, validateBundle(raw));
    if (bearerTag) {
      const containerId = namespace.idFromName(id).toString();
      const broker = kvSecretBroker(env.STORE);
      if (!(await broker.resolve(containerId))) {
        await broker.put(containerId, `hoth-b-bearer-${bearerTag}-${crypto.randomUUID()}`, bearerTag);
      }
    }
  }

  return { sandbox: cloudflareSandbox(sandbox), cwd: '/workspace' };
}

export default defineAgent<Env>(async ({ id, env }) => {
  // GitHub is just another channel: same persona, same skill (from the shared
  // default bundle), one conversation per issue — plus the delivery rule that
  // answers must be posted back to the issue thread.
  const issueRef = gitHubRefFromConversation(id);
  if (issueRef) {
    return {
      model: MODEL_SPECIFIER,
      ...(await provisionedSandbox(env, id, 'bundle:github-default', 'github')),
      tools: [commentOnIssue(issueRef)],
      instructions:
        `${PERSONA} ` +
        `This conversation is bound to GitHub issue #${issueRef.issueNumber} in ${issueRef.owner}/${issueRef.repo}; ` +
        'each input is a JSON event (a newly opened issue or a new comment). ' +
        'IMPORTANT: the issue author can ONLY see comments you post with the comment_on_github_issue tool — a plain text ' +
        'reply reaches nobody. You MUST finish every event by calling comment_on_github_issue exactly once with your full ' +
        'answer in Markdown. If the request is unclear, post a comment asking for clarification.',
    };
  }

  return {
    model: MODEL_SPECIFIER,
    ...(await provisionedSandbox(env, id, `bundle:${id}`)),
    instructions: PERSONA,
  };
});
