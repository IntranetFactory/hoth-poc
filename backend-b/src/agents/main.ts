'use agent';
/**
 * Backend B agent — the generic MULTI-AGENT host (dynamic bundle delivery,
 * plan §6). Which agent a session runs is not code: it is the agent bundle
 * (instructions + model + skills) POSTed at session creation and stored under
 * `agent:<sessionId>`. This one Flue agent hosts them all.
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
 * ONE host, many channels: bundle-driven instructions, model, and skill
 * provisioning are shared; a channel only changes where the bundle comes from
 * and how the answer is delivered. Chat sessions read `agent:<sessionId>`
 * (POSTed by the ingest route) and reply in the conversation; GitHub-issue
 * conversations read the shared `agent:github-default` and must deliver
 * through the comment tool.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import {
  type AgentProps,
  useAgentStart,
  useInitialData,
  useModel,
  usePersistentState,
  useSandbox,
  useTool,
} from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import {
  kvSecretBroker,
  provisionAgentSkills,
  putEgressWhitelist,
  resolveSandboxBinding,
  validateAgentBundle,
} from '@hoth/core';
import { commentOnIssue, gitHubRefFromConversation } from '../channels/github';
import { agentModelSpecifier } from '../llm';

type Env = {
  Sandbox: DurableObjectNamespace;
  STORE: KVNamespace;
};

/** Sessions whose bundle is missing (expired TTL, pre-ingest message). */
const DEFAULT_INSTRUCTIONS =
  'You are a helpful assistant. Use the skills available in your workspace for any task they cover.';

/**
 * The per-session agent identity the render needs but cannot await from KV:
 * instructions, model overrides, and the Sandbox binding derived from
 * baseImage. It reaches the render on two paths:
 *  - `useInitialData` — the meta the creating send carried (frontend chat /
 *    GitHub dispatch), present from the FIRST render on. Load-bearing:
 *    `usePersistentState` writes made in `useAgentStart` only land after the
 *    submission's first model turn (the system prompt is rebuilt BEFORE the
 *    start seam runs; Flue then narrates "System instructions updated."), so
 *    without a seed, turn 1 would run on the generic default instructions.
 *  - `usePersistentState` — set by the start callback from the KV bundle
 *    (authoritative; covers instances created without a seed, and the
 *    re-seedable `agent:github-default`). Preferred once present. The
 *    `version` field is the change detector.
 */
type AgentMeta = {
  agentName: string;
  version: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
  binding: string;
};

/** The creating send's `initialData` — bundle meta with baseImage, no files. */
type AgentSeed = Omit<AgentMeta, 'binding'> & { baseImage?: string };

/** Untrusted (client-supplied) seed -> AgentMeta, or null when unusable. */
function metaFromSeed(seed: AgentSeed | undefined): AgentMeta | null {
  if (!seed || typeof seed.instructions !== 'string' || seed.instructions.length === 0) return null;
  let binding = 'Sandbox';
  try {
    binding = resolveSandboxBinding(seed.baseImage);
  } catch {
    // Unknown baseImage in a hand-crafted seed: fall back to the default
    // binding instead of failing every render of this conversation forever.
  }
  return {
    agentName: String(seed.agentName ?? 'unknown'),
    version: String(seed.version ?? ''),
    instructions: seed.instructions,
    ...(typeof seed.model === 'string' ? { model: seed.model } : {}),
    ...(typeof seed.modelBaseUrl === 'string' ? { modelBaseUrl: seed.modelBaseUrl } : {}),
    binding,
  };
}

export function Main({ id }: AgentProps) {
  const { STORE } = env as unknown as Env;

  // GitHub is just another channel: same bundle-driven identity (from the
  // shared default bundle), one conversation per issue — plus the delivery
  // rule that answers must be posted back to the issue thread. Chat sessions
  // get their egress bearer from the ingest route (24 h TTL stays fail-closed,
  // plan §13 C5); channel conversations never pass ingest, so they self-heal
  // the mapping here — mint-if-absent, never rotating a warm one.
  const issueRef = gitHubRefFromConversation(id);
  const bundleKey = issueRef ? 'agent:github-default' : `agent:${id}`;
  const bearerTag = issueRef ? 'github' : undefined;

  // Two-path identity resolution (see AgentMeta docs): the persisted meta is
  // authoritative once the start callback lands it; the creation seed covers
  // the first submission's renders. Null (env-default model, 'Sandbox'
  // binding, generic instructions) covers sessions with neither.
  const seed = useInitialData<AgentSeed | undefined>();
  const [meta, setMeta] = usePersistentState<AgentMeta | null>('agentMeta', null);
  const active = meta ?? metaFromSeed(seed);
  useModel(agentModelSpecifier(active));
  const namespace = (env as unknown as Record<string, DurableObjectNamespace>)[active?.binding ?? 'Sandbox'];
  useSandbox(cloudflareSandbox(getSandbox(namespace, id)), { cwd: '/workspace' });

  useAgentStart(async () => {
    const raw = await STORE.get(bundleKey);
    if (!raw) return;
    const bundle = validateAgentBundle(raw);
    const binding = resolveSandboxBinding(bundle.baseImage);
    if (meta?.version !== bundle.version || meta?.binding !== binding) {
      setMeta({
        agentName: bundle.agentName,
        version: bundle.version,
        instructions: bundle.instructions,
        ...(bundle.model ? { model: bundle.model } : {}),
        ...(bundle.modelBaseUrl ? { modelBaseUrl: bundle.modelBaseUrl } : {}),
        binding,
      });
    }
    const ns = (env as unknown as Record<string, DurableObjectNamespace>)[binding];
    const containerId = ns.idFromName(id).toString();

    // Absent→write self-heal: no-op on a warm container, reconstructs after
    // sleep/eviction reset the disk. Zero-skill agents provision nothing.
    await provisionAgentSkills(getSandbox(ns, id), bundle);

    // Egress-whitelist self-heal: re-map the bundle's proxy_whitelist for this
    // container (covers channel conversations that never pass ingest, and
    // expired TTLs on long-lived sessions). Deleted sessions never reach here
    // — their bundle is gone, so the early return above keeps them deny-all.
    await putEgressWhitelist(STORE, containerId, bundle.proxyWhitelist ?? []);

    if (bearerTag) {
      const broker = kvSecretBroker(STORE);
      if (!(await broker.resolve(containerId))) {
        await broker.put(containerId, `hoth-b-bearer-${bearerTag}-${crypto.randomUUID()}`, bearerTag);
      }
    }
  });

  const instructions = active?.instructions ?? DEFAULT_INSTRUCTIONS;

  if (issueRef) {
    useTool(commentOnIssue(issueRef));
    return (
      `${instructions} ` +
      `This conversation is bound to GitHub issue #${issueRef.issueNumber} in ${issueRef.owner}/${issueRef.repo}; ` +
      'each input is a JSON event (a newly opened issue or a new comment). ' +
      'IMPORTANT: the issue author can ONLY see comments you post with the comment_on_github_issue tool — a plain text ' +
      'reply reaches nobody. You MUST finish every event by calling comment_on_github_issue exactly once with your full ' +
      'answer in Markdown. If the request is unclear, post a comment asking for clarification.'
    );
  }

  return instructions;
}

// The generic multi-agent host: durable identity `main` (generated DO class
// FlueMainAgent, wrangler migration v4) and the /agents/main mount name.
Main.agentName = 'main';
