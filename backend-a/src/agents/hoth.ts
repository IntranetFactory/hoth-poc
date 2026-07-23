'use agent';
/**
 * Backend A agent — hard-coded / OOTB skill delivery (plan §6).
 *
 * The skill is already in the container image (Dockerfile COPY), so the agent
 * only attaches the per-session sandbox; Flue's init-time discovery finds
 * /workspace/.agents/skills/hoth-trip-planner in the image with no writes and
 * no bundle.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { type AgentProps, useModel, useSandbox } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { MODEL_SPECIFIER } from '../llm';

type Env = {
  Sandbox: DurableObjectNamespace;
};

export function Hoth({ id }: AgentProps) {
  useModel(MODEL_SPECIFIER);
  const { Sandbox } = env as unknown as Env;
  useSandbox(cloudflareSandbox(getSandbox(Sandbox, id)), { cwd: '/workspace' });
  return 'You are a travel assistant. Use the skills available in your workspace for any planning task they cover.';
}

// Pin the durable identity to the beta agent name: keeps the generated class
// FlueHothAgent (no renamed_classes migration) and the /agents/hoth mount name.
Hoth.agentName = 'hoth';
