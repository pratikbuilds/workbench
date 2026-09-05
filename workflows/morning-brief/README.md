# @corbits/morning-brief-workflow

A single mail-triggered step that pulls the sender's recent activity
across their connected sources and writes it up as one calm, scannable
daily brief. Ported from the OG gtm-workbench's `heartbeat` workflow
(CL-5993, a child of CL-5987's routines-catalog port) — renamed to
`morning-brief` because this repo's own zero-cost `heartbeat` catalog-
test fixture already owns that name for an unrelated definition.

## What it does

One step, one agent, tools arriving as packages at deploy time (never
inlined — see `test/boundary.test.ts`). The agent calls each source's
tool at most once, then writes a markdown reply with exactly three
fixed section headings, in order:

1. **What happened**
2. **What needs attention today**
3. **Suggested next actions**

## Sources: wired now, more later by design

| Source                           | Status        | Tool package                  |
| -------------------------------- | ------------- | ----------------------------- |
| Granola (recent call notes)      | wired         | `@corbits/granola-tools`      |
| Linear (recently updated issues) | wired         | `@corbits/linear-tools`       |
| Attio (CRM activity)             | not connected | no workbench tool package yet |
| Vercel (deployments)             | not connected | no workbench tool package yet |

The system prompt (`MORNING_BRIEF_SYSTEM_PROMPT`) is the single place
that owns the brief's structure and its degradation copy — the OG's
several bespoke merge/format tools (`heartbeat_merge_brief_sources`,
`heartbeat_format_brief_title`, ...) were workflow-specific, so they
are folded into this definition rather than ported as their own tool
packages. Only genuinely reusable integrations (Granola, Linear) stay
external.

Every source call degrades gracefully, never fails the run:

- A tool call that errors (missing credential, failed request) reads
  as "not connected" in the brief — the model is instructed to say so
  plainly and move on, never to fail the turn or invent activity.
- Attio and Vercel have no tool to call yet, so the prompt names them
  as "not connected" directly — an honest line, not a fabricated
  section.
- If every source is unavailable, the brief still gets finalized — see
  "Finalizing and persistence" below — with a teaching payload instead
  of a real brief, rather than presenting empty or padded sections as
  if there were real content.

Adding a source later (Attio, Vercel, or a new one) means: build its
tool package, add it to `MORNING_BRIEF_TOOL_PACKAGE_PINS` in this
definition, and add one line to the prompt's source list — never
restructuring the brief.

## Finalizing and persistence

The agent's last act is always one call to `morning_brief_finalize`
(`src/finalize-tool.ts`), gated behind a single human approval
(`approval: "ask"`, the platform's native tool-approval gate — see that
file's header for the full suspend/resume account). On approval, the
call persists the brief as a Library artifact via
`createWorkflowArtifact` (`src/artifact-client.ts`, duplicated from
`@corbits/artifact-tools`' client per this package's "installable data,
`@intx/*` and `arktype` only" import boundary — see
`test/boundary.test.ts`) and returns `{ id, version, title, kind,
persisted: true }`, the shape `packages/chat/src/artifact-delivery.ts`
recognizes and turns into a Library-linked chip in the thread. A failed
persist surfaces as an honest tool error, never a fabricated success.

This runs on both paths, not just the happy one:

- **Real brief**: every source that returned something feeds a normal
  brief, finalized with a real title and the full markdown body.
- **No-data path**: when every source is not connected or came back
  empty, the agent still calls `morning_brief_finalize` — with a
  teaching title (e.g. "Morning brief — no connected sources yet") and
  content that honestly explains what it would have looked for (recent
  Granola call notes, recently updated Linear issues), names the
  missing connectors by id (`granola`, `linear`), and says how to
  connect them. A run never ends in silence or a bare markdown reply —
  it always ends in a persisted, chip-visible artifact.

**Teaching-artifact kind**: `outcome` (`"brief"` | `"status-note"`) is a
required, structural argument to `morning_brief_finalize` — the model
names which shape it is calling with, but never supplies `kind`
directly, so the tool (not the prompt) decides the persisted artifact's
`kind`: `"text"` for a real brief, `"status-note"` for the no-data
teaching payload. `"status-note"` is the one teaching-artifact kind
shared by every workflow in this catalog, so the Library's kind badge
always reads "Status note" for a no-data run, regardless of which
workflow made it — never the same `"text"` kind a real brief uses.

## Usage

```ts
import {
  buildMorningBriefWorkflow,
  serializeMorningBriefWorkflow,
} from "@corbits/morning-brief-workflow";

const definition = buildMorningBriefWorkflow({
  triggerAddress: "morning-brief@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 120_000,
});

const json = serializeMorningBriefWorkflow(definition);
```

`buildMorningBriefWorkflow` bakes `@corbits/granola-tools` and
`@corbits/linear-tools` into the definition's `toolPackagePins`
(`MORNING_BRIEF_TOOL_PACKAGE_PINS` in `src/index.ts`) — there is no
separate operator step to pin them on the deployment. What still
depends on the deployer is credentials: without a real Granola or
Linear credential for the connecting tenant, each source's tool call
errors and the brief honestly reports that source as not connected
(see each package's README for its credential requirement).

## Scheduling and delivery

This package carries no schedule of its own — cadence lives as a native
`ScheduleTrigger` on the frozen definition (`@corbits/workflows`
schedule/cron), ticked by the hub poller. The OG ran daily at 13:00 UTC;
the closest match to its actual cadence (weekday mornings) is a cron
expression, since daily/weekly presets cannot express "every weekday":

```json
{
  "kind": "cron",
  "expression": "0 13 * * 1-5",
  "timezone": "America/Los_Angeles"
}
```

Delivery — posting the brief into a channel and/or the recipient's
inbox — is the scheduled-fire path's job: a matching `ScheduleTrigger`
tick launches the definition, and the run's reply lands in the
workbench it is deployed against. This workflow does not need its own
persist/notify steps for that — it only needs to reply with one clean
markdown brief.

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is `automatable: true`
but not seeded, since it needs real Granola/Linear credentials to be
useful. `workbench-digest` is not seeded either; both are deployable
through the catalog instantiate route (CL-7073).
