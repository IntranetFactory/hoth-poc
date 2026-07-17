import { validateBundle } from './bundle.js';
import { makeTarGz, toBase64 } from './tar.js';

/**
 * The sandbox seam: anything that can write a file and run a shell command.
 * Satisfied by the @cloudflare/sandbox client, and by the local-fs adapter
 * in the Node smoke test — no Cloudflare types appear here.
 *
 * @typedef {Object} SandboxLike
 * @property {(command: string) => Promise<{ exitCode?: number, success?: boolean, stdout?: string, stderr?: string }>} exec
 * @property {(path: string, content: string) => Promise<unknown>} writeFile
 */

export const SKILLS_DIR = '/workspace/.agents/skills';

/**
 * Reconstruct a validated skill bundle into the sandbox (plan §6/§8).
 *
 * Absent→write only: a bundle is immutable per session id, so an existing
 * skill dir means this id was already materialized — never overwrite.
 * Exactly 2 RPCs: writeFile of one base64 tar.gz blob, then a single exec
 * that checks-and-extracts atomically and removes the blob.
 *
 * Safe to call from both the ingest route (pre-warm, plan §8/P1) and the
 * agent initializer (cold-container self-heal, plan §6) — same-id calls
 * converge on the same immutable content.
 *
 * @param {SandboxLike} sandbox
 * @param {import('./bundle.js').SkillBundle} bundle already-validated bundle
 * @param {{ skillsDir?: string }} [options]
 * @returns {Promise<{ skillDir: string, reconstructed: boolean }>}
 */
export async function provisionSkill(sandbox, bundle, options = {}) {
  validateBundle(bundle); // defense in depth: never reconstruct an unvalidated bundle
  const skillsDir = options.skillsDir ?? SKILLS_DIR;
  const skillDir = `${skillsDir}/${bundle.skillName}`;
  const blob = `/tmp/skill-${bundle.skillName}-${bundle.version}.tgz.b64`;

  const tgz = await makeTarGz(bundle.files, bundle.skillName);
  await sandbox.writeFile(blob, toBase64(tgz));

  const script =
    `if [ -d '${skillDir}' ]; then STATUS=present; ` +
    `else mkdir -p '${skillsDir}' && base64 -d '${blob}' | tar -xz -C '${skillsDir}' && STATUS=reconstructed; fi; ` +
    `rm -f '${blob}'; echo "provision:$STATUS"`;
  const result = await sandbox.exec(script);

  const stdout = result?.stdout ?? '';
  const ok = (result?.exitCode === undefined || result.exitCode === 0) && /provision:(present|reconstructed)/.test(stdout);
  if (!ok) {
    throw new Error(
      `skill reconstruction failed (exit=${result?.exitCode}): ${stdout} ${result?.stderr ?? ''}`.trim(),
    );
  }
  return { skillDir, reconstructed: stdout.includes('provision:reconstructed') };
}
