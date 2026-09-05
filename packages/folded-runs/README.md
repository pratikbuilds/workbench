# @corbits/folded-runs

Launch, wake, and mail machinery for folded interactive workflow runs,
hosted-service-agnostic: the shared substrate `@corbits/chat` builds on
rather than reimplementing its own copy of "start a run, send it mail,
read its mailbox." Every side effect
that touches a real host — the database, the session service, the sidecar
router, the event-collector registry — arrives as an injected
`FoldedRunsDeps` port (`./src/types.ts`); this package never imports a hub
or a host-specific package such as `@corbits/chat`.

## What this package owns

- **`FoldedRunsDeps`** (`./src/types.ts`) — the one dependency bundle every
  surface in this package takes: `db`, `sessionService`, `assetService`,
  `sidecarRouter`, `eventCollectors`.
- **Definition reading** (`./src/definition.ts`) — `readDefinitionJSON` +
  `readFoldedBody` pull a folded `WorkflowDefinition`'s launch body back out
  of its materialized workflow asset, reimplemented here rather than
  imported from `@intx/hub-api`'s hub-api-internal helper.
- **Crypto provider caching** (`./src/crypto-cache.ts`) —
  `createCryptoProviderCache` mints one `CryptoProvider` per cache key
  (a workbench id, an instance id, ...) and reuses it while the key stays
  in active use, via `@corbits/collections`' `createExpiringMap` with a
  7-day idle ttl refreshed on every access (CL-7223): a key going
  momentarily unreachable (idle sleep, a sweep) does not evict it, so
  only a key nobody has asked for in a week is treated as gone for good.
  Independent cache instances mint independent keys for the same string,
  so a host constructs one process-wide cache and passes it to every
  mail sender (chat, webhook, routine, one-shot) rather than constructing
  one per consumer (CL-7284).
- **Run lookups** (`./src/runs.ts`) — resolving a run by id or address, and
  bridging a run's principal to its live session via the shared-principal
  bridge.
- **Launch** (`./src/launch.ts`) — `launchFoldedRun`/`deployAtHead` start a
  folded interactive run: the same address family (`principalId` set,
  `deploymentId: null`) `POST /workflows/runs` produces, not the native
  workflow-deploy-anchor path.
- **Wake** (`./src/wake.ts`) — `wakeFoldedRun` re-deploys a folded run's
  instance when the sidecar no longer has it resident, from a caller-supplied
  `foldedBody` (this package has no launch-body table of its own to read).
- **Mail** (`./src/mail.ts`) — `sendFoldedMail`/`sendFoldedMailWithRetry`/
  `listFoldedMail`: signing and persisting a message into a run's mailbox,
  and walking that mailbox with keyset pagination.
- **Agent event recognizers** (`./src/agent-events.ts`) —
  `connectorReplyContent`/`messageRunEnded` parse the sidecar `agent.event`
  frames every folded-run observer keys off. `@corbits/chat`'s own
  process-wide orchestrator subscribes to this stream and needs the same
  two readings, so the parsing lives here once instead of duplicated
  elsewhere.
- **The one-shot reply runner** (`./src/one-shot-reply.ts`) —
  `runOneShotFoldedPrompt` is a synchronous "launch one folded run, send one
  prompt, await exactly one reply" primitive: it launches a run, sends
  `prompt` as its opening mail, and resolves with the accumulated
  `connector.reply` content once the run's `message.run.ended` bracket
  closes, or rejects with `FoldedRunFailedError` (the run itself ended
  `"failed"`) or `FoldedRunTimedOutError` (its timeout elapsed first). It
  exists for a caller with no Inbox to hang an async delivery on — a
  Myra one-shot drafting/planning call (`@corbits/agent-directory`'s
  `agent-definition-drafting.ts`)
  turns that same stream into an awaitable promise instead of tracking a
  long-lived run. Every settle path (success, run failure, timeout, or a
  send-path throw) tears the launched run down through the required
  `undeploy` port before the outer promise resolves or rejects — a
  one-shot run has no further purpose once it settles.

## What the host must inject

- `FoldedRunsDeps` — `db`, `sessionService`, `assetService`,
  `sidecarRouter`, `eventCollectors`, the same bundle every surface in this
  package shares.
- For `runOneShotFoldedPrompt` specifically: `events: SidecarEventEmitter`,
  `cryptoProviders: CryptoProviderCache`, a required `undeploy: (address,
reason) => Promise<void>` (the host's own termination primitive — e.g.
  `apps/hub`'s `sidecarRouter.sendAgentUndeploy`), and an optional
  `lifecycle?: Pick<AgentLifecycle, "track" | "recordActivity" |
"untrack">` for idle-sleep bookkeeping shared with the rest of the
  process's launched runs.

## What this package never imports

- Nothing host-specific: no `@corbits/chat`, no `apps/*`. Every side
  effect that touches a real host arrives as an injected port.

## Running tests

```sh
cd packages/folded-runs && bun test
```

Tests run against injected fakes for `FoldedRunsDeps`; no `DATABASE_URL`
is required.
