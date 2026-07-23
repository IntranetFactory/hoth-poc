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
