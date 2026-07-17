#!/usr/bin/env node
/**
 * Bundler CLI (plan §5): walks the canonical skill folder into the
 * one-JSON-string dynamic bundle, asserts the round trip is byte-identical,
 * and emits the bundle where backend B's consumers pick it up:
 *   - dist-bundle/hoth-trip-planner.bundle.json  (canonical artifact)
 *   - ../frontend/src/generated/hoth-bundle.json (imported by the POC UI)
 *
 * The SAME folder backend A bakes into its image is the input — skill
 * defined once, two consumers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBundleFromDir, assertRoundTrip, bundleFileHashes } from '@hoth/core/node';

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, '..', 'skills', 'hoth-trip-planner');

const bundle = createBundleFromDir(skillDir);
const json = JSON.stringify(bundle);

const scratch = mkdtempSync(join(tmpdir(), 'hoth-bundle-'));
try {
  const { files } = assertRoundTrip(skillDir, bundle, scratch);
  console.log(`round-trip OK: ${files} files byte-identical`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const outputs = [
  join(here, '..', 'dist-bundle', 'hoth-trip-planner.bundle.json'),
  join(here, '..', '..', 'frontend', 'src', 'generated', 'hoth-bundle.json'),
];
for (const out of outputs) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json, 'utf-8');
  console.log(`wrote ${out}`);
}

console.log(`skillName: ${bundle.skillName}`);
console.log(`version:   ${bundle.version}`);
console.log(`baseImage: ${bundle.baseImage}`);
console.log(`files:     ${Object.keys(bundle.files).length}, ${json.length} bytes as JSON`);
console.log('per-file sha256 (C3 triple-hash reference):');
for (const [path, hash] of Object.entries(bundleFileHashes(bundle))) {
  console.log(`  ${hash}  ${path}`);
}
