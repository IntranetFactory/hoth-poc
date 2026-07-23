/**
 * Skill-catalog extraction: parse each bundled skill's SKILL.md frontmatter
 * into `{ name, description }` entries so backend B can mount them explicitly
 * with `useSkill(...)`. This is the second, sandbox-independent leg of skill
 * delivery: the files are ALSO provisioned into `/workspace/.agents/skills/`
 * (provision.js) for Flue's workspace discovery and for on-disk execution of
 * skill resources, but the model-visible catalog must not depend on the
 * sandbox filesystem being observable at session-init time (it measurably is
 * not: fully provisioned B sessions produced system prompts with an empty
 * catalog — see README "Skill delivery to the model").
 *
 * Deliberately a minimal YAML subset with no dependency: top-level
 * `key: value` scalars plus folded/literal block scalars (`>-`, `>`, `|`,
 * `|-`) — the shapes agents/<name>/skills/<skill>/SKILL.md files actually
 * use. Frontmatter this parser cannot read yields no catalog entry rather
 * than a failed bundle; the file-level validation in agent.js stays the
 * strict gate.
 */

/** Flue's SkillDefinition cap; longer descriptions are truncated, not fatal. */
export const SKILL_DESCRIPTION_MAX = 1024;

/**
 * Parse a SKILL.md's YAML frontmatter into a flat string map.
 *
 * @param {string} content full SKILL.md text
 * @returns {Record<string, string>} top-level scalar entries ({} when absent)
 */
export function parseSkillFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return {};
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return {};
  const lines = normalized.slice(4, end).split('\n');
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (/^[>|]-?$/.test(rest)) {
      // Block scalar: consume the indented block; fold with spaces for `>`,
      // keep line breaks for `|`.
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        parts.push(lines[i + 1].trim());
        i++;
      }
      out[key] = parts.join(rest.startsWith('>') ? ' ' : '\n').trim();
    } else {
      out[key] = rest.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return out;
}

/**
 * Build the mountable skill catalog for a validated agent bundle.
 *
 * The entry name is the skill FOLDER name (the runtime requires definition
 * names to match `[a-z0-9-]`, which bundle validation already enforces for
 * folder names); a frontmatter `name` is informational only. Skills whose
 * SKILL.md yields no description are skipped — a catalog line without a
 * trigger description would never be activated anyway.
 *
 * @param {{ skills?: Record<string, Record<string, string>> }} bundle
 * @returns {Array<{ name: string, description: string }>} sorted by name
 */
export function skillCatalogFromBundle(bundle) {
  const entries = [];
  for (const [folderName, files] of Object.entries(bundle.skills ?? {})) {
    const skillMd = files?.['SKILL.md'];
    if (typeof skillMd !== 'string') continue;
    const description = (parseSkillFrontmatter(skillMd).description ?? '').slice(0, SKILL_DESCRIPTION_MAX);
    if (!description) continue;
    entries.push({ name: folderName, description });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
