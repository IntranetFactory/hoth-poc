/**
 * Backend A agent — hard-coded / OOTB skill delivery (plan §6).
 *
 * The skill is already in the container image (Dockerfile COPY), so the
 * initializer only attaches the per-session sandbox; Flue's discovery pass
 * finds /workspace/.agents/skills/hoth-trip-planner in the image with no
 * writes and no bundle.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { DEFAULT_MODEL } from '@hoth/core';

type Env = {
  Sandbox: DurableObjectNamespace;
  MODEL?: string;
};

export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent<Env>(({ id, env }) => ({
  model: env.MODEL || DEFAULT_MODEL,
  sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
  cwd: '/workspace',
  instructions:
    'You are a travel assistant. Use the skills available in your workspace for any planning task they cover.',
}));
