'use agent';
/**
 * Backend A agent — hard-coded / OOTB skill delivery (plan §6).
 *
 * A is the FIXED single-agent backend: it always serves the hoth-trip-planner
 * agent from agents/hoth-trip-planner/. Its skills are already in the
 * container image (Dockerfile COPY of the agent's skills/ folder), so the
 * agent only attaches the per-session sandbox; Flue's init-time discovery
 * finds /workspace/.agents/skills/<skill> in the image with no writes and no
 * bundle. Instructions and model come from the bundler-generated meta
 * (src/generated/agent.json, written by `pnpm bundle` from the same agent
 * folder) — resolved at BUILD time, matching the baked-image delivery model.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { type AgentProps, useModel, useSandbox } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import agent from '../generated/agent.json';
import { agentModelSpecifier } from '../llm';

type Env = {
  Sandbox: DurableObjectNamespace;
};

export function Hoth({ id }: AgentProps) {
  useModel(agentModelSpecifier(agent));
  const { Sandbox } = env as unknown as Env;
  useSandbox(cloudflareSandbox(getSandbox(Sandbox, id)), { cwd: '/workspace' });
  return agent.instructions;
}

// Pin the durable identity to the beta agent name: keeps the generated class
// FlueHothAgent (no renamed_classes migration) and the /agents/hoth mount name.
Hoth.agentName = 'hoth';
