# Seed reconciliation

How workbench's automatic seeding converges on the shipped defaults
without ever fighting a member. Every seed pass — a hub boot, an
onboarding run, boot-time seeding — must satisfy four properties:

1. **Idempotent restart** — re-running creates nothing twice.
2. **Content convergence** — a changed shipped default updates the
   seeded row to the current version.
3. **Member edits win** — a row a member touched is never overwritten,
   re-enabled, resurrected, or deleted by a later pass.
4. **Orphan handling** — a default that no longer ships is retired
   (hidden or removed), never left dangling — unless a member made the
   row theirs.

Ambiguity always resolves toward property 3: when a pass cannot prove a
row is still seed-owned, it leaves the row alone.

## Template library (first library read)

`createTemplateLibrarySeeder`
(`packages/artifacts-hub/src/template-library.ts`) runs
`seedTemplateLibrary` for the tenant whose shelf is being read, on the
`GET /api/tenants/:id/library/templates` routes themselves. Each shipped
template manifest becomes one versioned artifact row (`kind:
workbench-template`, title = template id), and the seed records the
SHA-256 of the content it last wrote in the artifact's
`source.seededContentHash`.

The trigger is the read, not a boot window, because template rows are
tenant-scoped: every bench owns its own shelf, so a bench created long
after the hub booted converges the first time its picker opens, in any
boot order. One pass per tenant per process, shared by concurrent first
reads; a failed pass is not remembered, so the next read retries rather
than the shelf staying empty until a restart. A read whose pass failed
answers 503 — never a 404, which would read as "no such template".

- The marker distinguishes "the shipped manifest moved" (head content
  still equals the marker: write a new version) from "a member edited
  this" (head content diverged: keep, outcome `kept`).
- A template dropped from the manifests is archived with
  `source.retired` when still seed-owned; re-adding it unarchives and
  converges (`restored`). A member's own archive — no `retired` flag —
  stays archived.
- Rows seeded before the marker existed adopt one when their content
  still matches the shipped manifest, and are otherwise preserved.
- A member-created artifact sharing a template's title is never touched
  and never duplicated.

## Default scheduled workflows (onboarding / boot-time seeding)

Seed never POSTs `/routines`. Native `ScheduleTrigger` ticks digest;
last-30-days-research stays a deployed workflow, not a wrapper row.
`scripts/db-setup.ts` drops a leftover `routines` schema after the
digest enablement handoff. There is no preset-wrapper prune: seed does
not plant wrapper rows.

## Default vs. on-demand catalog workflows (CL-7074)

`DEFAULT_WORKFLOWS` (`packages/seeding/src/seed.ts`) is the set every
real signup gets automatically: `assistant` (Myra), and nothing else. A
fresh bench used to also pay a git push and a sidecar probe for `echo`,
`workbench-digest`, and `last-30-days-research` — three workflows
nobody had asked for yet. Those three, plus every other
`workflows/<name>` source package that exports a builder
(`code-review`, `granola-call`, `morning-brief`, `exa-topic-watch`,
`process-granola-call`, `attio-task-agent`, `pain-point-collateral`,
`reddit-opportunity-scanner`, `collateral-generation`,
`diligence-brief`), now live in `CATALOG_WORKFLOWS`, same shape
(`DefinitionWithAgentSteps`-backed `DefaultWorkflow` entries) and
deployable through the catalog instantiate route (CL-7073), but never
automatically at signup.

Registration is total, not partial: `packages/seeding/test/workflow-source-registration.test.ts`
asserts every directory under `workflows/` appears in exactly one of
`DEFAULT_WORKFLOWS`, `CATALOG_WORKFLOWS`, `CATALOG_TEST_WORKFLOWS`, or
the explicit `EXCLUDED_WORKFLOW_SOURCES` list (a one-line reason per
entry, currently empty — every source directory is registered
somewhere today). A new `workflows/<name>` package that nobody wires up
fails that test instead of 404ing silently through the catalog
instantiate route, which is exactly the drift CL-7073's critique
caught: `CATALOG_WORKFLOWS` had four entries while a template's blocks
(the GTM template's, in particular) named source packages that were
never registered at all.

There is no orphan-retire for an entry that moved from
`DEFAULT_WORKFLOWS` to `CATALOG_WORKFLOWS`: an asset already deployed
on an existing bench from before the move is left exactly as it is.
`CATALOG_TEST_WORKFLOWS` remains the separate, never-reaches-a-real-
signup set for workflows that exist only to exercise the platform
continuously.

### Deployable through the catalog (CL-7073)

`CATALOG_WORKFLOWS` is the one source of truth for which catalog asset
names have a source package under `workflows/<name>` and can be
deployed on demand. Two callers reuse it, sharing the same `buildJson`
per entry rather than each hand-rolling a definition:

- `seedTenant` (`workbench seed`, the first-login provisioning hook)
  can deploy any of `CATALOG_WORKFLOWS` the same way it deploys
  `DEFAULT_WORKFLOWS`, over its HTTP self-call path
  (`ensureWorkflowAsset` → `pushWorkflow` → `ensureDeployment`).
- The hub's `POST /:assetName/deploy` template-block route
  (`apps/hub/src/templates/template-block-routes.ts`,
  `apps/hub/src/templates/block-workflows.ts`) deploys any
  `CATALOG_WORKFLOWS` entry natively, in-process, against the tenant's
  real inference preferences — the same route that already deployed
  `code-review` for template instantiation, generalized (CL-7073) so
  `code-review` is just another `CATALOG_WORKFLOWS` entry rather than a
  hardcoded special case. Idempotent: a tenant that already carries a
  deployed definition under that asset name answers with the existing
  definition (`created: false`) rather than deploying a second time.
  `assistant` (seeded already) and `heartbeat` (test-only,
  `CATALOG_TEST_WORKFLOWS`) are never reachable through this route.

## Default skills (boot-time seeding)

`plantDefaultSkills` (`packages/seeding/src/seed.ts`) plants each
`DEFAULT_SKILLS` entry through `POST /api/tenants/:id/skills`, after
first checking `GET /api/tenants/:id/skills/:name`.

- An existing row the by-name GET finds is skipped outright.
- A `409` from the create call itself — a row the GET missed (an
  inherited/other-scope row, or a race with a concurrent seed pass) —
  is also a skip, never a fatal error. Every seed step treats
  "already exists" as done, not as a reason to abort the run the
  hub's own error advice told the operator to re-run.

## Tool registry publish (boot-time seeding, onto the root tenant)

`publishCorbitsToolsRegistry` (`packages/tool-registry-publish/src/publish.ts`)
finds-or-creates the tenant's `corbits-tools` package-registry asset,
then PUTs whatever tarball is missing. Boot-time seeding
(`apps/hub/src/system-seed.ts`) calls this onto the root tenant so
descendants inherit tarballs; the rest of seeding does not pack. Two
properties keep a failed publish from stranding a
usable-looking-but-empty asset:

- `checkToolPackageFreshness` runs **before** the asset is ever
  created — a version-bump violation aborts the publish with no HTTP
  call made and no asset row planted, so this exact failure can never
  leave a dangling registry asset behind on a fresh tenant again.
- Listing tarballs on an asset whose repo has no commits yet (a
  never-published asset, or one whose row survived from before the
  point above shipped) answers an empty list rather than throwing —
  so a re-run of `publishCorbitsToolsRegistry` treats it exactly like
  a brand-new registry and pushes every package, which is what
  actually creates the repo's first commit. Repairing a tenant with
  this history is the same operation as publishing the registry for
  the first time: restart the hub.

## Workflow deployments (boot-time seeding)

`ensureDeployment` (`packages/seeding/src/seed.ts`) treats a
workflow's `workflow_run` deployment row as seed-owned state, but the
row's `status` column is not the whole story: the hub only routes mail
to a deployment through an in-memory table (`sidecarRouter`'s
`addressIndex`, `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`)
that binds an agent address to whichever sidecar socket most recently
proved ownership of it. That table lives in the hub process, not the
database — a hub or sidecar restart empties it, while the persisted row
still reads `deployed`.

Before skipping a `deployed`/`pending` row as "already deployed",
`ensureDeployment` checks `GET
/api/tenants/:tenantId/workflows/runs/:runId/health` (a live read of
`sidecarRouter.getRoutableAddresses()`, not the stored status) and
skips only when `liveness` answers `"ok"`. A row whose sidecar is gone
is stale, not deployed: seed logs it as stale and pushes a fresh
deployment, which mints a new `workflow_run` (new anchor run id, new
agent address) on whichever sidecar is currently connected. The stale
row is left in place rather than rebound — a sidecar carries no durable
state of its own, so handing an old run's identity to a new sidecar
process would silently pretend session state survived that never did.
A genuine redeploy is the only honest repair.

## How a person adds a catalog workflow (CL-7073)

The Routines page's Available section is the read side of this
invariant, surfaced to a person rather than an operator: `GET
/api/tenants/:tenantId/workflows/available`
(`packages/workflows/src/schedule/scheduled-route.ts`,
`available-catalog.ts`) answers every `CATALOG_WORKFLOWS` asset name
with no deployed `workflow_definition` on the caller's tenant yet,
each carrying `WORKFLOW_CATALOG`'s display name and one-line
description (`packages/workflows/src/catalog.ts`), its required
connections, and whether the tenant already satisfies every one of
them — a `provider` row named after the connector id exists and its
newest `credential` is `active` (mirroring
`@corbits/settings-ui`'s `connectorStatus` exactly, without importing
a UI package into a domain package). The route is injected the
catalog's asset-name list from `apps/hub` rather than importing
`@corbits/seeding` directly: that package already depends on
`@corbits/workflows`, so the reverse import would cycle.

The web page's Add action POSTs the same
`/template-blocks/:assetName/deploy` route the GTM template's blocks
already use (`docs/seed-reconciliation.md`'s "Deployable through the
catalog" section above) — there is no second create path. A
disabled Add (a missing required connection) links to Plugins rather
than letting the request 404/500; the request itself is only ever
made once every required connection reads satisfied. On success the
entry moves out of Available into the ordinary scheduled/deployed
list the rest of the page already reads.

## Env provider credentials (hub boot)

`apps/hub/src/env-credential-plant.ts` delegates to
`plantEnvProviderCredentials` (`packages/onboarding`): keyed by the
provider's stable credential name, a provider already carrying an
active credential is not probed and its key is not overwritten — a
rotated or hand-renamed key is never touched. `seedCatalog` still
runs against that existing credential (`existingCredentialId`, no
`apiKey`) so a hub restart backfills newly curated models additively:
missing rows are planted, existing ones 409-skip, nothing is deleted.
Removing an env var never deletes the planted credential: credentials
are operator data once planted, not seeds to garbage-collect.

## Credential-bound catalog workflows (CL-7073)

Six `CATALOG_WORKFLOWS` entries — granola-call, morning-brief,
process-granola-call, pain-point-collateral, collateral-generation,
diligence-brief — declare `credentialBindings` in their definition.
`deployCodeSourcedWorkflow` (`vendor/intx/hub-sessions`) refuses to
resolve those bindings without a `credentialCipher`, and the current
Interchange pin's `POST /template-blocks/:assetName/deploy` front (the
route the Routines "Available" catalog's Add action drives) has no
seam to supply one. `catalogWorkflowDeployableOnThisPin`
(`packages/seeding/src/seed.ts`) is the one place that knows this: the
deploy route refuses these six with a 409 `not_deployable_yet` before
the deployer ever throws, and the available-catalog route marks them
`deployable: false` so the UI offers them with disabled, honest copy
instead of a working-looking Add button. These six become addable at
the Interchange re-pin (CL-7107 / PR #632, pin 692c3106), which adds
the `credentialCipher` parameter this front is missing — no code in
this ledger's callers needs to change, only the entry's derived
`requiresCredentialCipher` result once the seam exists.
