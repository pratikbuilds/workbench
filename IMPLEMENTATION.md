# Implementation

The concrete stack behind [ARCHITECTURE.md](ARCHITECTURE.md)'s structure
and [PRODUCT.md](PRODUCT.md)'s surface.

## Runtime and language

- **[Bun](https://bun.sh)** >= 1.2 — package manager, task runner, and test
  runner across the whole workspace.
- **TypeScript** — the implementation language throughout `apps/`,
  `packages/`, and `workflows/`.
- **[Hono](https://hono.dev)** — the HTTP framework the hub and its mounted
  package routers use.
- **[Vite](https://vitejs.dev)** — builds the web app.

## Data

- **Postgres** (17, with the **pgvector** extension) — the platform
  database, reached through `DATABASE_URL`.
- **[Drizzle](https://orm.drizzle.team)** — the ORM/query layer, both in
  vendored `@intx/db` and in workbench-owned packages that need their own
  tables (e.g. `packages/chat`'s `chat` schema, `packages/skills`'s
  `skills.skill_access`).
- Package-owned migrations run through each package's own migration
  runner; see [docs/package-migrations.md](docs/package-migrations.md).

## Trust boundaries

**[arktype](https://arktype.io)** schemas validate every request body, env
value, and piece of external data at the point it crosses into the system
— never an `as T` cast on untrusted input. `.env` validation at `bun run
dev` startup reports every missing or malformed value at once, using the
same discipline.

## UI

**[@corbits/react-ui](https://github.com/corbitsdev/react-ui)** is the
shared component library workbench consumes rather than reimplementing —
core, reusable components live there; only workbench-specific composition
(the shell, page layout, feature-specific screens) lives in this repo. It
is pinned to a specific upstream commit rather than a floating version
range.

`@corbits/chat-ui` owns the conversation surface. The composer's host
seam is `ComposerHandle`: `insertText` splices at the caret (Mention);
`setText` replaces the whole draft (Edit a previous prompt) and is the
layer that clears leftover slash, mention, invite, and attachment state
so a replaced draft cannot send under the old picker's rules.

## Vendored `@intx/*`

Interchange capabilities are consumed as published `@intx/*` npm packages
wherever a publish covers what's needed. Where a capability is not yet
published, it is vendored — hand-copied into `vendor/intx/<package>`, one
row per path in [VENDORED.md](VENDORED.md), the authoritative ledger. Each
row carries the upstream commit it was copied from, why it isn't a
published package yet, an owner, a **kill date**, and a dated test
(`check:killdates`) that starts failing after that date — forcing either a
re-pin to a fresher upstream commit or a cutover to the published package.
Vendoring is hand-copied files only, never a git submodule; the upstream
repository is never modified. Local modifications to vendored code (e.g.
repointing an export map from `intx-src` resolve conditions to direct
TypeScript source, since workbench forbids custom resolve conditions) are
recorded per-package in each vendored package's own `VENDORED-FROM` file.

## Commands

| Command            | What it does                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`      | Validates `.env`, verifies the database, applies pending migrations, builds the web UI if needed, starts the hub and one sidecar |
| `bun run setup`    | Provisions the bench for the administrator account                                                                               |
| `bun run seed`     | Deploys the default workflow set and plants the tenant catalog's model data                                                      |
| `bun run reset`    | Drops the platform database schema and clears on-disk asset directories (local `DATABASE_URL` only, unrecoverable)               |
| `bun run check`    | The full gate: `typecheck && lint && test` — must pass before every commit                                                       |
| `bun run test`     | Workspace unit/integration tests                                                                                                 |
| `bun run test:e2e` | End-to-end smoke tests (`scripts/e2e/*.test.ts`)                                                                                 |
| `bun run format`   | `prettier --write .`                                                                                                             |

`bun run dev` seeds only the administrator account; `setup` and `seed` are
run separately against the running stack and are safe to re-run.
`ANTHROPIC_API_KEY` is the one optional variable worth setting before
`bun run seed` — without it, everything still runs, but inference errors
until a key is set and seeding is re-run.

## Acceptance mechanism: the e2e browser walkthrough

`bun run test:e2e` is the acceptance bar for a working system, not just
unit coverage. Each file in `scripts/e2e/` spawns a real hub process
(some also spawn a real sidecar) against a scratch database and drives it
entirely through its own HTTP API — no mocking inside the process under
test. The `smoke-*.test.ts` suite covers, one scenario per file: sign-up
authorization, onboarding provisioning, a full chat round-trip (create,
post, read, invite), an artifact upload-and-retrieve round-trip, and a
signed webhook delivery launching a real run.

Each suite owns and rebuilds its own `<database>_e2e` sibling database on
every run, so it can never touch a developer's working database. The
suite needs zero real credentials: `startHub` only forwards an explicit
env allowlist, so a real `ANTHROPIC_API_KEY` in the shell never reaches
the spawned hub, and every inference source in a test points at the hub's
own `noop-inference` endpoint or an unreachable placeholder host —
enforced by `assertNeverRealProvider` in `scripts/e2e/harness.ts`. CI infers
required-ness from `CI=true` so a missing `DATABASE_URL` fails loudly there
instead of silently skipping. Start Postgres locally with
`docker compose -f docker-compose.test.yml up -d`.

## Deployment

Deployment is explicit via **Pulumi**, targeting **Railway**. CI runs
tests only — nothing auto-deploys on `main`; a deploy is a deliberate,
separate action.

**Where sidecars run** is one variable, `SIDECAR_PROVISIONERS`. Unset —
the default — the hub registers the `process` backend alone and runs each
exclusive sidecar as a child process on its own host, so a single-server
install works with no configuration. `docker` and `e2b` are the other
shipped backends. See
[docs/sidecar-provisioners.md](docs/sidecar-provisioners.md) for the
comparison, the required settings per backend, and how to add another.

## Workbench Definition (shipped)

`WorkbenchDefinition` (`WorkbenchDefinitionSchema` in
`templates/index.ts`) is the one type for a named picker row:
default agents, routines, tools, plugins `{required, optional}`, and
ordered `onboardingSteps`. A template is a shipped definition, not a
second kind. `instantiateWorkbenchTemplate` resolves the definition
against a bench over injected ports, including `beginOnboarding(steps)`.

Create (`apps/web`'s `instant-agent-create.ts`) mints an empty
`kind: "workbench"` channel with no host and no `definitionId`,
instantiates, then `POST /workbenches/:id/onboarding`
(`packages/chat/src/routes.ts`) posts the walkthrough from
`system@<workbenchId>` — a `connect-github` block carrying the
definition's title, promise, and step labels. The card is not posted as
a side effect of hosting an agent.

`settleConnectedService` (`packages/chat/src/connect-pending.ts`)
clears both `connections/pending` and `template/pendingConnections`. A
template-key-only match posts `connection.connected` from the system
address and does not `dispatchTurn`. A generic pending match still
wakes the asking agent.

That settle is not the whole of a tool-package connect. Bindings for
pinned packages (`pinnedPackageCredentialBindingsFor` in `apps/hub`)
fold only at deploy, so a live assistant launched before the key was
pasted cannot `resolve` the new handle from the old snapshot.
Connecting a `feedsTools` connector (hub `settleServiceConnection`,
e.g. Manus → `@corbits/manus-tools`) therefore also fire-and-forget
relaunches live assistants that pin that package
(`reconcilePinnedToolPackages`). Persist-only — stamp the pin onto the
launch row and leave the run — is the bug that was fixed. Connectors
with no `feedsTools` skip the pass. Same posture as CL-6687 inference
reconcile on provider connect; see
[docs/credential-wiring.md](docs/credential-wiring.md) for the
inference path and the provider plugins (`http-x-manus-api-key` among
them).

## GitHub connect (shipped)

The in-room `connect-github` card and the Plugins/Connections GitHub row
are **PAT-first** (CL-6345): the person pastes a personal access token;
the host tests and stores it through `@corbits/connections`' generic
`github/complete` route. The card then flips in place to pick repos
(`startReviewingRepos`), including when GitHub is already connected —
the in-room card reads live state; there is no `/new` already-connected
dialog. A GitHub App / hosted OAuth welcome mat is CL-6343 and is not
the current product path — do not document OAuth as the first Connect
step, and do not treat a PAT paste as a defect against an OAuth-first
welcome mat that has not shipped.

The room posts that card from `system@<workbenchId>`
(`POST /workbenches/:id/onboarding` in `packages/chat/src/routes.ts`).
`packages/chat-ui` renders a system-sender `connect-github` block as a
scene: no author row, no avatar, no "Member" label; the job title and
optional promise stay put while the body flips. Step labels come from
the block's `steps` array — an empty or omitted array does not draw a
step list. The current-step marker ("You're here") is applied only when
there are exactly three steps (connect / pick / review); `data-state` on
the step is colour, never the only signal. After the server has recorded
repos, the body is the reviewing state (repo names plus a `change repos`
control). Clicking `change repos` is client-local in
`connect-github-block-container` and does not mutate the recorded
selection. `onReviewingStarted` posts canned introductions from
`packages/code-review/src/introductions.ts` under each reviewer's own
address in roster order. Consecutive `workbench.agent-joined` rows
collapse to one line in `packages/chat-ui/src/timeline.tsx`.

Optional `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` exist for
that future hosted path; leaving them unset is normal. See
`docs/connect-cards.md` and PRODUCT.md's Code review first minute.

## create_agent and specialist DMs

`@corbits/agent-directory-tools`' `create_agent` creates a specialist
definition in the caller's tenant and, by default, opens that
specialist's own 1:1 — never an invite into Myra's DM.

- **Default** (`invite` omitted or true): POST
  `/api/workflow-chat/participants/mint-dm` (`mintAgentDm` in
  `@corbits/chat`). That find-or-reopens the `kind: chat` for
  `(bench, definition)`, matching `POST /workbenches`. The agent
  launches into that chat, not the caller's.
- **`invite: false`**: create the definition only — no mint-dm and no
  invite.
- **Extra agent into `kind: chat`**: POST
  `/api/workflow-chat/participants/invite` (and the session invite
  path) returns **409** `kind_is_chat` when the target is a DM and the
  definition is not that chat's first/same agent. Same-definition
  retry reuses the resident.

A create-succeeded / mint-failed split is a completed tool result that
names both halves, not a bare error.

## Canva MCP connect (shipped)

Canva is the `canva` MCP preset (`templates/connectors.ts`):
`https://mcp.canva.com/mcp`, `connectionMode: "oauth"`, with the 16
advertised PRM scopes space-joined onto RFC 7591 DCR `clientMetadata.scope`
(`createMcpOAuthProvider` in `packages/connections/src/mcp-oauth.ts`).
Other presets omit `oauthScopes` and stay on the SDK's SEP-835 PRM
fallback.

Connect-time probe and credential fetch share
`mcpOriginPinnedFetch` (`packages/credential-providers/src/mcp-origin-pinned-fetch.ts`):
pin to the stored origin, extra first hop only
`https://mcp.canva.com` → `https://canva.ai` (not a host suffix),
`redirect: "manual"` so a 302 is never followed. `/start` classifies
DCR/client refusal as `client_rejected` versus unreachable discovery as
`discovery_failed` (`packages/connections/src/mcp-oauth-routes.ts`).
RFC 7591 `invalid_redirect_uri` (and `invalid_client_metadata`,
`invalid_client`, `unauthorized_client`) count as `client_rejected`; the
route clones 4xx/5xx JSON before the MCP SDK 1.30.0 maps unknown codes
onto `ServerError`.

A successful OAuth callback probes with the new token and, on success,
appends `toolCount` to the Plugins return query. The Canva row
(`packages/plugins-ui/src/mcp-preset-cards.tsx`) shows that count when
it is a non-negative integer; otherwise the row stays "Connected".
`@corbits/mcp-tools` per-request timeout is two minutes
(`MCP_REQUEST_TIMEOUT_MS` in `packages/mcp-tools/src/mcp-client.ts`) —
above the SDK's 60s default, below a five-minute chat turn.

These are unit-tested control-flow facts. Live Canva OAuth against
Canva's own servers is **not** verified; do not document a proven live
handshake.

## Workbench-host default inference

`selectDefaultInferencePreferences`
(`packages/chat/src/inference-preferences.ts`) builds the preference
list a workbench host launches with (`workbenchHostInferencePreferences`
on the chat adapter; also `tenantDefaultModel` on agent-definition
routes). It keeps credentialed completion-capable offerings
(`preferCompletionCapable` in `@corbits/connections/model-capability`
— embedding names never win) and, when any survivor is
`origin.direct`, picks from that direct set only. Inherit-only catalogs
still sort among inherited completion rows.

Ollama connect is the case that used to lose: discovery
(`GET /api/tenants/:id/models`) includes inherited `CATALOG_SEEDS` rows,
so the curated name (`CATALOG_SEEDS.ollama.models[0]`) could win a
name-sort without living on the instance. `resolveOllamaModelSource`
(`packages/onboarding/src/complete-credential.ts`) therefore also reads
tenant-owned `GET /api/tenants/:id/catalog/models` (paginated
`ModelResponse` envelope) when discovery contains that curated name. A
non-empty owned list restricts candidates to those names; an empty owned
list keeps inherited discovery. Other providers still pin
`CATALOG_SEEDS[provider].models[0]`.

Ollama's OpenAI-compatible endpoint can also emit a declared tool call
as a JSON object in `content` instead of native `tool_calls`.
`@intx/inference`'s OpenAI parser only reads `delta.tool_calls`, so
that JSON would otherwise land on the timeline as assistant text and
the tool would never run. `@corbits/ollama-adapter`
(`reclassifyInlineToolJsonEvents` in
`packages/ollama-adapter/src/inline-tool-json.ts`) rewrites a content
stream that is exactly that object into `inference.tool_call.*`
events, gated on the tools declared for the request. Salvage requires
a plain object whose keys are only `name` plus exactly one of
`parameters` or `arguments` (optional `id`), and a `name` in the
declared set. Unknown names, no-tools requests, extra keys, arrays,
mixed prose, fenced JSON, and incomplete objects stay text.

The assistant definition (`workflows/assistant`) also tells Myra to
invoke tools only through tool calls — never by writing a JSON object
with a tool name into the reply — and not to `memory_search` a bare
greeting.

## Related docs

- [README.md](README.md) — quickstart, local setup, repo layout, e2e detail
- [AGENTS.md](AGENTS.md) — working conventions, commit sequencing, coverage
  floor
- [VENDORED.md](VENDORED.md) — the vendoring ledger
- [docs/package-migrations.md](docs/package-migrations.md) — how a
  package's own migrations run
- [docs/model-seeding.md](docs/model-seeding.md) — how the catalog seed
  data is curated

## Open questions

- The single-command install path mentioned in README.md ("Workbench will
  install and run with a single command... does not exist yet") is not
  yet built; source checkout remains the only supported path as of this
  writing.
- Whether Pulumi stacks/config live in this repo or a separate
  infrastructure repo is not established in the docs reviewed for this
  pass.
- Live Canva MCP OAuth (DCR, redirect allowlist, and post-OAuth probe
  against `mcp.canva.com` / `canva.ai`) is not verified as of CL-7083.
