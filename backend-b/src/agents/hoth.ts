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
 */
import { getSandbox } from '@cloudflare/sandbox';
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { provisionSkill, resolveSandboxBinding, validateBundle } from '@hoth/core';
import { commentOnIssue, gitHubRefFromConversation } from '../channels/github';
import { MODEL_SPECIFIER } from '../llm';

type Env = {
  Sandbox: DurableObjectNamespace;
  STORE: KVNamespace;
};

export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent<Env>(async ({ id, env }) => {
  // GitHub-channel conversations (id is a channel conversation key, one per
  // issue) answer in the issue thread via the comment tool. No sandbox or
  // bundle: nothing to provision, and a container per issue would be waste.
  const issueRef = gitHubRefFromConversation(id);
  if (issueRef) {
    return {
      model: MODEL_SPECIFIER,
      tools: [commentOnIssue(issueRef)],
      instructions:
        `You are the Hoth travel assistant answering GitHub issues on ${issueRef.owner}/${issueRef.repo}. ` +
        'Each input is a JSON event: a newly opened issue or a follow-up comment on the issue bound to this conversation. ' +
        'Answer the question or request it contains, then post your answer with the comment_on_github_issue tool. ' +
        'Post exactly one comment per event; Markdown is supported. If the request is unclear, post a comment asking for clarification.',
    };
  }

  const raw = await env.STORE.get(`bundle:${id}`);

  // The bundle names the toolchain it needs; that selects the Sandbox binding
  // (plan §16). The bearer KV key is derived from the SAME binding in the
  // ingest route — using different bindings would be a silent KV miss.
  const binding = raw ? resolveSandboxBinding(JSON.parse(raw).baseImage) : 'Sandbox';
  const namespace = (env as Record<string, unknown>)[binding] as Env['Sandbox'];
  const sandbox = getSandbox(namespace, id);

  if (raw) {
    const bundle = validateBundle(raw);
    // Absent→write self-heal: no-op on a warm container, reconstructs after
    // sleep/eviction reset the disk to the (skill-free) image.
    await provisionSkill(sandbox, bundle);
  }

  return {
    model: MODEL_SPECIFIER,
    sandbox: cloudflareSandbox(sandbox),
    cwd: '/workspace',
    instructions:
      'You are a travel assistant. Use the skills available in your workspace for any planning task they cover.',
  };
});
