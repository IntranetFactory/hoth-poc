/**
 * Backend B Worker-level exports. Identical egress/secret seam to backend A
 * BY DESIGN (plan §6/§13 C4): the same skill must run identically — the only
 * difference between the backends is how the skill reached the container.
 *
 * Two egress handlers are registered on HothSandbox:
 *   - outboundByHost[ECHO_HOST] — per-container bearer injection for the A/B
 *     acceptance echo path; the bearer is resolved from ctx.containerId per
 *     invocation (no caching — isolate-global registry, plan §9.2a). KV is B's
 *     own namespace (STORE); A and B share no runtime resources (plan §13 C5).
 *   - static outbound (catch-all) — the Semantius secret broker (brokerEgress),
 *     gated by DOMAIN_WHITELIST. A request to a whitelisted host has any
 *     SEMANTIUS_KEY_SENTINEL header swapped for the real key (SEMANTIUS_REAL_API_KEY,
 *     held only here in the Worker); a whitelisted request with no sentinel is
 *     forwarded as-is (e.g. follow-up JWT calls); anything to a non-whitelisted
 *     host is rejected — even if it carries the sentinel (exfiltration guard).
 */
import { Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import {
  ECHO_HOST,
  kvSecretBroker,
  injectAndForward,
  SEMANTIUS_KEY_SENTINEL,
  DOMAIN_WHITELIST,
  brokerEgress,
} from '@hoth/core';

export { ContainerProxy };

type Env = {
  STORE: KVNamespace;
  // Real Semantius API key — Worker-side only, injected at egress in place of
  // the container's placeholder. NEVER baked into the image. Set via .dev.vars
  // locally and `wrangler secret put SEMANTIUS_REAL_API_KEY` when deployed.
  SEMANTIUS_REAL_API_KEY?: string;
};

export class HothSandbox extends Sandbox<Env> {
  enableInternet = false;
  // Intercept HTTPS egress too (SDK default is false). semantius calls
  // https://<org>.semantius.ai, so without this the catch-all `outbound` swap
  // would never see its request. The container trusts the interceptor CA via
  // NODE_EXTRA_CA_CERTS baked in the Dockerfile.
  interceptHttps = true;
}

HothSandbox.outboundByHost = {
  [ECHO_HOST]: async (request: Request, env: Env, ctx: { containerId: string }) => {
    return injectAndForward(request, kvSecretBroker(env.STORE), ctx.containerId);
  },
};

HothSandbox.outbound = async (request: Request, env: Env) => {
  return brokerEgress(request, {
    whitelist: DOMAIN_WHITELIST,
    sentinel: SEMANTIUS_KEY_SENTINEL,
    secret: env.SEMANTIUS_REAL_API_KEY,
  });
};
