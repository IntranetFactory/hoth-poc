/**
 * Backend A Worker-level exports: the container-backed Sandbox class with
 * zero-trust egress (plan §7), and ContainerProxy so outbound interception
 * can run.
 *
 * Egress is deny-by-default: enableInternet=false plus an allowlist holding
 * only the echo host. The outbound handler resolves the bearer from
 * ctx.containerId on EVERY invocation — never cached in closure/module scope,
 * because this registry is isolate-global and caching would bleed credentials
 * across concurrent sessions (plan §9.2a).
 */
import { Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import { ECHO_HOST, kvSecretBroker, injectAndForward } from '@hoth/core';

export { ContainerProxy };

type Env = {
  SECRETS: KVNamespace;
};

export class HothSandbox extends Sandbox<Env> {
  enableInternet = false;
  allowedHosts = [ECHO_HOST];
}

HothSandbox.outboundByHost = {
  [ECHO_HOST]: async (request: Request, env: Env, ctx: { containerId: string }) => {
    return injectAndForward(request, kvSecretBroker(env.SECRETS), ctx.containerId);
  },
};
