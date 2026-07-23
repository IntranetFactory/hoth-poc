#!/usr/bin/env node
/**
 * Agent bundler CLI (plan §5): scans the top-level agents/ folder, builds one
 * agent bundle per agents/<name>/ that has an agent.jsonc (folders without it
 * are skipped with a warning), asserts each bundle round-trips byte-identical,
 * and emits the artifacts where the consumers pick them up:
 *   - dist-bundle/<name>.agent.json                 (canonical artifacts)
 *   - frontend/src/generated/agents/<name>.json     (import.meta.glob'd by the UI)
 *   - backend-a/src/generated/agent.json            (meta only — instructions/
 *     model for the fixed hoth-trip-planner agent; skills reach A's image via
 *     the Dockerfile COPY of the same folder, so no file content is inlined
 *     into A's worker bundle)
 *
 * The SAME agents/<name>/skills folder backend A bakes into its image is the
 * input — agent defined once, all consumers derive from it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentBundleFromDir, assertAgentRoundTrip, scanAgentsDir, skillFileHashes } from '../core/src/node.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(root, 'agents');

/** The one agent backend A bakes into its image. */
const BACKEND_A_AGENT = 'hoth-trip-planner';

const { agents, skipped } = scanAgentsDir(agentsDir);
for (const name of skipped) console.warn(`skipping agents/${name} (no agent.jsonc)`);
if (agents.length === 0) {
  console.error('no agents found — every agents/<name>/ needs an agent.jsonc');
  process.exit(1);
}

// Clean output dirs so removed agents disappear from the frontend; drop
// artifacts of the pre-multi-agent layout if they linger.
rmSync(join(root, 'frontend', 'src', 'generated', 'agents'), { recursive: true, force: true });
rmSync(join(root, 'frontend', 'src', 'generated', 'hoth-bundle.json'), { force: true });
rmSync(join(root, 'backend-a', 'dist-bundle'), { recursive: true, force: true });

const bundles = new Map();
const scratch = mkdtempSync(join(tmpdir(), 'hoth-bundle-'));
try {
  for (const name of agents) {
    const agentDir = join(agentsDir, name);
    const bundle = createAgentBundleFromDir(agentDir);
    const { files, skills } = assertAgentRoundTrip(agentDir, bundle, scratch);
    console.log(`${name}: round-trip OK (${skills} skills, ${files} files byte-identical)`);
    bundles.set(name, bundle);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

for (const [name, bundle] of bundles) {
  const json = JSON.stringify(bundle);
  const outputs = [
    join(root, 'dist-bundle', `${name}.agent.json`),
    join(root, 'frontend', 'src', 'generated', 'agents', `${name}.json`),
  ];
  for (const out of outputs) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json, 'utf-8');
    console.log(`wrote ${out}`);
  }
  console.log(`  agentName: ${bundle.agentName}`);
  console.log(`  version:   ${bundle.version}`);
  console.log(`  baseImage: ${bundle.baseImage}`);
  if (bundle.model) console.log(`  model:     ${bundle.model}`);
  if (bundle.modelBaseUrl) console.log(`  baseUrl:   ${bundle.modelBaseUrl}`);
  const fileCount = Object.values(bundle.skills).reduce((n, files) => n + Object.keys(files).length, 0);
  console.log(`  skills:    ${Object.keys(bundle.skills).join(', ') || '(none)'} — ${fileCount} files, ${json.length} bytes as JSON`);
  for (const [skillName, files] of Object.entries(bundle.skills)) {
    console.log(`  per-file sha256 (${skillName}, C3 triple-hash reference):`);
    for (const [path, hash] of Object.entries(skillFileHashes(files))) {
      console.log(`    ${hash}  ${path}`);
    }
  }
}

// Backend A's build-time meta for its fixed agent — fail hard if it is gone.
const backendAAgent = bundles.get(BACKEND_A_AGENT);
if (!backendAAgent) {
  console.error(`agents/${BACKEND_A_AGENT} is required (backend A bakes this agent into its image)`);
  process.exit(1);
}
const metaOut = join(root, 'backend-a', 'src', 'generated', 'agent.json');
mkdirSync(dirname(metaOut), { recursive: true });
writeFileSync(
  metaOut,
  JSON.stringify({
    agentName: backendAAgent.agentName,
    version: backendAAgent.version,
    instructions: backendAAgent.instructions,
    ...(backendAAgent.model ? { model: backendAAgent.model } : {}),
    ...(backendAAgent.modelBaseUrl ? { modelBaseUrl: backendAAgent.modelBaseUrl } : {}),
  }),
  'utf-8',
);
console.log(`wrote ${metaOut} (backend-a build-time meta)`);
