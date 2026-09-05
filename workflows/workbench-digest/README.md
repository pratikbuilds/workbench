# @corbits/workbench-digest-workflow

A single schedule-triggered step meant to be deployed against a
workbench's own timeline address. It fires daily at 09:00 UTC
(`0 9 * * *`) and relays a deterministic summary line straight back
into the workbench, mirroring how a workbench host's reply becomes a
workbench mail post (see `packages/chat/src/workbench-workflow.ts` and
`platform-adapter.ts`).

## What it does

One step, one agent, a system prompt that instructs relaying the
trigger's exact text with no additions, no commentary, no formatting of
its own. The schedule is fixed on the definition; this package never
computes the digest line itself, so its output is exactly as
deterministic as its input.

## Cost profile

**Pinned to `noop-inference` (default, zero cost):** deployed the same
way as `@corbits/heartbeat-workflow` — `inferencePreferences` pointed at
the hub's `noop-inference` endpoint (see `NOOP_MODEL_SOURCE` in
`packages/seeding/src/seed.ts`). Every run resolves against a
constant, locally served SSE response, so running this on a tight
schedule costs nothing. The trade-off: `noop-inference` always replies
with empty text by design (see its header comment), so under this pin
no visible digest line is actually posted — the run still proves the
scheduling and workbench-mail-posting paths stay alive, just without
visible output.

**Pinned to a real catalog model:** point `inferencePreferences` at any
configured model instead, and the relayed digest line is posted for
real, at that model's ordinary per-turn cost (a single short completion
per trigger — a few dozen tokens, not a real "reasoning" turn).

## Usage

```ts
import {
  buildWorkbenchDigestWorkflow,
  serializeWorkbenchDigestWorkflow,
} from "@corbits/workbench-digest-workflow";

const definition = buildWorkbenchDigestWorkflow({
  inferencePreferences: [{ provider: "anthropic", model: "noop" }],
  turnTimeoutMs: 60_000,
});

const json = serializeWorkbenchDigestWorkflow(definition);
```

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is `automatable`, and
deployable through the catalog instantiate route (CL-7073) from
`CATALOG_WORKFLOWS` (CL-7074), not seeded by default onto every tenant.
