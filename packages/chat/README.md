# @corbits/chat

Workbenches as the workbench's chat surface: workbench lifecycle (create, join,
invite), message send with mention fan-out, threads, reactions, pins,
poll/form block responses, settings, tenancy (workbenches as child tenants),
cross-tenant workbench sharing gated by bilateral trust, and the SSE stream a
workbench's UI subscribes to. A workbench anchor is a folded interactive
workflow run — this package launches and wakes it through
`@corbits/folded-runs`, never reimplementing that machinery itself.

## Composing with `@intx/*`

This package consumes Interchange's published surfaces rather than
reimplementing them: `@intx/hub-api` and `@intx/hub-sessions` for session
and instance machinery the platform_adapter builds its `ChatPlatform` port
from, `@intx/workflow` and `@intx/workflow-deploy` for the workbench-host
workflow definition and its deployment, `@intx/db` for schema/query
primitives, `@intx/authz` for grant checks, `@intx/crypto` for signing,
`@intx/mime` for attachment validation, `@intx/log` for logging, and
`@intx/types` for shared wire types. It also depends on
`@corbits/folded-runs` (launch/wake/mail for folded runs) and
`@corbits/agent-lifecycle` (idle-sleep/wake-on-mail).

## Key modules

- **`src/routes.ts`** — the full HTTP surface: workbench lifecycle,
  message send/list, settings, read-state, typing, and the SSE stream.
- **`src/workbench-workflow.ts`** — the workbench-host workflow definition: a
  folded, single-agent run whose mailbox is the workbench's shared timeline.
- **`src/platform-adapter.ts`** / **`src/platform-port.ts`** — the
  `ChatPlatform` port this package needs from its host, and the hub-side
  implementation composed from `@corbits/folded-runs`. The adapter does
  not mint its own signing-key cache: the host injects one
  `CryptoProviderCache` so chat sendMail shares keys with every other
  folded-mail sender in the process.
- **`src/chat-orchestrator.ts`** — turns invited-agent replies and
  approval-gate events into workbench messages and in-chat approve blocks.
- **`src/workbench-service.ts`** — workbench-level orchestration above the
  platform port: joining an agent, sending with mention fan-out,
  provisioning a bare space workbench.
- **`src/workbench-tenancy.ts`** / **`src/workbench-share.ts`** — workbenches as
  child tenants, and cross-tenant workbench projection gated by
  `src/federation-trust.ts`'s bilateral trust.
- **`src/threads.ts`**, **`src/reactions.ts`**, **`src/pins.ts`**,
  **`src/block-responses.ts`** — thread identity, message reactions,
  pinned messages, and poll/form response persistence and aggregation.
- **`src/schema.ts`** / **`src/migrations.ts`** — this package's own
  Postgres tables (`chat` schema) and their package-owned migrations.

## Running tests

```sh
cd packages/chat && bun test
```

Tests use the in-memory store doubles (`createInMemoryChatStore` and
siblings) rather than a live database, so no `DATABASE_URL` is required.
