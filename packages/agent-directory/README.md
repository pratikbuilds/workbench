# @corbits/agent-directory

Creates agent definitions as workflow assets the tenant can browse, invite,
and launch: the single-step folded workflow a hand-authored agent
materializes as (`agent-workflow.ts`), request validation (`validation.ts`),
and the hub routes that create a definition and manage its attached skills
(`routes.ts`) — server-side, backed by `@intx/agent`, `@intx/workflow`,
`@intx/hub-sessions`, and Postgres via `@intx/db`.

## Runtime tool-package pins are always versioned

Every pin this package writes onto a definition (`create_agent`'s
`toolPackagePins`, guided capability-add's `POST /:definitionId/capabilities`)
resolves to a concrete, published version — never the npm "any version"
range `*`, and never a range or tag like `latest`, `^1`, `~1.2`, `>=1.0.0`,
or `1.x`; `NonWildcardToolPackagePin` (`src/agent-workflow.ts`) requires
`semver.valid`, an exact version. `resolvePinnedVersion` (and
`createPinnedVersionResolver`, `src/tool-package-version.ts`) resolves a bare
package name to `{ name, version }` by reading the tenant's (possibly
inherited) `corbits-tools` `package-registry` asset and picking the highest
version among its tarballs — preferring a stable version over a
higher-sorting prerelease; a prerelease only wins when the registry carries
no stable version for that package at all. Resolution throws the same
`CapabilityOutOfInventoryError` guided capability-add's inventory check
throws when the registry or the package is absent, so every caller's
existing 4xx mapping covers it with no new wiring. `create_agent`'s own
multi-pin create shares one `createPinnedVersionResolver` across every named
pin, so a five-pin create still costs one registry lookup and one tarball
listing, not five.

This matters because a `*` (or any non-exact) pin would let a later tarball
landing in the registry silently change what an already-deployed specialist
runs, with no record of the change (CL-7389). Resolving a version only
happens when a pin is newly added or a definition is newly created with
named pins:

- A plain redeploy of an existing definition (`PUT /:definitionId`) never
  touches tool-package pins at all, let alone re-resolves one — it keeps
  whatever version its existing pins already carry, even after a newer
  tarball lands in the registry.
- Guided capability-add re-adding a package **already pinned** on the
  definition also keeps its existing stored version rather than
  re-resolving — re-adding is a no-op on the version, never a silent bump
  to whatever the registry's newest tarball happens to be today. Only a
  name with no existing pin resolves fresh against the registry. Bumping an
  existing pin to a newer published version is a distinct, explicit action
  this package does not yet expose.

## `/client` subpath contract

`@corbits/agent-directory/client` (`src/client.ts`) is the browser-safe
counterpart: the "what counts as a user-facing agent" rule a directory UI
applies once definitions and instances are already in hand. Kept apart from
the root export so a browser bundle never pulls in `@intx/agent`,
`@intx/workflow`, `@intx/hub-sessions`, `drizzle-orm`, or `hono` — this
subpath imports none of them.

This extends the package's existing charter (agent definitions, broadly)
rather than living in a new sibling package: both halves answer "what is an
agent definition/instance, and which ones does a person actually see,"
just at different points in the request lifecycle.

**Owns:**

- `purposeAgentDefinitions` / `purposeAgentInstances` — drops the chat
  anchor machinery's channel-host rows; those are internal plumbing, never
  an agent a person created. `purposeAgentInstances` also takes an
  `excludeRunIds` set for folded chat runs (invited agents) that
  self-anchor like real deployments under a real `definitionId`, which the
  name-based filter alone can't catch.
- `filterDefinitions` / `filterInstances` — full-text search across the
  fields a person actually reads (name, description), never a raw id.
- `isOrphanedInstance` / `definitionsById` — flags an instance whose
  `definitionId` the tenant's own definitions listing no longer carries
  (deleted, or scrolled past a page's fetch window), so a UI marks it
  instead of silently hiding it.

**A host injects:** its own definition and instance lists, already fetched
from wherever it gets them (`apps/web/src/agents-api.ts`'s
`loadAgentDirectory`, for this repo), and the folded-run-id set for
`excludeRunIds` (from `@corbits/chat-ui`'s
`foldedRunIdsFromChannels`, for this repo) — this subpath issues no
request and holds no state of its own. Every function is generic over the host's
concrete row type (constrained to the minimal shape it reads), so a host's
richer types pass through untouched.

**Depends on:** `@corbits/chat/workbench-host-naming` directly — a domain
package's naming contract, not app state, so it is a package dependency
rather than something a host injects.

**Never imports:** no `apps/web`-specific state, no UI framework — this
subpath is plain TypeScript, safe in any browser bundle or server context.

## Running tests

```sh
cd packages/agent-directory && bun test
```

Tests run against fake definition/instance rows; no `DATABASE_URL` is
required.
