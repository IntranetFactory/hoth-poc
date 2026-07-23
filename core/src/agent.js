/**
 * Agent bundle format and server-side validation of untrusted agent bundles.
 *
 * An agent bundle is the one-JSON-string unit of delivery for backend B: it
 * carries the agent's merged instructions, optional model overrides, and ALL
 * of its skills (0..maxSkills). It is built by scripts/bundle.mjs from an
 * agents/<name>/ folder (agent.jsonc + optional INSTRUCTIONS.md +
 * skills/<skill>/...) — see agents/agent.schema.json for the config contract.
 *
 * @typedef {Object} AgentBundle
 * @property {string} agentName    lowercase/hyphens, <=64, matches agents/ folder name
 * @property {string} version      content hash over config + all skill files
 * @property {string} baseImage    toolchain the agent needs; selects the Sandbox binding
 * @property {string} instructions merged agent.jsonc instructions + INSTRUCTIONS.md
 * @property {string} [model]      normalized provider/model specifier
 * @property {string} [modelBaseUrl] OpenAI-compatible endpoint override
 * @property {string[]} [proxyWhitelist] egress allow list (host globs); DENY-ALL when absent/empty
 * @property {Record<string, Record<string, string>>} skills skillName -> (rel-path -> utf-8 content)
 */

import {
  BUNDLE_LIMITS,
  BundleValidationError,
  SKILL_NAME_RE,
  validateFilesMap,
} from './bundle.js';

/** Providers the model prefix rule recognizes (first '/'-segment of `model`). */
export const KNOWN_MODEL_PROVIDERS = ['openrouter', 'custom', 'cloudflare'];

export const AGENT_LIMITS = {
  maxSkills: 16,
  maxInstructionsBytes: 64 * 1024,
  maxAgentTotalBytes: 4 * 1024 * 1024,
  maxBaseUrlChars: 512,
  maxWhitelistHosts: 32,
};

/** Exact host or `*.suffix` wildcard, lowercase (see isWhitelistedHost). */
const WHITELIST_HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Validate a proxy_whitelist / proxyWhitelist value: an array of host globs.
 * DENY-ALL SEMANTICS live at the egress seam — this only checks shape.
 *
 * @param {unknown} raw
 * @param {string} label
 * @returns {string[]}
 */
function validateWhitelist(raw, label) {
  if (!Array.isArray(raw)) throw new BundleValidationError(`${label} must be an array of host globs`);
  if (raw.length > AGENT_LIMITS.maxWhitelistHosts) {
    throw new BundleValidationError(`${label}: too many hosts (${raw.length} > ${AGENT_LIMITS.maxWhitelistHosts})`);
  }
  for (const host of raw) {
    if (typeof host !== 'string' || host.length === 0 || host.length > 255 || !WHITELIST_HOST_RE.test(host)) {
      throw new BundleValidationError(`${label}: invalid host glob: ${String(host)} (exact host or *.suffix, lowercase)`);
    }
  }
  return raw;
}

/**
 * Model prefix rule: a specifier whose first path segment is a known provider
 * is used as-is; anything else gets the default `openrouter/` prefix, so plain
 * OpenRouter ids like `deepseek/deepseek-v4-flash` work unqualified.
 *
 * @param {string} model
 * @returns {string} full provider/model specifier
 */
export function normalizeModelSpecifier(model) {
  const first = model.split('/', 1)[0];
  return KNOWN_MODEL_PROVIDERS.includes(first) ? model : `openrouter/${model}`;
}

/**
 * Validate a parsed agent.jsonc against the contract in
 * agents/agent.schema.json. Unknown keys are rejected so typos and
 * not-yet-supported keys (future egress allow list etc.) fail at bundle time.
 *
 * @param {unknown} raw
 * @returns {{ instructions?: string, model?: string, model_base_url?: string }}
 */
export function validateAgentConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BundleValidationError('agent.jsonc must be a JSON object');
  }
  const config = /** @type {Record<string, unknown>} */ (raw);
  const allowed = ['$schema', 'instructions', 'model', 'model_base_url', 'proxy_whitelist'];
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) {
      throw new BundleValidationError(`agent.jsonc has unknown key: ${key} (allowed: ${allowed.join(', ')})`);
    }
  }
  if (config.instructions !== undefined && (typeof config.instructions !== 'string' || config.instructions.length === 0)) {
    throw new BundleValidationError('agent.jsonc "instructions" must be a non-empty string when present');
  }
  if (config.model !== undefined && (typeof config.model !== 'string' || config.model.length === 0)) {
    throw new BundleValidationError('agent.jsonc "model" must be a non-empty string when present');
  }
  if (config.model_base_url !== undefined && (typeof config.model_base_url !== 'string' || !/^https?:\/\//.test(config.model_base_url))) {
    throw new BundleValidationError('agent.jsonc "model_base_url" must be an http(s) URL when present');
  }
  if (config.proxy_whitelist !== undefined) {
    validateWhitelist(config.proxy_whitelist, 'agent.jsonc "proxy_whitelist"');
  }
  return config;
}

/**
 * Merge agent.jsonc instructions with the optional INSTRUCTIONS.md text
 * (appended after). An agent must end up with SOME instructions.
 *
 * @param {string | undefined} configInstructions
 * @param {string | undefined} instructionsMd
 * @returns {string}
 */
export function mergeInstructions(configInstructions, instructionsMd) {
  const merged = [configInstructions, instructionsMd]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!merged) {
    throw new BundleValidationError('agent has no instructions (agent.jsonc "instructions" and INSTRUCTIONS.md both absent/empty)');
  }
  return merged;
}

/**
 * Validate an untrusted agent bundle before storing or reconstructing it —
 * the server-side gate on backend B's ingest route. Same defensive posture as
 * the old single-skill validateBundle: path traversal, caps, required
 * SKILL.md per skill, plus agent-level shape (instructions, model,
 * modelBaseUrl) and the ustar 100-char entry-name limit so a hostile path
 * fails here (422) instead of inside makeTar (500).
 *
 * @param {unknown} raw bundle object or its JSON string
 * @returns {AgentBundle} the validated bundle (same object, narrowed)
 */
export function validateAgentBundle(raw) {
  if (typeof raw === 'string') raw = JSON.parse(raw);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BundleValidationError('agent bundle must be a JSON object');
  }
  const bundle = /** @type {Record<string, unknown>} */ (raw);

  const agentName = bundle.agentName;
  if (typeof agentName !== 'string' || agentName.length === 0 || agentName.length > 64 || !SKILL_NAME_RE.test(agentName)) {
    throw new BundleValidationError('agentName must be lowercase letters/numbers/hyphens, 1-64 chars, no leading/trailing/consecutive hyphens');
  }
  if (typeof bundle.version !== 'string' || bundle.version.length === 0 || bundle.version.length > 128) {
    throw new BundleValidationError('version must be a non-empty string');
  }
  if (typeof bundle.baseImage !== 'string' || bundle.baseImage.length === 0 || bundle.baseImage.length > 64) {
    throw new BundleValidationError('baseImage must be a non-empty string');
  }
  if (typeof bundle.instructions !== 'string' || bundle.instructions.trim().length === 0) {
    throw new BundleValidationError('instructions must be a non-empty string');
  }
  if (utf8Length(bundle.instructions) > AGENT_LIMITS.maxInstructionsBytes) {
    throw new BundleValidationError(`instructions too large (> ${AGENT_LIMITS.maxInstructionsBytes} bytes)`);
  }
  if (bundle.model !== undefined) {
    if (typeof bundle.model !== 'string' || !bundle.model.includes('/') || bundle.model.startsWith('/')) {
      throw new BundleValidationError('model must be a provider/model specifier (normalize before bundling)');
    }
  }
  if (bundle.modelBaseUrl !== undefined) {
    if (
      typeof bundle.modelBaseUrl !== 'string' ||
      !/^https?:\/\//.test(bundle.modelBaseUrl) ||
      bundle.modelBaseUrl.length > AGENT_LIMITS.maxBaseUrlChars
    ) {
      throw new BundleValidationError('modelBaseUrl must be an http(s) URL');
    }
  }
  if (bundle.proxyWhitelist !== undefined) {
    validateWhitelist(bundle.proxyWhitelist, 'proxyWhitelist');
  }

  const skills = bundle.skills;
  if (skills === null || typeof skills !== 'object' || Array.isArray(skills)) {
    throw new BundleValidationError('skills must be an object of skillName -> files map');
  }
  const skillEntries = Object.entries(skills);
  if (skillEntries.length > AGENT_LIMITS.maxSkills) {
    throw new BundleValidationError(`too many skills (${skillEntries.length} > ${AGENT_LIMITS.maxSkills})`);
  }
  let total = 0;
  for (const [skillName, files] of skillEntries) {
    if (skillName.length === 0 || skillName.length > 64 || !SKILL_NAME_RE.test(skillName)) {
      throw new BundleValidationError(`invalid skill name: ${skillName}`);
    }
    total += validateFilesMap(files, {
      label: `skill ${skillName}`,
      // tar entries are named `<skillName>/<relPath>` by provisionAgentSkills
      tarPrefix: `${skillName}/`,
    });
  }
  if (total > AGENT_LIMITS.maxAgentTotalBytes) {
    throw new BundleValidationError(`agent bundle too large (${total} > ${AGENT_LIMITS.maxAgentTotalBytes})`);
  }

  return /** @type {AgentBundle} */ (bundle);
}

function utf8Length(str) {
  return new TextEncoder().encode(str).length;
}
