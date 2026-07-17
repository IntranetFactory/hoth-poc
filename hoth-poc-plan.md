# Hoth Trip-Planner POC — Plan (rev. 5, consolidated)

## 1. Goal & thesis

Prove that **two skill-delivery mechanisms yield identical agent behavior**:

- **Hard-coded skill** — the OOTB Flue way: the skill lives on the sandbox filesystem (baked into the
  container image). Backend A.
- **Dynamic skill bundle** — the whole skill (**all `.md` references + `.ts/.js` scripts**) serialized
  as **one JSON string**, delivered at runtime and reconstructed into the sandbox. Backend B. This is
  the multi-tenant path (bundle later lives in a database).

If both produce the same result — skill instructions, dynamically-loaded references, and an executable
script that runs in the sandbox and makes an authenticated outbound call — the dynamic-bundle path is
validated as the multi-tenant foundation.

**Secondary properties proven along the way:**
- **Request isolation** (the spine): two concurrent sessions with different bundles/secrets never see
  each other's files, env, or credentials.
- **Zero-trust secrets:** the per-tenant bearer is injected at egress (outbound handler) and **never
  enters the sandbox** — demonstrated by an authenticated call to an HTTP echo endpoint.
- **Portability:** Cloudflare is not a hard dependency; the core runs behind pluggable seams.

## 2. Architecture — Flue core + three pluggable seams

Flue is the framework. Cloudflare is the **first implementation** of each seam, not the architecture.

```
Flue core (host-agnostic):  bundle → provision skill → discovery → run → authenticated egress
   ├─ Sandbox seam        → Flue SandboxApi/Factory   → CF Sandbox (microVM)  | Docker | E2B | local
   ├─ State seam          → Flue persistence adapters  → DO-SQLite (CF)        | Postgres/SQLite
   └─ Egress/Secret seam  → OUR interface (app-owned)  → outbound handlers (CF)| proxy sidecar (Docker)
```

- **Sandbox** and **State** are Flue-native pluggable interfaces (SandboxFactory/SandboxApi;
  PersistenceAdapter/RunStore/EventStreamStore — SQL and Mongo are first-class).
- **Egress/Secret broker** is the one capability Flue does *not* abstract, because zero-trust
  secret-at-egress is Cloudflare-specific. We define a small interface; the POC ships only the **CF
  (outbound-handler) implementation**; a Docker **egress-proxy sidecar** impl is future work behind the
  same seam.
- A **Node smoke test** (virtual/local sandbox, in-memory state, no egress broker) proves the core runs
  with zero Cloudflare present — portability demonstrated, not just asserted.

## 3. Three projects (separate deployables)

```
c:\dev\hoth-poc\                      pnpm workspace; conventional package names
├─ backend-a/   Flue+CF Worker — skill BAKED INTO the container image (hard-coded / OOTB).
├─ backend-b/   Flue+CF Worker — skill INJECTED at runtime from the one-JSON-string bundle.
└─ frontend/    React + Vite — one chat, New-session button, A/B backend dropdown.
```

- pnpm; React + Vite. Both backends deploy to Cloudflare Workers (Workers Paid — Containers enabled).
- `backend-a/` owns the canonical skill folder (source of truth) **and** the bundler CLI.
- Both backends are `--target cloudflare`; both use **Cloudflare Sandbox** (microVM backend) via
  `getSandbox(env.Sandbox, id)` + `cloudflareSandbox(...)` from `@flue/runtime/cloudflare`.

## 4. The skill: `hoth-trip-planner`

Fictional (planet Hoth) so the model cannot use training knowledge and must read the references + run
the script.

```
skills/hoth-trip-planner/
├─ SKILL.md
├─ references/{echo-basin.md, north-ridge.md}   # sites + operator + region per region
└─ scripts/opening-times.js                       # calls the (mock) Hoth tourism API, returns times
```

- Sites = ski resorts & spas of two fictional operators: **Rebel Alliance Leisure**, **Imperial
  Wellness**. E.g. *Echo Base Thermal Springs*, *Wampa Ridge Spa*, *North Ridge Piste Lodge*.
- `SKILL.md`: frontmatter `name: hoth-trip-planner` (lowercase/hyphens, ≤64, **matches dir name**),
  non-empty `description` (≤1024). Body: read the region reference for candidate sites, then run the
  script for opening times — with the exact `node … 2>&1` command baked in (adapter/exec surfaces no
  stderr otherwise). Script referenced by real cwd-relative path
  (`.agents/skills/hoth-trip-planner/scripts/opening-times.js`); Flue has no `${CLAUDE_SKILL_DIR}`.
- `opening-times.js`: input site names + `from`/`to`. It **calls the mock Hoth tourism API** (an HTTP
  echo endpoint) with the request details and **no Authorization header**; the outbound handler injects
  the per-tenant bearer (§7). The echo response returns what the upstream received (proving the bearer
  arrived). The script then returns synthetic per-date data: `{ site_name, site_id: snake_case(name),
  opening_times:[{date,open,close}…] }`. Runs on `node`. (If a skill ships `.ts` scripts, the base
  image needs a TS runner such as `tsx`; POC uses `.js`.)

## 5. Bundle format & bundler (backend B)

The dynamic bundle is **one JSON string** carrying every file:

```jsonc
{ "skillName":"hoth-trip-planner", "version":"<content-hash>", "baseImage":"node",
  "files": { "SKILL.md":"…", "references/echo-basin.md":"…", "references/north-ridge.md":"…",
             "scripts/opening-times.js":"…" } }
```

- **Bundler** (`backend-a`, `pnpm bundle`): walks `skills/hoth-trip-planner/` → one JSON string, utf-8.
  **Same folder** A bakes into its image → **skill defined once**, two consumers.
- **`baseImage`** names the toolchain the skill needs; it selects the Sandbox binding at runtime (§16).
  The POC defaults it to one value — the field exists now so 3-4 images later is a config change, not a
  rewrite.
- Round-trip assert: bundle → reconstruct → byte-identical to source folder.
- **A bundle is immutable per session `id`** — a changed skill is a new `id` (§6), so reconstruction is
  always absent→write, never overwrite.

## 6. Backends

**Shared init contract (load-bearing — verified in Flue source).** All per-session provisioning happens
**inside the awaited `defineAgent(async ({ id, env }) => {…})` initializer**, which Flue awaits
(`client.ts:247`) **before** it scans `.agents/skills` for discovery (`discoverSessionContext`,
`client.ts:269`; the harness is rebuilt and this re-runs **every message**, `agent-submissions.ts:842`,
`client.ts:294`). So anything the initializer writes to the sandbox is present before discovery, and B
self-heals on every cold container. The ingest route (B) only **stores** the bundle — it must **not** be
the reconstruction site (a cold container at prompt time would then have no skill). Pin a single absolute
**cwd = `/workspace`**; reconstruct into and discover from exactly
`/workspace/.agents/skills/hoth-trip-planner`.

**Identity (in scope — isolation depends on it).** `id` must be **server-minted, globally unique, and
never reused** (UUID, or `hash(tenant+session)` per §9). The Sandbox's
`containerId = idFromName(sanitizeSandboxId(id))` is a deterministic function of `id`, so **id
uniqueness is what makes both container isolation and per-tenant secret keying safe** — a reused id
silently reuses another session's container and bearer. **A bundle is immutable per `id`**: a changed
skill ⇒ a new `id`. Reconstruction is therefore always **absent→write**, never in-place overwrite,
which removes any mixed-version window against concurrent session materialization.

**Backend A — hard-coded / OOTB.** Dockerfile `FROM cloudflare/sandbox:<v>` + `COPY skills/hoth-trip-planner
/workspace/.agents/skills/hoth-trip-planner`. Initializer: `getSandbox(env.Sandbox, id)` (skill already
in the image) → discovery. `skills:[]` empty, no bundle. **A still needs the bearer-mapping write** (§7):
it has no ingest route, so seed `KV[containerId] = bearer` in a `POST …/provision` (or at session
create) before the first prompt. A is a **static agent** — one **fixed** bearer/config for all sessions
(not per-tenant). "OOTB" is scoped to **skill delivery** (baked image + discovery, no bundle/ingest); A
shares the egress/secret seam with B **by design** so the *same skill* runs identically (§13 C4). This
maps to the contract exactly: A = static setting, B = per-session setting.

**Backend B — dynamic bundle.** Base Dockerfile is **skill-free** — only the CF sandbox base + `node`;
`/workspace/.agents/skills` is **empty at boot**. This is a hard requirement, not an aside: if any skill
file were baked in, B would be discovering a baked copy instead of testing dynamic injection. Verified by
the §13 clean-base test (a B container **before** injection finds no skill). Ingest `POST …/:id/skills`
(a) **validates** the bundle (§8), (b) stores it keyed by `id` (KV, read back by the initializer via an
`env` binding), (c) writes `KV[containerId] = bearer`. Initializer reads the stored bundle for `id` and
reconstructs into `/workspace/.agents/skills/hoth-trip-planner` **when the dir is absent** (cold
container) → discovery. Immutable-per-id ⇒ "absent" is the only case; no overwrite.

Both backends run the **same skill** and the **same outbound handler**. The only difference is how the
skill reached the container: image-baked (A) vs runtime-reconstructed (B).

## 7. Zero-trust secrets & egress (the outbound handler)

- Export `ContainerProxy`; register an **`outboundByHost`** handler for the echo host that, **per
  invocation**, reads `KV.get(ctx.containerId)` and sets `Authorization: Bearer <key>`. The **sandbox
  never holds the raw token**. **No closure/module caching** of the resolved token — the handler
  registry is isolate-global, so caching bleeds across concurrent sessions; resolve from
  `ctx.containerId` every call.
- **Mapping write (both backends), before first exec:** write `KV[containerId] = bearer`, deriving
  `containerId` **identically to the SDK** — `env[binding].idFromName(sanitizeSandboxId(id)).toString()`
  with the same `normalizeId` setting, where `binding` is the Sandbox binding selected from the bundle's
  `baseImage` (§16). Use the **same selected binding** for both `getSandbox` and this KV key, or it's a
  silent miss. B writes the mapping in the ingest POST; A in its provision step. The frontend awaits 2xx
  before chatting (§10) so the mapping exists first.
- **TTL + delete-on-session-end** on `KV[containerId]` — defence-in-depth even though ids are unique.
- `interceptHttps` is **default `true`** (echo host is HTTPS) — no opt-in needed.
- **Egress deny-by-default:** set **`enableInternet: false`** **and** **`allowedHosts = [echo host]`**
  (an allowlist becomes deny-by-default). `enableInternet:false` leaves only ports 80/443/DNS open and
  blocks raw sockets on other ports; the allowlist + handler govern 80/443. Test link-local/RFC-1918 on
  **ports 80/443 and via DNS**, not just "some other port" (§13) — an HTTP-only test gives a false pass.
- **Use `placement: smart`** (not `targeted`) — targeted puts `ContainerProxy` in a different colo and
  header injection silently never fires (sandbox-sdk#661).
- **Two wiring prerequisites found during implementation (both load-bearing):**
  1. **Workers AI binding** (`"ai": { "binding": "AI" }` in `wrangler.jsonc`) is required for any
     `cloudflare/*` model, else the agent fails with *"Cloudflare AI binding not available."*
  2. **HTTPS interception CA not provisioned by the `cloudflare/sandbox:0.12.3` base image.** With
     `enableInternet:false` + `allowedHosts`, the egress proxy engages on **port 80** (injection works,
     verified) but **port 443 hangs** — `/etc/cloudflare/certs/` is absent, so the container's TLS
     client can't validate the interceptor. **POC egresses to the echo host over HTTP**; the zero-trust
     property (secret injected at the proxy, never in the sandbox) is identical on either port. Getting
     HTTPS interception needs a newer sandbox base image that ships the CA-trust bootstrap — recorded
     residual item, not a thesis blocker.
- **Egress deny-by-default measured:** non-allowlisted hosts return **no successful response** — port
  443 hard-blocks (curl `000`) for link-local `169.254.169.254`, RFC-1918, and arbitrary public hosts;
  port 80 denials return **`520`** from the proxy (request refused upstream, no data served) rather than
  a TCP-level block. No unauthorized egress succeeds; the `000`-vs-`520` split is a proxy-layer nuance.
- The **echo endpoint** reflects the request back so the POC can *see* the injected bearer and confirm
  the container sent none. (beeceptor `http-echo` / `httpbin.org/anything`; must echo request headers;
  avoid HEAD — sandbox-sdk#660.)

## 8. Sandbox lifecycle, state & bundle validation

- **Per-id container is native**: `getSandbox(env.Sandbox, id)` returns the same DO-backed sandbox for a
  given `id` → warm reuse across turns is free; different ids never share a container (structural request
  isolation). `containerId = idFromName(id)` is **stable across sleep/wake/eviction**, so the bearer
  mapping keyed by it survives cold starts. No manual acquire/reuse machinery (unlike the Daytona design).
- **Container disk is ephemeral** — reset to the image on sleep (~10 min idle) or eviction. A's baked
  skill returns for free (image re-pull). B's initializer re-materializes when the skill dir is
  **absent** — immutable-per-id (§6) means there is no stale/overwrite case, so no in-place rewrite and
  no mixed-version window. Same-id submissions are head-of-line serialized (`sql-agent-execution-store.ts`),
  so there is no concurrent-reconstruction race on the run path.
- **State seam** = Flue persistence; the per-id bundle + `containerId→bearer` live in KV keyed by `id`.
- **Reconstruct in 2 RPCs, not N:** write the bundle as one base64-tar blob (`writeFile`, 1 RPC) then
  `env.exec('base64 -d … | tar -xz -C /workspace/.agents/skills')` (1 RPC). Flue/SDK have **no batch
  write**, so per-file writes are N round-trips on every cold container (§15 P2).
- **Pre-warm:** the ingest POST — which the frontend awaits before chatting (§10) — eagerly boots the
  container and reconstructs, so the 1-3 s cold boot overlaps the user typing (§15 P1).
- **Bundle validation (untrusted input)**, server-side before reconstruction: reject `..`, absolute,
  backslashes, symlinks, resolve-outside-dir; size/count caps. Flue/adapters validate nothing.
- Any dir cleanup uses **`env.exec('rm -rf …')`** (the CF SandboxApi `rm()` throws on `recursive`/`force`,
  `cf-sandbox.ts:134-146`) — but immutable-per-id means destructive cleanup is normally unneeded.

## 9. Multi-tenant security model

The sandbox runs arbitrary skill code (`bash`/`node`). The boundary must hold across concurrent
sessions. Request isolation is the POC's proven property; tenant authz is the layer above it.

1. **Isolation:** each CF Sandbox runs in its **own VM** — Cloudflare's choice of gVisor / Firecracker /
   QEMU, **not developer-selectable**. Stronger than shared-kernel containers (the earlier concern), but
   **not a guaranteed hardware-hypervisor boundary** — if that is a hard requirement for tenant code it
   stays a recorded residual risk, not something the spike can pin.
2. **Request isolation (spine):** different `id` ⇒ different DO ⇒ structural file/env isolation; Flue's
   CF runtime is AsyncLocalStorage-scoped (`cloudflare/context.ts`), so no per-request bleed by default.
   Two named footguns: **(a)** the isolate-global `outboundByHost` handler must resolve the bearer from
   `ctx.containerId` **per invocation** with no closure/module caching; **(b)** do not register a Flue
   `observe()` sink that retains per-session data (it is a module-global fanned out to every session).
   Keep all per-request state in request/DO scope.
3. **Secrets never in the sandbox:** injected at egress by `containerId` (§7); a script cannot leak a
   token it never holds. Only non-sensitive config may go in container env.
4. **Egress:** deny-by-default + host allowlist (§7).
5. **Bundle validation:** §8.
6. **Session-id uniqueness (IN scope — isolation depends on it):** `id` must be server-minted, globally
   unique, and never reused, because `containerId = idFromName(id)` derives both container and bearer
   identity from it — a reused id reuses another session's container and secret. **Tenant authz
   (deferred):** Flue does **no** authz on the URL `id` (`flue-app.ts:420`, `errors.ts:1378-1390`);
   production binds a verified token → tenant → allowed sessions and keys all state by server-derived
   `hash(tenant+session)`, enforced on **GET/stream and POST**.
7. **Quotas/DoS:** per-tenant concurrent-container + creation-rate caps (app-enforced); spend alerting.

## 10. Frontend (React + Vite)

`@flue/react` + `@flue/sdk`. **Two `FlueClient`s** (base URL fixed at construction) selected via
`useFlueAgent({ client })`. State: `sessionId`, backend. **New session** → mint id; for B, `POST …/skills`
with the one-JSON-string bundle, await 2xx, then open chat. Render `messages[].parts`. POC caveat:
browser-as-bundle-origin inverts the production trust model (server-side tenant store); fine for the
POC, not the prod seam (§12).

## 11. Build order

0. **Spike (gate):** deployed Worker, **`placement: smart`**, **`enableInternet: false`** +
   **`allowedHosts=[echo host]`**. Exercise `getSandbox` → write files → `exec node` → an
   **`outboundByHost`** handler injecting a bearer. Confirm ALL of:
   - injected bearer appears at the echo and is **absent** from container `env`;
   - the app's `idFromName(sanitizeSandboxId(id))` derivation **equals** the handler's `ctx.containerId`
     (no silent KV miss);
   - two **concurrently interleaved** sessions each get **their own** bearer (no isolate-cache bleed);
   - egress to `169.254.169.254`/RFC-1918 fails on **ports 80/443 and via DNS** (not just other ports);
   - after **>10 min idle**, a new turn re-materializes B's skill (absent-dir path) and the bearer still
     resolves.
   (Do **not** gate on "microVM" — the runtime is not developer-selectable.)
1. **Skill** folder; run `opening-times.js` against the echo endpoint locally.
2. **Bundler** → one JSON string; round-trip assert.
3. **Backend A** — Worker + Dockerfile baking the skill; discovery; outbound handler; verify.
4. **Shared core** — `provisionSkill(bundle)` (validate + write + version stamp) + the egress/secret
   broker interface (CF impl).
5. **Backend B** — ingest route + DO store; initializer reconstruct; discovery.
6. **Frontend** — two clients, chat, new-session, A/B dropdown, bundle POST.
7. **Node smoke test** — core runs on `--target node` with virtual/local sandbox, no CF.
8. **All C1–C5 acceptance tests (§13)** — incl. the C4 byte-equal direct-exec oracle and the C3
   triple-hash single-source check; deploy both + host frontend; repeat against deployed URLs.

## 12. From B to production multi-tenant (future)

Bundle → Postgres `tenant_skill_files(tenant_id, skill_name, rel_path, content, version)` + per-tenant
secret refs. Tenant from **verified** identity → Flue `id`. Bundler server-side (tenant uploads a folder
→ rows; client no longer the origin). Docker egress-proxy impl of the secret/egress seam for private
hosting. Tenant authz (§9.6), quotas, reaping become production controls.

## 13. Acceptance criteria

Each test names a concrete **oracle**, not prose. LLM nondeterminism is isolated from the skill-delivery
comparison by driving the deterministic core directly. Grouped by the five contract criteria.

**C1 — A is OOTB / static (skill delivery vanilla).**
- A's skill is served **purely from the image**: `POST <backend-a>/…/skills` returns 404/405 (no ingest),
  and an exec/fs trace of an A turn shows **zero writes** under `/workspace/.agents/skills`.
- Recorded scope: A keeps the egress/secret seam but with a **single static** bearer/config ("static
  agent"); "OOTB" = skill delivery only (§6). Not a violation — required so the same skill runs on both.

**C2 — B per-tenant, differs per session.**
- Two concurrent B sessions carry **different bearers AND a distinguishable per-tenant config token**
  (`tenantTag`); each session's echo reflects **its own** tag and bearer, and neither container `env`
  holds the raw bearer — proving per-session runtime injection drives behavior, not a baked/shared value.

**C3 — Single source of truth (A-image == bundle == B-reconstructed, byte-identical).**
- **Triple-hash:** `find . -type f | sort | xargs sha256sum` inside **A's built image**, == per-file
  SHA-256 of the **bundle** values (same rel-paths), == the same `find|sha256sum` in **B's live sandbox
  after injection**. Guards CRLF / `.dockerignore` / stale-image drift the §5 build-host round-trip can't
  see (three different byte paths: Windows `fs` read, Docker `COPY`, `base64 -d | tar -xz`).

**C4 — Same result A vs B (the thesis).**
- **Deterministic oracle (load-bearing):** run the *same fixed-arg* invocation of `opening-times.js` in
  A's and B's sandbox — `env.exec('node .../opening-times.js --sites="Echo Base Thermal Springs"
  --from=2026-08-01 --to=2026-08-03 2>&1')` — and assert **A's stdout JSON == B's stdout JSON byte-for-
  byte** (`site_name`, `site_id`, `opening_times[]`). Zero LLM variance.
- **Egress trace:** in both, the echo upstream received `Authorization: Bearer <that session's key>` and
  the container itself sent none.
- **LLM trace (corroboration, seeded harness — fixed model, temp 0, fixed user turn):** same skill
  activated (`hoth-trip-planner`), same reference read (`references/echo-basin.md`), same script path,
  matching `site_id` surfaced. Prose text is **not** compared. The direct-exec byte-compare is the real
  oracle; the trace is soft corroboration (temp-0 is not hard determinism). One unseeded chat is **not**
  a test.

**C5 — Nothing shared but the bundle.**
- **B↔B:** two concurrent sessions get their own bearer/container/files (isolate-cache bleed); a reused
  id is rejected (uniqueness guard); a delayed `KV[containerId]` write makes egress **fail closed**.
- **A↔B disjointness:** a config-diff over both `wrangler.jsonc` asserts A and B share **no** KV namespace
  id, Sandbox/DO binding/namespace, or secret name. Combined with C3's clean-base, this proves the
  **bundle JSON is the only artifact crossing A→B**. The base image name is shared but read-only /
  state-free.

**Lifecycle / robustness (cross-cutting).**
- **B clean base:** on a **fresh, never-injected id**, `env.exec('find /workspace/.agents/skills -type f
  | wc -l')` returns **0** — a *file* count, not a discovery check (discovery skips malformed copies,
  `context.ts:88-94`). Positive control: after injection the same `find` shows the expected file set.
- **Reuse & cold-recovery:** turn-2 within `sleepAfter` reuses the warm container; after a cold container
  (>10 min idle / eviction) B **re-materializes** and still works.
- **Hostile bundle:** `..` / symlink / resolve-outside-dir / oversize / missing SKILL.md rejected before
  reconstruction.
- **Egress (`enableInternet:false` + `allowedHosts`):** echo host reachable via the handler; raw-socket
  **and** HTTP(S) to `169.254.169.254`, an arbitrary public IP, and RFC-1918 fail on **ports 80/443 and
  via DNS**, not just other ports (an HTTP-only test gives a false pass).
- **Portability:** the Node smoke test runs the core skill flow with no Cloudflare present.

## 14. Open items (none blocking the spike)

- **Concrete echo endpoint** (beeceptor `http-echo` vs `httpbin.org/anything`) — pick at build.
- **Frontend hosting** — Cloudflare Pages vs a dedicated Worker.
- **Tenant authz source** — deferred to the tenant layer (§9.6), not needed for the POC spine.
- **Isolation runtime** (gVisor vs Firecracker vs QEMU) is Cloudflare's choice, not selectable —
  recorded as residual risk, not a decision (§9.1).
- **Arbitrary per-tenant custom images** are out of scope — static bindings cover a bounded set only;
  arbitrary images would need Workers for Platforms (§16 ceiling).

## 15. Performance & cost

- **P1 — Cold start (first-message latency).** A new session, or one idle >10 min, pays container boot
  (~1-3 s typical, seconds-to-tens on the tail) + B's reconstruction + the discovery pass. **Mitigate:
  pre-warm in the awaited ingest POST** (§8) so boot overlaps the user typing; raise `sleepAfter` for
  active sessions (cost tradeoff); show a "preparing" state. Warm turns are fine.
- **P2 — Reconstruction:** 2 RPCs via base64-tar + `exec` unpack (§8), not N per-file writes — there is
  no batch-write API.
- **P3 — Per-turn discovery tax:** Flue re-runs discovery every message (~8 container round-trips, 3 of
  them `exec` spawns; unconditional at `client.ts:269`, not cacheable as written). Sub-second warm for
  one small skill → acceptable for the POC; an upstream memoization (keyed on skills-dir mtime) is a
  later Flue enhancement, not POC work.
- **P4 — Outbound KV read:** `KV.get(containerId)` fires once per script egress, off the chat critical
  path. Keep the token in KV/DO, never in container env.
- **P5 — Concurrency/cost:** account limits are generous (6 TiB mem / 1,500 vCPU / 30 TB disk
  concurrent); billing is provisioned-memory × awake-time, so **`sleepAfter` is the main cost lever**.
  Use the smallest instance type that runs the skill, enforce per-tenant concurrent-container caps
  (§9.7), and alert on spend.

## 16. Multi-image future (3-4 base images) — bounded set

- CF Sandbox supports multiple base images as **one Container class + Durable Object binding per image**,
  declared statically in `wrangler.jsonc`. 3-4 toolchain images is squarely supported. "Few base images
  + inject skill files at runtime" is the right pattern — per-skill images don't scale (image sprawl,
  50 GB image-storage cap), and one fat image bloats every cold start.
- **Design hook (cheap, in the POC):** the bundle carries a `baseImage` field (§5, defaulted); a
  `baseImage → bindingName` resolver selects the Sandbox binding; **both** `getSandbox(env[binding], id)`
  and the bearer KV key derive from that **same** selected binding (§7). Adding an image later is a
  wrangler entry + a resolver row, not a rewrite. Each binding is its own DO namespace, so
  `idFromName(id)` stays globally unique across images — provided the key always uses the selected binding.
- **Ceiling (design within it):** static DO-class bindings cover only a **bounded, deploy-time** set.
  **Arbitrary per-tenant custom images are NOT supported** — that needs Workers for Platforms / dynamic
  dispatch, and whether per-tenant *containers* are supported there is an open question to validate with
  Cloudflare, not assume. Keep per-tenant variation in the injected skill **data**; keep base images a
  small fixed set.
