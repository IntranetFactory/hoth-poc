/**
 * Dynamic skill bundle format (plan §5) and server-side validation of
 * untrusted bundles (plan §8). One JSON string carries every file.
 *
 * @typedef {Object} SkillBundle
 * @property {string} skillName  lowercase/hyphens, <=64, matches skill dir name
 * @property {string} version    content hash of the files
 * @property {string} baseImage  toolchain the skill needs; selects the Sandbox binding (§16)
 * @property {Record<string, string>} files  rel-path -> utf-8 content (must include SKILL.md)
 */

export const BUNDLE_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
};

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate an untrusted bundle before any reconstruction (plan §8):
 * reject `..`, absolute paths, backslashes, resolve-outside-dir;
 * size/count caps; required SKILL.md; skill-name shape.
 *
 * @param {unknown} raw
 * @returns {SkillBundle} the validated bundle (same object, narrowed)
 */
export function validateBundle(raw) {
  if (typeof raw === 'string') raw = JSON.parse(raw);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BundleValidationError('bundle must be a JSON object');
  }
  const bundle = /** @type {Record<string, unknown>} */ (raw);

  const skillName = bundle.skillName;
  if (typeof skillName !== 'string' || skillName.length === 0 || skillName.length > 64 || !SKILL_NAME_RE.test(skillName)) {
    throw new BundleValidationError('skillName must be lowercase letters/numbers/hyphens, 1-64 chars, no leading/trailing/consecutive hyphens');
  }
  if (typeof bundle.version !== 'string' || bundle.version.length === 0 || bundle.version.length > 128) {
    throw new BundleValidationError('version must be a non-empty string');
  }
  if (typeof bundle.baseImage !== 'string' || bundle.baseImage.length === 0 || bundle.baseImage.length > 64) {
    throw new BundleValidationError('baseImage must be a non-empty string');
  }

  const files = bundle.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new BundleValidationError('files must be an object of relPath -> content');
  }
  const entries = Object.entries(files);
  if (entries.length === 0) throw new BundleValidationError('files must not be empty');
  if (entries.length > BUNDLE_LIMITS.maxFiles) {
    throw new BundleValidationError(`too many files (${entries.length} > ${BUNDLE_LIMITS.maxFiles})`);
  }
  if (!Object.prototype.hasOwnProperty.call(files, 'SKILL.md')) {
    throw new BundleValidationError('bundle must contain SKILL.md at its root');
  }

  let total = 0;
  const seen = new Set();
  for (const [relPath, content] of entries) {
    validateRelPath(relPath);
    const canonical = relPath.split('/').filter(Boolean).join('/');
    if (seen.has(canonical)) throw new BundleValidationError(`duplicate path after normalization: ${relPath}`);
    seen.add(canonical);
    if (typeof content !== 'string') throw new BundleValidationError(`file content must be a string: ${relPath}`);
    const bytes = utf8Length(content);
    if (bytes > BUNDLE_LIMITS.maxFileBytes) {
      throw new BundleValidationError(`file too large: ${relPath} (${bytes} > ${BUNDLE_LIMITS.maxFileBytes})`);
    }
    total += bytes;
  }
  if (total > BUNDLE_LIMITS.maxTotalBytes) {
    throw new BundleValidationError(`bundle too large (${total} > ${BUNDLE_LIMITS.maxTotalBytes})`);
  }

  return /** @type {SkillBundle} */ (bundle);
}

/** Reject any path that could resolve outside the skill directory. */
export function validateRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) {
    throw new BundleValidationError(`invalid path: ${String(relPath)}`);
  }
  if (relPath.includes('\\')) throw new BundleValidationError(`backslash in path: ${relPath}`);
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    throw new BundleValidationError(`absolute path not allowed: ${relPath}`);
  }
  if (relPath.includes('\0')) throw new BundleValidationError(`NUL byte in path: ${relPath}`);
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '' ) throw new BundleValidationError(`empty path segment: ${relPath}`);
    if (seg === '.' || seg === '..') throw new BundleValidationError(`path traversal not allowed: ${relPath}`);
  }
}

export class BundleValidationError extends Error {
  constructor(message) {
    super(`bundle validation failed: ${message}`);
    this.name = 'BundleValidationError';
  }
}

function utf8Length(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * baseImage -> Sandbox binding resolver (plan §16 design hook).
 * Both getSandbox and the bearer KV key must derive from the SAME
 * selected binding (plan §7). Adding an image later is a wrangler
 * entry + a row here, not a rewrite.
 */
export const BASE_IMAGE_BINDINGS = { node: 'Sandbox' };

export function resolveSandboxBinding(baseImage) {
  const binding = BASE_IMAGE_BINDINGS[baseImage];
  if (!binding) throw new BundleValidationError(`unsupported baseImage: ${baseImage}`);
  return binding;
}
