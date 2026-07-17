#!/usr/bin/env node
/**
 * Node smoke test (plan §2/§11.7): proves the core skill flow —
 * bundle → validate → provision (reconstruct) → discoverable layout →
 * script executes and calls the API — runs with ZERO Cloudflare present.
 *
 * The sandbox seam is satisfied by a local-fs adapter (Node fs + child
 * shell), state is in-memory, and there is no egress broker: the "API" is a
 * local HTTP echo server, so the test is fully offline. No import in this
 * file or in @hoth/core touches anything Cloudflare.
 */
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

// Child processes that call back into the in-process echo server must run
// async — a sync exec blocks the event loop and deadlocks the server.
const execFile = promisify(execFileCb);
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBundleFromDir } from '../core/src/node.js';
import { provisionSkill } from '../core/src/provision.js';
import { validateBundle, BundleValidationError } from '../core/src/bundle.js';

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, '..', 'backend-a', 'skills', 'hoth-trip-planner');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

// --- local sandbox adapter over a temp "workspace" (the sandbox seam) -----
const workspace = mkdtempSync(join(tmpdir(), 'hoth-smoke-'));
const localSandbox = {
  async writeFile(path, content) {
    const real = join(workspace, path.replace(/^\//, ''));
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, content, 'utf-8');
  },
  async exec(command) {
    // Rebase the absolute container paths onto the temp workspace and run
    // through a POSIX shell (Git Bash ships one on Windows).
    const rebased = command
      .replaceAll('/workspace/', `${workspace.replaceAll('\\', '/')}/workspace/`)
      .replaceAll("'/tmp/", `'${workspace.replaceAll('\\', '/')}/tmp/`);
    try {
      const stdout = execFileSync('bash', ['-lc', rebased], { encoding: 'utf-8' });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (err) {
      return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
    }
  },
};

// --- local echo server (no internet, no egress broker) ---------------------
const echo = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers, json: safeParse(body), url: req.url }));
  });
});
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
const echoUrl = `http://127.0.0.1:${echo.address().port}/post`;

try {
  // 1. bundle + round-trip is exercised by the bundler; here: create + validate
  const bundle = createBundleFromDir(skillDir);
  check('bundle created & valid', bundle.skillName === 'hoth-trip-planner' && Object.keys(bundle.files).length >= 4);

  // 2. hostile bundles rejected before reconstruction (plan §8/§13)
  for (const [label, mutate] of [
    ['path traversal ..', (b) => ({ ...b, files: { ...b.files, '../evil.md': 'x' } })],
    ['absolute path', (b) => ({ ...b, files: { ...b.files, '/etc/passwd': 'x' } })],
    ['backslash path', (b) => ({ ...b, files: { ...b.files, 'refs\\evil.md': 'x' } })],
    ['missing SKILL.md', (b) => ({ ...b, files: { 'references/only.md': 'x' } })],
    ['oversize file', (b) => ({ ...b, files: { ...b.files, 'big.md': 'x'.repeat(300 * 1024) } })],
  ]) {
    let rejected = false;
    try { validateBundle(mutate(structuredClone(bundle))); } catch (err) { rejected = err instanceof BundleValidationError; }
    check(`hostile bundle rejected: ${label}`, rejected);
  }

  // 3. clean base: skills dir starts empty (absent)
  check('clean base (no skill before provision)', !existsSync(join(workspace, 'workspace/.agents/skills/hoth-trip-planner')));

  // 4. provision: absent → reconstructed
  const first = await provisionSkill(localSandbox, bundle);
  check('provision reconstructs on absent dir', first.reconstructed === true);

  // 5. byte-identical reconstruction (single-source check, C3 shape)
  let identical = true;
  for (const [relPath, content] of Object.entries(bundle.files)) {
    const real = join(workspace, 'workspace/.agents/skills/hoth-trip-planner', ...relPath.split('/'));
    if (!existsSync(real) || readFileSync(real, 'utf-8') !== content) identical = false;
  }
  check('reconstructed files byte-identical to bundle', identical);

  // 6. immutable-per-id: second provision is a no-op (present)
  const second = await provisionSkill(localSandbox, bundle);
  check('re-provision is absent→write only (no overwrite)', second.reconstructed === false);

  // 7. the skill script runs from the reconstructed dir and calls the API
  const scriptPath = join(workspace, 'workspace/.agents/skills/hoth-trip-planner/scripts/opening-times.js');
  const { stdout } = await execFile(
    process.execPath,
    [scriptPath, '--sites=Echo Base Thermal Springs', '--from=2026-08-01', '--to=2026-08-02'],
    { encoding: 'utf-8', env: { ...process.env, HOTH_API_URL: echoUrl }, timeout: 30000 },
  );
  const parsed = JSON.parse(stdout);
  check(
    'script runs from reconstructed skill and returns opening times',
    parsed[0]?.site_id === 'echo_base_thermal_springs' && parsed[0]?.opening_times?.length === 2,
  );

  // 8. the script sent NO Authorization header (zero-trust shape)
  const { stdout: debugOut } = await execFile(
    process.execPath,
    [scriptPath, '--sites=Echo Base Thermal Springs', '--from=2026-08-01', '--to=2026-08-01', '--debug-echo'],
    { encoding: 'utf-8', env: { ...process.env, HOTH_API_URL: echoUrl }, timeout: 30000 },
  );
  const received = JSON.parse(debugOut).upstream_received_headers ?? {};
  check('container-side request carries no Authorization header', !('authorization' in received));
} finally {
  echo.close();
  rmSync(workspace, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nnode smoke test: ALL PASS (zero Cloudflare imports)' : `\nnode smoke test: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
