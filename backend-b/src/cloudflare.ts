/**
 * Backend B Worker-level exports. Identical egress/secret seam to backend A
 * BY DESIGN (plan §6/§13 C4): the same skill must run identically — the only
 * difference between the backends is how the skill reached the container.
 *
 * The bearer is resolved from ctx.containerId per invocation; no caching
 * (isolate-global registry, plan §9.2a). KV is B's own namespace — A and B
 * share no runtime resources (plan §13 C5).
 */
import { Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import { ECHO_HOST, kvSecretBroker, injectAndForward } from '@hoth/core';

export { ContainerProxy };

type Env = {
  STORE: KVNamespace;
};

export class HothSandbox extends Sandbox<Env> {
  enableInternet = false;
  allowedHosts = [ECHO_HOST];
}

HothSandbox.outboundByHost = {
  [ECHO_HOST]: async (request: Request, env: Env, ctx: { containerId: string }) => {
    return injectAndForward(request, kvSecretBroker(env.STORE), ctx.containerId);
  },
};
