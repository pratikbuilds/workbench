# @corbits/heartbeat-workflow

The smallest workflow definition in the catalog: a single mail-triggered
step that completes immediately on every trigger. It exists to give
Interchange's scheduling and mail-trigger paths a target that can run
continuously — every few seconds, if desired — without anyone worrying
about cost.

## What it does

One step, one agent, a fixed system prompt that forbids drafting a real
reply. Each inbound mail to the deployment's trigger address is one run;
the run's own lifecycle (when it started, when it completed) is the
"timestamp result" — nothing about the reply text carries information.

## Cost profile: zero

`@intx/workflow` has no deterministic, agent-free step primitive that
the shipped hub/sidecar host can execute today — the DSL's `action`
primitive exists, but no production host wires the `invokeAction`
callback it needs, so an `action` step throws at runtime. Reaching the
DSL's only invokable primitive that performs work at all — `step` — means
going through an agent, so this definition is deployed with its
`inferencePreferences` pinned to the hub's `noop-inference` endpoint
(`packages/chat/src/noop-inference.ts`), the same trick channel-host
anchors use to avoid burning a real model call on every message. See
`NOOP_MODEL_SOURCE` in `packages/seeding/src/seed.ts` for the pin.

Under that pin, every run resolves against a constant, locally served
SSE response — no request ever reaches a real provider, so triggering
this workflow as often as scheduling allows costs nothing.

## Usage

```ts
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "@corbits/heartbeat-workflow";

const definition = buildHeartbeatWorkflow({
  triggerAddress: "heartbeat@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "noop" }],
  turnTimeoutMs: 60_000,
});

const json = serializeHeartbeatWorkflow(definition);
```

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is a
`CATALOG_TEST_WORKFLOWS` entry, kept for tests only, never seeded and
never deployed onto a real bench. `workbench-digest` is not seeded either;
it is deployable through the catalog instantiate route (CL-7073).
