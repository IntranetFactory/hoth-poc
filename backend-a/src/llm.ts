/**
 * LLM provider wiring (runs once at module init). LLM_PROVIDER / LLM_MODEL /
 * LLM_BASE_URL come from wrangler vars, LLM_API_KEY from the worker secret
 * (.dev.vars in local dev). See @hoth/core configureLlm.
 *
 * Flue v2 removed the beta registerProvider(name, opts) API in favor of Pi
 * provider objects (setProvider + createProvider). This adapter keeps
 * @hoth/core's configureLlm contract: it is invoked only when the env
 * overrides a provider's transport/auth.
 */
import { env } from 'cloudflare:workers';
import { setProvider } from '@flue/runtime';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { configureLlm } from '@hoth/core';

const vars = env as Record<string, string | undefined>;

function registerProvider(id: string, opts: { api?: string; baseUrl?: string; apiKey?: string }): void {
  const auth = {
    apiKey: {
      name: 'LLM_API_KEY',
      resolve: async () => ({ auth: opts.apiKey ? { apiKey: opts.apiKey } : {} }),
    },
  };

  if (id === 'openrouter') {
    // Built-in provider: keeps its model catalog, overrides transport/auth.
    const models = openrouterProvider()
      .getModels()
      .map((model) => (opts.baseUrl ? { ...model, baseUrl: opts.baseUrl } : model));
    setProvider(createProvider({ id, auth, models, api: openAICompletionsApi() }));
    return;
  }

  // 'custom': any OpenAI-compatible endpoint at LLM_BASE_URL — a one-model
  // catalog built from the env (the beta API needed no catalog; Pi does).
  const model = vars.LLM_MODEL ?? '';
  setProvider(
    createProvider({
      id,
      auth,
      models: [
        {
          id: model,
          name: model,
          api: 'openai-completions',
          provider: id,
          baseUrl: opts.baseUrl ?? '',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
}

export const MODEL_SPECIFIER: string = configureLlm(registerProvider, vars);

/** Default endpoints for providers an agent may select via its `model` prefix. */
const PROVIDER_BASE_URLS: Record<string, string | undefined> = {
  openrouter: 'https://openrouter.ai/api/v1',
  custom: vars.LLM_BASE_URL,
};

export type AgentLlm = { agentName: string; model?: string; modelBaseUrl?: string };

/**
 * Per-agent model resolution. No overrides -> the env-derived default.
 * Any override -> register a dedicated one-model provider `agent-<name>`
 * (unique id per agent, so concurrent agents in one isolate never clobber
 * each other; setProvider replaces same-id registrations, so re-registering
 * on every render is idempotent) and return `agent-<name>/<modelId>`. A
 * dedicated catalog entry also avoids Pi catalog misses for models the
 * built-in openrouter catalog doesn't know. Auth stays the worker-wide
 * LLM_API_KEY secret — model_base_url overrides transport only.
 */
export function agentModelSpecifier(agent?: AgentLlm | null): string {
  if (!agent || (!agent.model && !agent.modelBaseUrl)) return MODEL_SPECIFIER;
  // The bundler pre-normalizes `model` to a full provider/model specifier.
  const spec = agent.model ?? MODEL_SPECIFIER;
  const slash = spec.indexOf('/');
  const upstreamProvider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  if (upstreamProvider === 'cloudflare') return spec; // AI binding; no base-url override

  const id = `agent-${agent.agentName}`;
  const auth = {
    apiKey: {
      name: 'LLM_API_KEY',
      resolve: async () => ({ auth: vars.LLM_API_KEY ? { apiKey: vars.LLM_API_KEY } : {} }),
    },
  };
  setProvider(
    createProvider({
      id,
      auth,
      models: [
        {
          id: modelId,
          name: modelId,
          api: 'openai-completions',
          provider: id,
          baseUrl: agent.modelBaseUrl ?? vars.LLM_BASE_URL ?? PROVIDER_BASE_URLS[upstreamProvider] ?? '',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
  return `${id}/${modelId}`;
}
