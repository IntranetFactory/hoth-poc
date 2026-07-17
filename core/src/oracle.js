/**
 * Deterministic acceptance oracle (plan §13). A BOUNDED set of fixed commands
 * built server-side from validated structured params — never a client-supplied
 * shell string. This is what lets the harness drive the core directly and
 * isolate the A/B skill-delivery comparison from LLM nondeterminism, without
 * shipping an arbitrary-exec surface.
 *
 * Each op maps to one hard-coded command template. The only interpolated
 * values are strictly validated (site names, ISO dates), and are passed to the
 * skill script as `--flag=value` args, not spliced into shell syntax.
 */
import { SKILLS_DIR } from './provision.js';

const SITE_RE = /^[A-Za-z0-9 ]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SKILL_NAME = 'hoth-trip-planner';
const SCRIPT = `${SKILLS_DIR}/${SKILL_NAME}/scripts/opening-times.js`;
const SKILL_DIR = `${SKILLS_DIR}/${SKILL_NAME}`;

/**
 * Validate a request and return the exact command string to exec. Throws on
 * anything not in the allowlisted shape.
 *
 * @param {{ op?: string, sites?: string[], from?: string, to?: string, debugEcho?: boolean }} req
 * @returns {string}
 */
export function buildOracleCommand(req) {
  const op = req?.op;
  switch (op) {
    case 'opening-times': {
      const sites = req.sites;
      if (!Array.isArray(sites) || sites.length === 0 || sites.length > 8) {
        throw new OracleError('sites must be 1-8 site names');
      }
      for (const s of sites) if (typeof s !== 'string' || !SITE_RE.test(s)) throw new OracleError(`invalid site name: ${s}`);
      if (!DATE_RE.test(req.from ?? '')) throw new OracleError('from must be YYYY-MM-DD');
      if (!DATE_RE.test(req.to ?? '')) throw new OracleError('to must be YYYY-MM-DD');
      // Args are single-quoted; site names are already restricted to
      // [A-Za-z0-9 ] so no quote/metachar can appear.
      const sitesArg = sites.join(',');
      const debug = req.debugEcho ? ' --debug-echo' : '';
      return `node '${SCRIPT}' --sites='${sitesArg}' --from='${req.from}' --to='${req.to}'${debug} 2>&1`;
    }
    case 'hash-skill':
      // C3 triple-hash leg inside the live sandbox.
      return `cd '${SKILL_DIR}' && find . -type f | sort | xargs sha256sum`;
    case 'count-skill-files':
      // Clean-base / positive-control file count (plan §13). A *file* count.
      return `find '${SKILLS_DIR}' -type f 2>/dev/null | wc -l`;
    default:
      throw new OracleError(`unknown op: ${String(op)}`);
  }
}

export class OracleError extends Error {
  constructor(message) {
    super(`oracle request invalid: ${message}`);
    this.name = 'OracleError';
  }
}
