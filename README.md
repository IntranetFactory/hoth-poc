# Hoth Trip-Planner POC

Proves that **two skill-delivery mechanisms yield identical agent behavior** on Flue +
Cloudflare Sandbox:

- **Backend A** — hard-coded / OOTB: the skill is **baked into the container image**.
- **Backend B** — dynamic bundle: the whole skill is serialized as **one JSON string**,
  delivered at runtime, and reconstructed into the sandbox (the multi-tenant path).

See [`hoth-poc-plan.md`](./hoth-poc-plan.md) for the full design and acceptance criteria.

## Deployed

| Deployable | URL |
| ---------- | --- |
| Frontend (A/B chat UI) | https://hoth-poc-frontend.ma532.workers.dev |
| Backend A — image-baked skill | https://hoth-poc-backend-a.ma532.workers.dev |
| Backend B — dynamic bundle | https://hoth-poc-backend-b.ma532.workers.dev |

All three run on Cloudflare Workers (account `Ma@adenin.com`). Backends A and B each own a
container app (Containers) and a private KV namespace; the frontend is a static SPA served
from Workers assets with the two backend URLs baked in at build time.

## Layout

```
core/        Host-agnostic Flue-core seams (no Cloudflare imports):
             bundle format + validation, tar reconstruction (2-RPC), provisionSkill,
             egress/secret broker interface, API-key guard, deterministic skill-check.
backend-a/   Flue+CF Worker — skill baked into the image. Owns the canonical skill
             folder (source of truth) and the bundler CLI.
backend-b/   Flue+CF Worker — skill injected at runtime from the one-JSON-string bundle.
frontend/    React + Vite — one chat, New-session button, A/B backend dropdown.
scripts/     node-smoke.mjs (portability, zero Cloudflare) · acceptance.mjs (C1–C5).
```

## Prerequisites

- Node **>= 22.18** (Flue requirement; `nvm use 22.22.0`).
- pnpm, Docker (for building the sandbox container image), a Cloudflare account with
  **Workers Paid + Containers** and **Workers AI** enabled.
- One dependency patch under `patches/` (applied automatically by `pnpm install`):
  - `@durable-streams/client` — opens the held **SSE** connection on the first `updates`
    request in `live:'sse'` mode. The stock 0.2.6 client (still pinned by @flue/sdk v2) only
    opens SSE after reaching up-to-date, so while an agent is actively generating (never
    up-to-date) it busy-polls catch-up reads at network speed — a request flood.
    `node scripts/verify-patch.mjs` proves the first request now carries `live=sse`.
  - (The beta-era `@flue/cli` patch is gone: Flue v2 replaced the `flue` CLI with Vite —
    `@flue/vite` + `@cloudflare/vite-plugin`.)

## Build & run

```bash
pnpm install
pnpm bundle            # walk skill folder -> one JSON string; round-trip assert; emit bundle
pnpm smoke             # Node smoke test — core skill flow with zero Cloudflare present

pnpm dev:frontend      # http://localhost:5173  (talks to localhost:3583/3584 in dev)
```

## Deploy

```bash
pnpm deploy            # bundle + deploy A + B + frontend, in order
# or individually:
pnpm deploy:a          # vite build + wrangler deploy backend A (creates its container app)
pnpm deploy:b          # vite build + wrangler deploy backend B
pnpm deploy:frontend   # vite build (URLs from frontend/.env.production) + wrangler deploy
```

First deploy of each backend creates its Cloudflare Container application and prompts to
confirm. Backends need **Workers AI** and **Containers** enabled on the account. The frontend
build reads the two backend URLs from [`frontend/.env.production`](./frontend/.env.production).

## Authentication

Both backends are behind a shared **API-key guard** (`core/src/auth.js`): every route except
`/health` requires `Authorization: Bearer <API_TOKEN>`, and fails closed (503) if `API_TOKEN`
is unset. Set it as a Cloudflare secret per backend, and locally via `.dev.vars`:

```bash
node -e "console.log('hoth_'+require('crypto').randomBytes(24).toString('base64url'))" > .api-token
cd backend-a && printf 'API_TOKEN="%s"\n' "$(cat ../.api-token)" > .dev.vars   # local dev
wrangler secret put API_TOKEN --config backend-a/wrangler.jsonc                 # deployed (paste the value)
# repeat for backend-b
```

The **frontend never bakes the key in** — you type it into the API-key field on the page
(persisted to `localStorage`), and it rides every request: the FlueClient `token` option
(chat + SSE) and an explicit header on the session-setup fetches. This is a gate against
outside abuse, not per-tenant identity — real multi-tenant auth is the server-side
`verify token → tenant` from plan §9.6.

## LLM configuration

Fully env-driven (`configureLlm()` in `core/src/config.js`, wired per backend in
`src/llm.ts`): `LLM_PROVIDER` (`cloudflare` | `openrouter` | `custom`), `LLM_MODEL`, and
optional `LLM_BASE_URL` (required for `custom`) are plain wrangler `vars`; only
`LLM_API_KEY` is a secret (`.dev.vars` locally, `wrangler secret put` deployed). Default:
OpenRouter + `deepseek/deepseek-v4-flash`. Keep the vars/secret split — the key is the only
secret value.

## Data browser

The frontend **Data** tab navigates all Cloudflare-stored data as a generic
collection → record → detail tree, backed by the read-only `/admin/collections` routes on
both backends (behind the API-key guard; host-agnostic logic in `core/src/admin.js`, tests
in `scripts/admin.test.mjs`, `pnpm test`).

Non-obvious constraint: Cloudflare cannot list Durable Object instances, so conversations
are enumerable only via the `session:<id>` KV records each backend writes at
provision/ingest (`putSessionIndex`) — sessions created before that index existed don't
appear. Conversation *content* is streamed by the frontend via the Flue conversation
client, not an admin endpoint.

## GitHub channel (backend B)

`backend-b/src/channels/github.ts` (`@flue/github`) connects IntranetFactory/hoth-poc to
the `hoth` agent: `issues.opened` and `issue_comment.created` dispatch one conversation per
issue; replies are posted via the `comment_on_github_issue` tool and carry a
`<!-- hoth-agent-reply -->` marker the webhook skips (loop guard). The agent instructions
must insist on the tool — otherwise the model answers in plain conversation text and
nothing appears on GitHub.

- Webhook endpoint: `https://hoth-poc-backend-b.ma532.workers.dev/channels/github/webhook`,
  mounted in `app.ts` **before** the API-key guard (auth is `X-Hub-Signature-256`, not the
  bearer). The explicit early mount is load-bearing.
- GitHub conversations load the same trip-planner skill from the no-TTL KV entry
  `bundle:github-default`, uploaded manually:
  `wrangler kv key put bundle:github-default --path frontend/src/generated/hoth-bundle.json`
  — re-upload after regenerating the bundle. The agent initializer mints the egress bearer
  itself (tenantTag `github`) since these conversations never pass the ingest route.
- Worker secrets: `GITHUB_WEBHOOK_SECRET` (channel creation throws at module init if
  empty — deploy fails until it exists) and `GITHUB_TOKEN` (fine-grained PAT, Issues
  read/write).
- Status 2026-07-19: the repo webhook itself was **not yet created** (the PAT lacked the
  Webhooks permission, 403); the end-to-end flow was verified with manually signed
  deliveries (issue #1 answered, incl. follow-up).

## Observability (Braintrust)

Both backends export traces to the Braintrust project **`hoth-poc`** via the Flue tooling
blueprint (`flue add tooling braintrust` — it prints an agent-directed blueprint, it does not
edit files). Per backend: `braintrust@3.17.0` (pinned) + `src/braintrust.ts` (the
`observe(...)` bridge, imported first in `app.ts`).

- **Key**: `BRAINTRUST_API_KEY` is a Worker secret (`wrangler secret put`) and in gitignored
  `.dev.vars` — never a wrangler `vars` value. Without the key the bridge is a no-op:
  nothing initializes, the app runs untraced.
- **Project name**: `BRAINTRUST_PROJECT_NAME=hoth-poc` in each `wrangler.jsonc` `vars`.
- **Compat bridge (do not simplify away)**: braintrust 3.17 reads the pre-v2 flat event
  fields (`model`, `input`, `output`, `usage`, `stopReason`, and `tool_call`), while current
  Flue nightlies nest turn payloads under `request`/`response` and put an agent prompt's
  output in the `agentOutput` observation detail. `compatibleEvent()` in `src/braintrust.ts`
  flattens them back; without it llm spans arrive with duration only — no tokens, cost, or
  content. Re-check on every `braintrust` or `@flue/runtime` bump.
- **Delivery is best-effort on Cloudflare**: the observer can't `waitUntil`, so final spans
  of a run can be lost when the isolate idles immediately after. Occasional missing span
  ends are the documented tradeoff, not a bug.
- **pnpm**: the `braintrust` postinstall only downloads the optional `bt` CLI; it's blocked
  via `allowBuilds: braintrust: false` in `pnpm-workspace.yaml` (an unset placeholder there
  makes every `pnpm install` exit 1).
- **Data export**: traces carry prompts, model output/reasoning, tool args/results. Fine for
  this POC; revisit (Braintrust `setMaskingFunction`) before pointing real tenant data at it.

Verify: send a chat turn, then check the project logs — llm spans should be named
`llm:<model>` and carry `prompt_tokens` / `completion_tokens` / `estimated_cost` metrics.

## Acceptance

```bash
API_TOKEN=$(cat .api-token) node scripts/acceptance.mjs        # default deployed URLs
API_TOKEN=... A_URL=... B_URL=... node scripts/acceptance.mjs
```

Drives the **deterministic core** (the bounded `/sessions/:id/skill-check` route) so the A/B
comparison is isolated from LLM nondeterminism. Covers: auth (401 without/with wrong key),
C1 (A is OOTB/static, no ingest), C2 (B per-session bearers + tenant tags), C3 (single source
of truth — A image == bundle == B reconstructed, byte-identical), C4 (same result A vs B —
`opening-times.js` stdout byte-for-byte, plus the injected bearer reaching the echo upstream
while the container sends none), C5 (uniqueness guard + fail-closed egress), plus clean-base
and hostile-bundle checks.

## Verified results

All 23 acceptance checks pass against the deployed Workers, and both backends drive the LLM
end-to-end with the identical `activate_skill → read → bash` sequence and matching opening
times. Two wiring findings and the egress HTTP-vs-HTTPS caveat are recorded in
[`hoth-poc-plan.md`](./hoth-poc-plan.md) §7.

## The `/sessions/:id/skill-check` route

A **bounded** test affordance (behind the API-key guard): it runs one of a fixed set of
deterministic commands (`opening-times`, `hash-skill`, `count-skill-files`) built server-side
from strictly validated structured params — **not** arbitrary shell. It exists to drive the
acceptance oracle; it is not a product route.
