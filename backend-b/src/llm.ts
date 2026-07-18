/**
 * LLM provider wiring (runs once at module init). LLM_PROVIDER / LLM_MODEL /
 * LLM_BASE_URL come from wrangler vars, LLM_API_KEY from the worker secret
 * (.dev.vars in local dev). See @hoth/core configureLlm.
 */
import { env } from 'cloudflare:workers';
import { registerProvider } from '@flue/runtime';
import { configureLlm } from '@hoth/core';

export const MODEL_SPECIFIER: string = configureLlm(
  registerProvider,
  env as Record<string, string | undefined>,
);
