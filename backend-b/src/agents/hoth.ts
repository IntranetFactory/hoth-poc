'use agent';
/**
 * Backend B agent — dynamic-bundle skill delivery (plan §6).
 *
 * All per-session provisioning happens INSIDE the useAgentStart callback,
 * which Flue awaits on every delivered message before the model runs (and
 * before init-time skill discovery reads the sandbox) — so B self-heals on
 * every cold container. The ingest route only STORES the bundle; this is the
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
import { env } from 'cloudflare:workers';
import {
  type AgentProps,
  useAgentStart,
  useModel,
  usePersistentState,
  useSandbox,
  useTool,
} from '@flue/runtime';
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

export function Hoth({ id }: AgentProps) {
  useModel(MODEL_SPECIFIER);
  const { STORE } = env as unknown as Env;

  // GitHub is just another channel: same persona, same skill (from the shared
  // default bundle), one conversation per issue — plus the delivery rule that
  // answers must be posted back to the issue thread. Chat sessions get their
  // egress bearer from the ingest route (24 h TTL stays fail-closed, plan §13
  // C5); channel conversations never pass ingest, so they self-heal the
  // mapping here — mint-if-absent, never rotating a warm one.
  const issueRef = gitHubRefFromConversation(id);
  const bundleKey = issueRef ? 'bundle:github-default' : `bundle:${id}`;
  const bearerTag = issueRef ? 'github' : undefined;

  // The Sandbox binding derives from the bundle's baseImage (plan §16) — a KV
  // read hooks can't await. The start callback below resolves and persists it,
  // and the re-render before the model call attaches the right namespace; the
  // bearer KV key must derive from the SAME binding or resolution is a silent
  // KV miss. 'Sandbox' is the beta fallback for sessions with no bundle.
  const [binding, setBinding] = usePersistentState<string | null>('sandboxBinding', null);
  const namespace = (env as unknown as Record<string, DurableObjectNamespace>)[binding ?? 'Sandbox'];
  useSandbox(cloudflareSandbox(getSandbox(namespace, id)), { cwd: '/workspace' });

  useAgentStart(async () => {
    const raw = await STORE.get(bundleKey);
    if (!raw) return;
    const resolved = resolveSandboxBinding((JSON.parse(raw) as { baseImage: string }).baseImage);
    if (binding !== resolved) setBinding(resolved);
    const ns = (env as unknown as Record<string, DurableObjectNamespace>)[resolved];

    // Absent→write self-heal: no-op on a warm container, reconstructs after
    // sleep/eviction reset the disk.
    await provisionSkill(getSandbox(ns, id), validateBundle(raw));

    if (bearerTag) {
      const containerId = ns.idFromName(id).toString();
      const broker = kvSecretBroker(STORE);
      if (!(await broker.resolve(containerId))) {
        await broker.put(containerId, `hoth-b-bearer-${bearerTag}-${crypto.randomUUID()}`, bearerTag);
      }
    }
  });

  if (issueRef) {
    useTool(commentOnIssue(issueRef));
    return (
      `${PERSONA} ` +
      `This conversation is bound to GitHub issue #${issueRef.issueNumber} in ${issueRef.owner}/${issueRef.repo}; ` +
      'each input is a JSON event (a newly opened issue or a new comment). ' +
      'IMPORTANT: the issue author can ONLY see comments you post with the comment_on_github_issue tool — a plain text ' +
      'reply reaches nobody. You MUST finish every event by calling comment_on_github_issue exactly once with your full ' +
      'answer in Markdown. If the request is unclear, post a comment asking for clarification.'
    );
  }

  return PERSONA;
}

// Pin the durable identity to the beta agent name: keeps the generated class
// FlueHothAgent (no renamed_classes migration) and the /agents/hoth mount name.
Hoth.agentName = 'hoth';
