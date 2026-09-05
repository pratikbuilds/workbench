# Workbench — Agent Guide

Corbits Workbench is the multiplayer workspace for humans and agents — teams
and AI agents working side by side in shared [benches](docs/GLOSSARY.md),
with the same threads, workflows, and inbox. It is the default
implementation of the Corbits Platform: a set of pluggable libraries, with
[Interchange](https://github.com/faremeter/interchange) at the core,
offering agents, workflows, and multi-tenant capabilities. Everything
composes as a library another build could plug in — hardcoded,
build-specific machinery is a defect — and every external side effect sits
behind human approval.

## Ground rules

- **Interchange is the platform.** Credential resolution, agent launch,
  session orchestration, LLM inference, ID generation, and the workflow
  runtime belong to `@intx/*` — never reimplement them. Consume `@intx/*` as
  published npm packages wherever a publish covers the needed capability; no
  git submodules, no custom resolve conditions. If a needed capability is
  unpublished, vendor it with attribution and say so in the PR — never fork
  silently. Every vendored path gets a ledger row with a kill date in
  [VENDORED.md](VENDORED.md), the authoritative ledger of any active vendored
  paths; hand-copied files only, never a submodule, and the upstream
  repository is never touched.
- **Apps stay generic; packages own the domain.** A product rule inside
  `apps/*` belongs in a package.
- **Where each kind of thing lives.** Deployable services in `apps/`, domain
  packages and root-bucket modules in `packages/`, workflow definitions in
  `workflows/`. Root-bucket modules are operator-installed and may declare
  routes, migrations, credentials, and grants; sandboxed installables use
  Interchange's native contracts and never get root-bucket powers.
- **No fallbacks.** Cut over cleanly — never leave a legacy path beside a
  new one. Config and manifest objects are explicit literals; the one
  exception is an optional key under `exactOptionalPropertyTypes` (see
  below), where `...(x !== undefined ? { k: x } : {})` is the only correct
  way to omit it and is not a fallback.
- **Self-documenting code over comments.** Name things so the code explains
  itself; a comment is for the rare "why" the code cannot express, never a
  restatement of what it does.
- **Parse at every trust boundary.** arktype schemas for env, request bodies,
  and external data; never `as T` untrusted input.
- **Core UI components live in
  [corbitsdev/react-ui](https://github.com/corbitsdev/react-ui).** Build
  reusable components there and consume them here; only workbench-specific
  composition lives in this repo.
- **This repo is public.** No secrets or credentials, ever — `.env.example`
  is the only tracked env file. Anything sensitive or on-the-fence (client
  names, internal context, infra/deploy rulings) goes in Linear, not in
  commits, PRs, or docs.

## Working conventions

- `bun run check` (typecheck, lint, test, structural checks) must pass
  before every commit. `check:structural` is a single runner
  (`scripts/checks/run.ts`) that discovers and runs every
  `scripts/checks/*.ts` file with an `import.meta.main` entry point;
  CI's `structural` job runs that same `bun run check:structural`, so
  local and CI can never enumerate a different set of checks. Run one
  check on its own with `bun run check:structural <name>` (e.g. `bun run
check:structural report-error`), forwarding flags after it (e.g.
  `bun run check:structural report-error -- --write-baseline`). There is
  no standalone `check:<name>` script anymore — `check:<name>` in prose
  anywhere in this repo (this file included) means `bun run
check:structural <name>`.
- Commit sequence per change: tests first ("Add tests for X"), then
  implementation ("X: what changed"), then docs ("Update docs: X"). One
  logical change per commit; commit messages are written for a public
  audience.
- Worktrees live in `.worktrees/<branch>`; branch = `cl-<issue#>-<slug>`.
- Remaining test/CI flags (what breaks if unset):
  - `DATABASE_URL` — DB-gated suites skip locally with a banner naming
    `docker compose -f docker-compose.test.yml up -d`. On CI jobs that
    provision Postgres (`e2e`, `isolation`, `db-suites`), `CI=true`
    turns a missing URL into a hard failure via `dbGate`. The unit
    jobs (`build-test`, `structural`, `lint`, `typecheck`) never
    provision Postgres and still skip.
  - `HUB_DATA_DIR` — hub boot fails. This is required runtime config,
    not a test flag.
  - `CI` — set automatically by GitHub Actions (`true`). Not a caller
    flag; `dbGate` infers required-ness from it.
  - `ISOLATION_DATABASE_URL` — optional override for the isolation
    suite; unset falls through to `DATABASE_URL`.
  - `E2E_PROVIDER` / `E2E_PROVIDER_API_KEY` / `OLLAMA_BASE_URL` — live
    inference e2e (walkthrough, greeting-delivery, play, proof
    scripts). Unset stays on the noop/stub path; the suite still runs.
  - `EVAL_PROVIDER` / `EVAL_PROVIDER_API_KEY` — live evals. Unset is
    plumbing-only (`bun run eval` still runs against the stub).
  - `WORKBENCH_CHECK_CONCURRENCY` — override `scripts/run-all.ts`
    parallelism. Unset uses a core-count heuristic (all cores on
    GitHub Actions, cores-2 locally).
  - `E2E_LOG_DIR` — optional directory for hub/sidecar e2e logs.
    Unset does not capture them.
  - `CHROME_PATH` — browser walkthrough looks for Chrome here first.
    Unset falls through to platform defaults and fails if none exist.
- Tests are meaningful red/green tests only — no coverage theater. Unit
  tests for pure modules sit next to the source they cover
  (`src/**/*.test.ts`); multi-module / DOM / composition suites stay under
  a package `test/` tree (or top-level e2e).
- A fresh worktree has no `node_modules` symlinks until `bun install` runs.
  To check whether a workspace package exists, look in `packages/`, not
  `node_modules` — an absent `node_modules` entry means "not installed
  yet," not "doesn't exist."
- Bun loads repo-root `.env`, so an unset test inherits
  `HUB_DATA_DIR=.data/hub` inside this work tree. The hub's git-on-disk
  init then walks up to the enclosing `.git`, and a genesis commit can
  land on the working branch and delete the checkout. Tests that boot
  the hub or exercise seed/deploy git paths must call
  `installDisposableHubDataDir()` from `test/disposable-hub-data-dir.ts`
  (it mktemps outside any work tree and clears
  `HUB_ALLOW_GIT_INSIDE_WORK_TREE`). Local `bun run dev` may set that
  opt-in; tests must not. Run those suites with
  `HUB_DATA_DIR=$(mktemp -d)` as a belt-and-suspenders override. Never
  delete the `HUB_DATA_DIR` env key itself.
- `scripts/checks/*` are heuristics over source text, not proof — they can
  and do false-positive (install artifacts read as vendored trees, comments
  read as imports, class names read as user copy). A check failure is a
  claim to go verify, not a verdict.
- CI green is not "it works." `scripts/e2e/browser/walkthrough.ts` exists
  because API-only e2e suites kept passing while the real UI broke — drive
  the app through it (or by hand) before calling a UI change done.
- Deployment mechanics (tooling, target, where infra config lives) are not
  settled enough to state here — see IMPLEMENTATION.md's Deployment
  section and its Open Questions before assuming anything about how or
  where this deploys.

## Conventions a check enforces

A rule a check enforces has zero violations; a rule stated only in prose
drifts the moment it's inconvenient — everything above this section is
prose. Prefer these over remembering the rule; each is backed by a
`scripts/checks/*.ts` file that `check:structural` (`scripts/checks/run.ts`)
discovers and runs, so a violation fails CI rather than waiting for review.

- Report every caught error through `reportError` from
  `@corbits/error-sink` — never a bare `catch {}`, never a toast alone. It
  attaches operation/tenant/room/agent context and a `refId` a person can
  quote to support, and redacts secrets before anything reaches a log
  sink. Unlike every other rule in this section, this one does not yet
  hold retroactively: the report-error check fails a catch clause that
  neither calls `reportError` nor rethrows only when the catch is new or
  the current change's diff touches its line; a pre-existing catch is
  instead recorded in `scripts/checks/report-error-baseline.txt`, a debt
  ledger — not an allowlist — of 280 violations as of this check landing,
  each one a real bug still to fix. Regenerate it with `bun run
check:structural report-error -- --write-baseline` after fixing (or
  newly opting out) entries; a stale entry with no matching violation
  fails the check, so the ledger can only shrink. A violation already
  tracked on its own ticket opts out instead with a `report-error-ignore:
<reason>` comment on the catch or in its body — that's for a violation
  actively being fixed, never a way to clear a baseline entry quietly.
- A package's `browser-safe` subpath (e.g. `@corbits/inbox/client`) may
  never import a server-only dependency (`postgres`, `drizzle-orm`,
  `hono`, any `@intx/*`) — the browser-safe-subpaths check walks the real
  import graph from each declared entry point.
- A `{ name, version }` tool-package pin literal must match the pinned
  package's own `package.json` version — the tool-package-pins check
  catches the mismatch. A tool package's `src/` changing without a version
  bump is the other half of that class, caught separately by
  tool-package-freshness: it diffs against the base ref (a GitHub
  `pull_request` job reads `pull_request.base.sha` from
  `GITHUB_EVENT_PATH`; locally it falls back to the merge base with
  `origin/main`) and flags any tool package whose `src/` differs from that
  base while its version stayed the same. With no base ref available
  (no `origin/main`, no pull-request event) it no-ops, deferring to CI as the
  authoritative run.
- Every package needs a `LICENSE` file (canonical LGPL-2.1-or-later text,
  copy from any existing `packages/*/LICENSE`) — the licenses check fails
  without one.
- A dependency declared once in the root `catalog` (bun's workspace
  catalog) must be consumed as `catalog:` everywhere — the catalog-pins
  check fails a literal range for a catalogued dependency, which is how
  the same package silently ends up pinned two ways.
- `tsconfig.base.json` sets `exactOptionalPropertyTypes: true`: an absent
  key and an explicit `{ foo: undefined }` are different types. Assigning
  `undefined` to an optional field the compiler expects omitted is a
  recurring CI break — omit the key instead (see the spread-literal
  exception under Ground rules).

Every other rule in this file is unchecked prose. If you find yourself
relying on one under time pressure, that's a sign it should become a
`check:*` script — ticket it instead of trusting memory.

## Docs map

- [README.md](README.md) — quickstart and repo layout
- [PRODUCT.md](PRODUCT.md) — what Workbench is and why
- [ARCHITECTURE.md](ARCHITECTURE.md) — system structure
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — concrete stack, deployment, open
  questions
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution flow and CLA
- [LICENSE.md](LICENSE.md) — GPLv2 with AI Exception
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities
- [VENDORED.md](VENDORED.md) — the vendoring ledger and its rules
- [DESIGN.md](DESIGN.md) — the UI design system canon; a screen that
  disagrees with it is wrong until a review changes the doc
- `docs/` — architecture and design docs, added as the system grows;
  owner rulings and internal decisions belong in Linear, not a doc here
