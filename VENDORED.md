# Vendored code

This file is the ledger of every vendored path in the repository. Workbench
consumes third-party code as published packages; vendoring is a sanctioned
escape hatch for the rare case where a needed capability is not published —
never a convenience.

## Rules

- Vendoring is hand-copied files only — never a git submodule.
- Every vendored path has exactly one row in the ledger below. Code copied into
  the tree without a ledger row is not vendored; it is a bug.
- Every entry carries a **kill date** — the date by which the vendored copy is
  replaced by a published package or deliberately renewed — and a dated test
  that fails after that date. An entry with no kill date is not an entry.
- The ledger row, the kill date, and its dated test land in the same commit as
  the copied files.
- Local changes to vendored code land in this repository through normal review.
  The upstream repository is never modified, committed to, or pushed to.
- Retiring a vendored copy closes the entry: delete the row, the files, and the
  kill-date test together.

## Ledger

| Vendored path                 | What was copied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Upstream repo @ commit                                                                                   | Why not a published package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Owner  | Kill date  | Kill-date test    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------- |
| `apps/sidecar`                | Derived from upstream's own `apps/sidecar`: six modules byte-identical (`default-harness.ts`, `signing-keypair.ts`, `source-asset-delivery.ts`, `workflow-closure-apply.ts`, `workflow-probe-handler.ts`, `workflow-run-pack-restore.ts`), three near-verbatim (`atomic-write.ts` differs only by the repo-wide logger namespace), the rest (`index.ts`, `config.ts`, `tool-materialization.ts`, `step-agent-tools.ts`, `workflow-host-wiring/`, `workflow-substrate-factory/`, …) substantially rewritten, plus workbench-only modules. A living fork, not a frozen copy, so this row carries no tree hash. | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | An app is never npm-published, so no publish can cover the execution host; retired by consuming an upstream-published host, or by renewing this row deliberately                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/agent`           | `@intx/agent` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the operator-configurable doom-loop threshold (`afd0c82b`, `c421c092`) the re-vendored `workflow-host` configures; one local delta (CL-7190): `ToolBundle.beforeToolExtension` (`tool.ts`) and its composition into `ResolvedTools.beforeToolExtensions` (`agent.ts`), so a tool package can contribute its own suspend-capable extension without the reactor or director special-casing it by name; retired by the next `@intx/agent` publish                                                                                                                                                                                                                                                                                                                                             | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/db`              | `@intx/db` source (`src/`, `migrations/`, drizzle config, manifest, tsconfigs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 covers the base package but not the `wire_projection` column/loader delta (CL-6324) or the `workflow_definition.origin` column separating a definition from the per-run record of one folded run's deploy (CL-6452), shipped as migrations `0086`/`0087` behind upstream's `0085_add_approval_run_idx`, plus `0088` rewriting the retired `onBodyFailure: "continue"` literal to upstream's `"tolerate"` in stored wire projections, plus `0089` adding `workflow_definition.schedule_claimed_minute` for the hub's native ScheduleTrigger poller (CL-4455); retired when upstream absorbs the deltas                                                                                                                                                                                               | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/harness`         | `@intx/harness` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the connector reply drain (`driveConnectorReplies`, `ConnectorReplyDrain`, `AgentEventStream`; `11590e66`) the sidecar's warm mail loop drives; no local delta; retired by the next `@intx/harness` publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/hub-agent`       | `@intx/hub-agent` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the `agentDir` path export (`927556de`) the sidecar's deploy-tree lookup uses, and its own `@intx/mail-memory`/`@intx/harness` pins must resolve the vendored copies; one local delta (CL-6396): `SessionEventSink` / `publishWorkflowInferenceEvent` stamp optional `childRunId` on `agent.event`; retired by the next publish                                                                                                                                                                                                                                                                                                                                                                                                                                                            | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/hub-api`         | `@intx/hub-api` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 covers the base package but not the null-principal `resolveApproval` for policy-resolved decisions (CL-6345) or the bearer-authenticated workflow-deploy mirror (`middleware/workflow-run-deploy-auth.ts`, CL-workflow-deploy-bearer); retired when upstream absorbs the deltas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/hub-sessions`    | `@intx/hub-sessions` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 covers the base package but not the pack-acceptance fixes (`ownsWorkflowRunRepo`, `anchorAddressForPackSource`, `decideTerminalRunFlip`), the adopted deploy front + `sourceRef` (CL-6324), the wire-projection writer (CL-6324), malformed tool-call-name sanitization (CL-6478), the sealed-run terminal-status backfill (CL-6595), the CL-7190 `registerSignalCorrelation` approval-only guard (fails loud on a future `SignalKind` this RPC has no persistence for, rather than silently mis-persisting one), or the CL-6396 `childRunId` forward on `agent.event`; CL-7443 retires CL-7191's `UserMessageParams.correlationId`/`sendUserMessage` plumbing (`ask_user` no longer parks a `message_response` gate for a plain chat message to resolve); retired when upstream absorbs the deltas | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/inference`       | `@intx/inference` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates doom-loop detection (`8da4c827`, `afd0c82b`, `c421c092`); one local delta: `providers/google-genai-files.ts` builds its upload body as `new Uint8Array(bytes)` because TS 6's lib.dom `BodyInit` rejects `Uint8Array<ArrayBufferLike>` (upstream compiles ESNext-only under TS 5.9). CL-7443 retired CL-7190's `message_response` resume branch in `reactor.ts`'s `resumePendingOperation`/`timeoutMessageFor` and its `reactor.test.ts`/`testing/fakes.ts` regression harness, back to zero tests; retired by the next publish                                                                                                                                                                                                                                                            | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/mail-memory`     | `@intx/mail-memory` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the `@intx/mailbox` extraction (`af03bb90`), on-demand body reads (`54f7c239`) and `expunge` returning the swept uids (`bcabb1f8`) that the re-vendored `workflow-host` binds against; no local delta; retired by the next publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/mailbox`         | `@intx/mailbox` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | Never published: a new package at the target pin (`af03bb90`) that `workflow-host`'s substrate mailbox store and supervisor-backed transport import; no local delta; retired by its first publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/mime`            | `@intx/mime` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the non-RFC message-id guard `isMessageId` (`d97e1832`), the full `References` chain (`65c6fe70`) and the lossless `decodeMail` decoder (`3b6d06b2`) that `mailbox`/`mail-memory` at the same pin import; no local delta; retired by the next publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/types`           | `@intx/types` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the type surface the re-vendored trees compile against: `expunge` returning `expungedUids` (`bcabb1f8`), plain-string `PackRejectReason` (`7b42f405`), the run authorization/approvals REST types (`71ad6c08`), the decoded-mail `Mail`/`MailPartReader` model (`3b6d06b2`) and the `interchange.actions`/`loops` package-json refs (`3bd5b837`, `1ea2f39b`); CL-7443 retired CL-7190's local delta (`"message_response"` added to `signals.ts`'s `signalKinds`, alongside `signalKindToGateType`) back to upstream's approval-only shape; one remaining local delta (CL-6396): optional `childRunId` on `AgentEventFrame`; retired by the next publish                                                                                                                                    | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/workflow`        | `@intx/workflow` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | No local delta: npm 0.3.0 predates the `onBodyFailure: "tolerate"` section policy (`b977ade6`) that `@corbits/agent-runtime` authors and the action/loop primitives (`3bd5b837`, `1ea2f39b`) the re-vendored `workflow-host` runs; retired by the next `@intx/workflow` publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/workflow-deploy` | `@intx/workflow-deploy` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | No local delta: npm 0.3.0 predates `inertLoopBody` and the loop-body source pin (`1ea2f39b`) that the re-vendored `hub-sessions` imports; retired by the next `@intx/workflow-deploy` publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/workflow-host`   | `@intx/workflow-host` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 covers the base package but not the body-spawn authorize/credential/mail-part-reader threading and grants head-collapse (CL-6448) that let the fork run tool-bearing onTrigger bodies, or the CL-6396 event-channel `childRunId` stamp so overlapping turns HMAC-bind the occurrence they belong to; retired when upstream absorbs the deltas                                                                                                                                                                                                                                                                                                                                                                                                                                                       | sawyer | 2026-10-26 | `check:killdates` |

The pin is `a8bc06ae` (upstream `origin/main`, 2026-08-27), 72 commits past
the `v0.3.0` release tag `b5580a02`. npm is still `0.3.0`, so every tree a
re-pinned tree imports at a newer API is vendored too, at the same commit —
a vendored tree never mixes pins: `agent`, `db`, `harness`, `hub-agent`,
`hub-api`, `hub-sessions`, `inference`, `mail-memory`, `mailbox`, `mime`,
`types`, `workflow`, `workflow-deploy`, and `workflow-host`, plus
`apps/sidecar`. The npm-consumed names whose source is byte-identical
between `v0.3.0` and `a8bc06ae` stay on npm `0.3.0`: `authz`, `crypto`,
`hub-common`, `log`, `pack-transport`, `storage-isogit`, `tool-packaging`,
`inference-catalog`. The root `package.json` `overrides` point every
vendored name at `workspace:*` (so the published `@intx/harness`,
`@intx/hub-agent`, `@intx/tool-packaging`, `@intx/authz`, … resolve their
own `@intx/*` dependencies onto the vendored copies instead of a second npm
copy) and every unchanged name at `0.3.0`.

Local modifications (all surviving `vendor/intx/*` rows): each package's
exports map is repointed from the upstream `intx-src` resolve condition to
direct TypeScript source resolution (`types`/`default` → `./src/...`), with
`dist/` references and the `customConditions` entry in the shared tsconfig
removed — workbench forbids custom resolve conditions — and each tsconfig
carries `types: ["bun"]`. `vendor/intx/*` (CL-7226) additionally gained the
workspace-wide TypeScript project-references cutover: a `tsconfig.src.json`
with `composite: true` and `references` generated from real workspace
`dependencies`, while `tsconfig.json` stays the combined, conventionally
named project (extends `tsconfig.src.json`, adds `test`) so tools that
discover a project by looking for a file literally named `tsconfig.json`
— ESLint's `projectService`, an editor, a bare `tsc` invocation — still
find one without being told the composite project exists at all. The same
shape every other package in the workspace got in the same change, so a
vendored package's build participates in `tsc --build` like any other.
`vendor/intx/hub-api` (CL-6345) accepts
`principalId: null` on `resolveApproval` for a decision a standing-grant
allowance already authorized, skipping the per-principal resolve gate the
HTTP routes still enforce. `vendor/intx/hub-api` (CL-workflow-deploy-bearer) adds
`middleware/workflow-run-deploy-auth.ts`, an optional bearer-authenticated
mirror onto the SAME session-cookie `POST/GET .../workflows/deployments`
route `routes/workflows.ts` already mounts (that route file is otherwise
untouched — no deploy logic is duplicated). It is the missing bearer path
every other workflow-run write surface (skills, capabilities, routines,
agent-directory) already has: a workflow-run agent has no browser session,
only its sidecar bearer token and its own run address. `MountHubRoutesDeps`
and `CreateAppOpts` gain an optional `workflowRunAuthenticator`; when
supplied, the new middleware mounts ahead of `createResolveTenant` (which
already short-circuits once `principal`/`tenant` are set — the same seam the
git-token/asset bearer routes use), so a bearer-authenticated request reaches
the exact same handler as a human session: same `requireGrant("workflow:*",
"create")` gate (already in `SEED_GRANTS`, so no grant changes were needed),
same asset tenant-scoping (a foreign-tenant asset already read as `not_found`
before this change and still does), same install/probe/gate/freeze call into
`sessionService.deployWorkflowFromSource`. A request with no bearer
credential falls through unchanged to the session path.
`vendor/intx/hub-sessions` also drops the
live-status gate on `receiveWorkflowRunPack`'s anchor lookup: the gate is now
the exported pure helper `ownsWorkflowRunRepo` (a self-anchored `workflow_run`
row with a routable address), with the allocation fences unchanged. Upstream
required `status in (deployed, running)`, which wedged every terminal run that
still had mail in flight into a permanent loop — the run's own inbox-enqueue
and `markConsumed` rejection packs were refused as `path_violation`, the
sidecar withheld the ack, and the hub redelivered forever
(`docs/revendor-inventory.md`). `vendor/intx/hub-sessions` (CL-6361) also
widens that same anchor lookup to resolve a per-step pack source address
(`deriveStepAddress`'s `<runId>-<stepId>@<domain>`,
`@intx/workflow-deploy`'s `orchestrator.ts`) back to its base run's
anchor address via the new pure helper `anchorAddressForPackSource`. Upstream
keys the lookup on an exact `workflow_run.address` match, which only the
anchor row ever carries; a multi-step deployment's per-step agents push their
own event-log commits (e.g. a step named `write`) under their step-suffixed
address, so every such pack was rejected `path_violation` with "source
address has no deployment anchor it owns," the sidecar withheld the ack, and
the hub redelivered forever — the same infinite-retry shape as the terminal-run
case above, one layer up the address hierarchy. `vendor/intx/workflow-host` (CL-6448) threads the parent child's
credentials-backed authorize, live `CredentialWiring` and `MailPartReader`
through the suspendable-child (onTrigger body) spawn seam:
`RunSuspendableChild`'s input and `createInMemorySpawnSuspendableChild`'s
opts gain the three optional fields, and `run-child.ts` passes them when
building the body resolver, so a body agent's tool calls gate through the
same per-step grant snapshot a top-level step's do, its tool bundles resolve
credentials, and an attachments-only inbound mail resolves its parts instead
of throwing. `findStepGrantsEntry` collapses a single-step deployment's sole
grants entry onto a body step whose own id the parent snapshot never lists.
Upstream never runs tool-bearing body agents, so the seam has no upstream
analog. `vendor/intx/workflow` carries no local delta: upstream `b977ade6` ships the
`onTrigger` body-failure policy workbench had vendored as
`onBodyFailure: "continue"` (CL-6326, CL-6324) under the literal `"tolerate"`,
so the authoring site (`@corbits/agent-runtime`) says `"tolerate"` and `@intx/db`
migration `0088` rewrites the retired literal inside stored wire projections. `vendor/intx/hub-sessions` (CL-6324) adds a third
code-sourced deploy front, `deployAdoptedCodeSourcedWorkflow`, which deploys
onto shared capacity while adopting an anchor `workflow_run` row the caller
already owns. Neither upstream front can: `deployWorkflowFromSource` inserts
its anchor row, which collides with a folded run's existing one, and threads
no credential cipher; `deployPreparedCodeSourcedWorkflow` updates a
pre-existing row and threads the cipher but only under the
allocation-ownership lock, so it cannot run on shared capacity. The new front
composes the same private halves and follows the prepared front's semantics
minus that lock. `vendor/intx/db` and `vendor/intx/hub-sessions` (CL-6324) together
persist a definition's evaluated inert projection at approval time:
`workflow_definition_version` gains a `wire_projection` jsonb column
(migration `0086_workflow_definition_version_wire_projection.sql`, renumbered
from `0085` when upstream `a8bc06ae` took that slot and from `0084` before
that; the drizzle-kit journal keeps our original `when` timestamps, which
still sort after upstream's `0085`. Workbench applies the platform SQL by
sorted filename through `scripts/db-setup.ts`, which replays from scratch
and refuses a schema set up under a different file list, so a database
migrated before a renumber is reset, never patched — `scripts/db-setup.test.ts`
pins that refusal),
`createDbFrozenApprovalWriter` stamps it in the SAME transaction that
writes `approved_wire_hash`, and `loadFrozenWireProjection` reads it back
validated as a `WorkflowProjectionDefinition`. Upstream carries no
hub-side record of a deployed definition's body at all — under the
`workflow.json` retirement the body is whatever the source closure
evaluates to on the sidecar, and a source-format asset holds no envelope
to read it back from — so every hub-side launch that needs the body (a
folded run's system prompt, tool pins, model, credential bindings) had
nowhere to get it. Keyed to the approved wire hash and stored beside it,
this is one store per concept, not a second copy: the projection and the
hash that addresses it are written and read together.
`vendor/intx/hub-sessions` (CL-6379) classifies an accepted workflow-run
pack's newly-terminal runs through the new pure `decideTerminalRunFlip`
before the DB flip: a section occurrence's repo-local child run
(`turn__<n>`) has no `workflow_run` row by design and is skipped quietly
instead of being logged as a foreign-deployment violation on every turn.
`vendor/intx/hub-sessions` (CL-6478) adds a
`sanitize-tool-name.ts` module and calls it from `event-collector.ts`'s
`tool_call` handling: `@intx/inference`'s `decodeToolName` is deliberately
total and returns a hallucinated or provider-mangled function name
verbatim, but `encodeToolName` throws when that same name is put back on
the wire for the next turn's outbound request — persisting a decoded name
unchecked meant the room's very next turn died rebuilding its request,
permanently, once the bad name was durable. Only a name `encodeToolName`
can re-invert is now persisted as-is; anything else collapses to a stable
`malformed_tool_call` placeholder before it reaches `turnPart`, so a single
bad tool-call name fails that turn cleanly instead of wedging the room.
`@intx/inference` is added to `vendor/intx/hub-sessions`'s own
`package.json` dependencies for this.
`vendor/intx/hub-sessions` (CL-6595) fixes `workflow-run-kind.ts`'s
newly-terminal detection, which skipped a run's `events.jsonl` subtree
entirely (`enumerateEventBlobs` only walks per-event `<seq>.json` files),
so a run sealed from birth — its whole event log arriving pre-combined in
one push, with no per-event blobs ever landing — never fired `markTerminal`
and stayed "running" in `workflow_run.status` forever despite the run
having genuinely finished; `validatePush` now also scans a newly-sealed
run's combined log for its terminal event, and `hub-session-lookups.ts`
gained a same-push defense-in-depth backfill via the new
`readCommittedWorkflowRunTerminalStatus` export, in case a future pack still
slips past the primary detection.
Each package's `VENDORED-FROM` file restates its own delta.

`apps/sidecar` records `a8bc06ae`: the fork tracks the closure-sourced
lineage and, at this pin, adopts upstream's warm-agent mailbox (the
supervisor-backed transport's inbound half, the mailbox watch registry and
mutation bridge, the connector-thread seed and reply drain), the
self-terminated-supervisor address reclaim, the live-child grants refresh
after an approval, the `agentDir` deploy-tree lookup and the disposer
`AggregateError`. Its defining delta stays: onTrigger bodies run WITH tools
(`bodyInvokeStep`), and every step env -- body or top-level -- gets the
mailbox read surface.

### Un-vendoring `vendor/intx`

- [ ] Delete `vendor/intx/` and remove `vendor/intx/*` from the root
      `package.json` workspaces.
- [ ] Restore the `@intx/*` dependencies in `apps/*`, `packages/*`, and
      `workflows/*` to the published npm version that covers each surviving
      tree's delta, and drop the root `overrides` pins.
- [ ] Delete the `vendor/intx/*` ledger rows above and the local-modifications note.
- [ ] Drop the `vendor/intx/*` rows from `scripts/checks/kill-dates.txt`.
- [ ] `bun install`
- [ ] `bun run check`
