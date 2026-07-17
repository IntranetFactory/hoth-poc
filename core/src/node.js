/**
 * Node-only helpers (fs access): the bundler library and round-trip assert.
 * Kept out of ./index.js so the Workers backends never import node:fs.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { validateBundle } from './bundle.js';

export * from './index.js';

/**
 * Walk a skill folder into the one-JSON-string bundle (plan §5).
 * `version` is a content hash over sorted rel-paths + contents, so a changed
 * skill is a visibly different bundle (and must be a new session id, §6).
 *
 * @param {string} dir path to the skill folder (its basename = skillName)
 * @param {{ skillName?: string, baseImage?: string }} [options]
 * @returns {import('./bundle.js').SkillBundle}
 */
export function createBundleFromDir(dir, options = {}) {
  const skillName = options.skillName ?? dir.replaceAll('\\', '/').split('/').filter(Boolean).at(-1);
  const files = {};
  for (const relPath of walk(dir)) {
    // Read as utf-8; normalize path separators so bundles built on Windows
    // are byte-identical to the Docker COPY of the same folder (plan §13 C3).
    files[relPath.split(sep).join('/')] = readFileSync(join(dir, relPath), 'utf-8');
  }
  const hash = createHash('sha256');
  for (const relPath of Object.keys(files).sort()) {
    hash.update(relPath).update('\0').update(files[relPath]).update('\0');
  }
  const bundle = {
    skillName,
    version: hash.digest('hex').slice(0, 16),
    baseImage: options.baseImage ?? 'node',
    files,
  };
  return validateBundle(bundle);
}

/**
 * Round-trip assert (plan §5): bundle -> reconstruct -> byte-identical to the
 * source folder. Throws on any drift.
 *
 * @param {string} sourceDir
 * @param {import('./bundle.js').SkillBundle} bundle
 * @param {string} scratchDir temp directory to reconstruct into
 */
export function assertRoundTrip(sourceDir, bundle, scratchDir) {
  const outDir = join(scratchDir, `roundtrip-${bundle.skillName}-${bundle.version}`);
  for (const [relPath, content] of Object.entries(bundle.files)) {
    const target = join(outDir, ...relPath.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  const sourceFiles = walk(sourceDir).map((p) => p.split(sep).join('/')).sort();
  const rebuiltFiles = walk(outDir).map((p) => p.split(sep).join('/')).sort();
  if (JSON.stringify(sourceFiles) !== JSON.stringify(rebuiltFiles)) {
    throw new Error(`round-trip file set mismatch:\n  source: ${sourceFiles}\n  rebuilt: ${rebuiltFiles}`);
  }
  for (const relPath of sourceFiles) {
    const a = readFileSync(join(sourceDir, ...relPath.split('/')));
    const b = readFileSync(join(outDir, ...relPath.split('/')));
    if (!a.equals(b)) throw new Error(`round-trip byte mismatch: ${relPath}`);
  }
  return { files: sourceFiles.length, outDir };
}

/** Per-file sha256 of bundle values, for the C3 triple-hash comparison. */
export function bundleFileHashes(bundle) {
  const hashes = {};
  for (const relPath of Object.keys(bundle.files).sort()) {
    hashes[relPath] = createHash('sha256').update(bundle.files[relPath]).digest('hex');
  }
  return hashes;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink not allowed in skill folder: ${full}`);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) {
      if (statSync(full).size === 0) throw new Error(`empty file in skill folder: ${full}`);
      out.push(relative(base, full));
    }
  }
  return out;
}
