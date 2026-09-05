# Chat

Chat is Workbench's shared conversation surface: teams and agents read and
write the same timeline, in the same [bench](GLOSSARY.md). A message is
workbench data — a row the hub writes and reads directly — and asking an
agent for a turn is a separate act, over the mail transport Interchange
already gives every agent. It ships as two
packages — `@corbits/chat` (the HTTP surface and domain logic) and
`@corbits/chat-ui` (the React components a host renders it with) — composed
onto the hub and the web app respectively.

## What a workbench is

A workbench holds a **timeline**: the rows in `chat.workbench_messages`
belonging to that workbench, read back in order. Posting a message is one
insert plus one publish onto the workbench's live stream (CL-6327) — no mail,
no wake, no sidecar hop — so a workbench takes messages and renders them
whether or not a single agent process is running.

A workbench has no run of its own (CL-6330): creating one mints a child
tenant and writes settings rows — no deploy, no anchor instance. Its
address (`<workbenchId>@<domain>`) is derived, not resolved; a message
reaches an agent only when the workbench asks that agent for a turn.

A workbench is also its own tenant, parented under the bench it was created
in, so its membership and permissions are native grants rather than a
chat-specific system — see [workbench-tenancy.md](workbench-tenancy.md) for
the mint, listing, and move mechanics.

```mermaid
flowchart LR
    subgraph Workbench
        Room[Room timeline<br/>workbench_messages rows]
    end
    Alice[Human participant] -->|POST message| Room
    Room -->|timeline read| UI[Chat UI]
    Room -.->|turn dispatch, mail| Bot["@handle agent participant"]
    Bot -.->|connector.reply, bridged| Room
```

## The message model

A message is a list of MIME parts, not a single string. The parts a workbench
supports:

- **text** — plain message text.
- **event** — a structured, machine-readable record (e.g. a participant
  joining, a settings change) rendered distinctly from authored text.
- **attachment / file** — a named blob with a media type, referenced by id
  rather than inlined, so large files are never pulled into memory just to
  render a message list.
- **block** — a generative UI card: a `{ type, data }` envelope whose data
  is agent-authored JSON, never markup or code. The typed vocabulary lives
  in `@corbits/chat`'s `blocks` module — `approve`, `steps`, `metrics`,
  `poll`, `form`, and `stream` — and `@corbits/chat-ui` renders each type
  through a closed component registry, parsing the data at the render
  boundary so an unknown type or malformed payload degrades to a labeled
  fallback card. An approve block carries only a reference to a platform
  approval plus the agent's framing (title, risk, body): action labels are
  fixed by the client and the decision's state lives on the approval
  record, never in the message. Poll choices carry no agent-authored
  tallies. Blocks render read-only today; their controls stay disabled
  until the action round-trip ships.

A message stores its `Part[]` as it is, so reading a timeline is a query, not
a decode. Asking an agent for a turn still encodes the parts onto the
platform's mail-send shape — a single text part rides as bare mail content;
anything else becomes a list of `text/plain`/`application/json` MIME
attachments — and that encoding is confined to the dispatch seam.

The dispatched frame itself carries RFC 5322 threading (CL-7450): its
`Message-ID` is `mailMessageIdFor(sourceMessageId, domain)` — the same
derivation `mailboxFanOutForSend` already stamped for that row, so the two
always agree — and `In-Reply-To`/`References` name that row's own parent
chain (`mailAncestryOf` in `./threads.ts`). This is what lets a reply's own
`In-Reply-To` correlate back to the exact row that triggered the turn,
independent of the process-local `turnMailCorrelation` bookkeeping
`dispatchTurn` also does. Degrades to unthreaded, exactly as before, on a
composition with no mailbox domain to derive it from.

## Every human's mailbox gets a copy (CL-7450)

`sendWorkbenchMessage` runs a strict order: store the row -> stamp its
RFC 5322 `Message-ID` -> fan the message into every human participant's
`@corbits/mailbox` inbox, as one batch -> publish the row onto the room's
live stream -> dispatch to whichever agents the message names. The mailbox
fan-out runs BEFORE the row is published and BEFORE any agent is asked for
a turn: a fan-out failure fails the send outright — the just-inserted row is
deleted and the failure is rethrown to the caller, never swallowed into a
send that looks fully delivered when it wasn't. Only once the fan-out batch
has committed does the row publish, giving a client-visible bubble and a
durable mailbox copy the same all-or-nothing guarantee.

This is not transactional across the row insert and the delete: the row
write and the mailbox batch are two separate commits (chat and
`@corbits/mailbox` are separate Postgres handles in the hub's own
composition), so a concurrent `GET` of the timeline in the window between
the insert and a fan-out failure's delete CAN read the row before it is
removed — no `chat.message` publish has happened yet (so no live client
sees it), but a poller hitting the REST list endpoint in that same window
can. The window is real and bounded to that one gap, not claimed away. A
fan-out failure is reported once, under one `refId`, as
`MailboxFanoutFailedError` (`./mailbox-fanout.ts`) — the send route
answers with that same ref rather than letting the hub's generic
unhandled-route-error handler report it again under a second one.

The fan-out itself writes an "outbound" row in the sender's own mailbox and
an "inbound" row in every other human participant's, all sharing the
timeline row's own `Message-ID` (`<rowId@domain>`, stamped onto
`workbench_messages.mail_message_id` — see `./mail-headers.ts`) as the
frame's threading identity; the mailbox write's own idempotency key is left
to `@corbits/mailbox`'s default (a transport key derived from that same
Message-ID plus each recipient's principal and direction), never a
caller-minted one. The whole batch is ONE `@corbits/mailbox` transaction
(`writeMailboxMessages`): every row commits together or none does, so a
retry after a genuine failure re-attempts every recipient rather than
risking a partial delivery. An agent participant never gets a mailbox row
this way — its inbox is its run's own live mail queue, reached through
`WorkbenchMail.sendMail` instead. Each row carries a
`{ kind: "workbench", id }` ref back to the room it came from, and threads
under its parent via `In-Reply-To`/`References` when the message answers
one (`mailAncestryOf` in `./threads.ts`).

A shared workbench's rows live in the OWNING tenant, never the acting
(projected) tenant a share member sends from: the row's `Message-ID` and any
`In-Reply-To` are minted against the owning tenant's own mail domain, and
every recipient — the sender included — is addressed under that same
domain. The acting sender's principal is resolved in the OWNING tenant, not
the tenant they authenticated against; when a share member has no principal
row there at all, that sender's own outbound copy is skipped quietly (a
debug log, not a report) since it is the expected shape for a share member,
while every other human participant still gets their row. Any OTHER
participant address with no matching principal in the tenant — a stale or
removed member — is reported and skipped rather than attempted; any other
batch failure is reported and re-thrown. See `./mailbox-fanout.ts` for the
fan-out logic and its `MailboxWriter` seam, and `./platform-port.ts`/
`routes.ts`'s `mailbox` dep for how a host wires a live `@corbits/mailbox`
instance in.

## One turn in flight per workbench (CL-6331)

A workbench claims itself before it asks any agent for a turn: `dispatchTurn`
runs behind a `WorkbenchTurnQueue` (`packages/chat/src/turn-queue.ts`), keyed
by `workbenchId` rather than thread — an owner call, since a workbench's
agents share one room and a second agent starting a turn while the first is
mid-review is exactly the collision this closes. A message arriving while a
turn is already in flight for its workbench queues instead of dispatching,
and the room is told live (`chat.turn-queued`, non-persisted — a queued
message's own row already carries it on the timeline; this is only the
"still waiting" signal a client renders as a queued strip). Once the
in-flight turn's claim releases, everything that queued behind it dispatches
together as **one** next turn, recipients unioned and parts concatenated in
arrival order — never as N separate turns replaying one after another.

The claim (`packages/chat/src/turn-claims.ts`) reuses the tryClaim/release
shape `write-claims.ts` proved out for the finalized-turn write surfaces,
not the same table: a turn claim is in-memory, process-local state, released
once `dispatchTurn`'s own call settles. That is an honest, disclosed gap —
at this seam `dispatchTurn` only reaches "the mail was handed to the agent's
mailbox," not "the agent's turn actually finished" (the real turn, and its
own completion signal, move to this seam in CL-6329) — so a claim also
expires on a TTL (`turnTimeoutMs`) as the backstop against a dispatch that
never settles at all, rather than wedging a workbench behind it forever.

A host that composes more than one send surface against the same
`ChatPlatform` (the hub wires `createChatRoutes`, the workflow-participant
router, and the Slack tag mount this way) constructs one `WorkbenchTurnQueue`
and injects it everywhere, the same "one instance, shared" pattern
`workbenchSubscribers` already follows — otherwise each surface would only
serialize against its own traffic, not the others'.

## Turn = run: room agents as `onTrigger` sections (CL-6329)

Every agent invited into a room deploys as an **`onTrigger` section keyed
on (agent, workbench)**: one warm run per pair, every message an
occurrence, every occurrence its own child run with its own run id and
event log. The shape lives in `@corbits/agent-runtime`
(`buildAgentRuntimeWorkflow`, `mode: "section"`), and
`platform-adapter.ts`'s `ROOM_AGENT_MODE` is the single place that pins
it — one switch feeding both the wake and the relaunch path. The
workbench itself has no host run and no occurrences to name; only invited
agents deploy as sections.

`onBodyFailure: "tolerate"` — authored in the section shape itself — is
the failure edge: a turn that ends `failed` records the failed occurrence
and leaves the section subscribed, so one bad turn kills neither the agent
nor the room. The runtime names an occurrence's child run `turn__<n>`,
which is what `agentRuntimeTurnRunId` derives and what a reply's `run_id`
carries.

- **The dispatch seam** (`dispatchTurn` in `workbench-service.ts`) opens
  a projection row before it touches the execution plane, so an in-flight
  turn is visible from its first moment and the child run id its reply
  will carry is already allocated. Firing the section's trigger is still
  a `sendMail`, because a mail trigger is what the section subscribes on
  — but what it starts is an occurrence, not another turn folded into one
  endless step.
- **Context assembly** (`packages/chat/src/turn-context.ts`) —
  `assembleTurnContext` builds the conversation a turn is asked with from
  message rows: the turn's own thread (never the whole room when a thread
  is named), capped to the workbench's resolved `chat/contextWindow`, with
  the dropped span folded into one bounded recap rather than silently
  lost. Thread membership lives in its own store, so the scope is injected
  as a `TurnContextThreadScope` rather than this module reaching for a
  second store.
- **The turn projection** (`packages/chat/src/agent-turns.ts`, table
  `chat.agent_turns`) — one row per turn, opened as the turn starts and
  closed as it settles, carrying the child run id, the messages it was
  asked to answer, the message it produced, and how it ended. This is
  deliberately **our** projection rather than a read of the platform's own
  run tables: a room has to answer "which run produced this reply, and how
  did that turn end" from its own rows, at timeline speed, whether or not
  the execution plane is reachable. Occurrence allocation happens inside
  the insert with a unique index behind it, so two dispatches racing for
  one agent can never quietly share a child run id. `GET
/workbenches/:id/turns` and `GET /workbenches/:id/turns/:turnId` serve
  it, following the same "no store, no feature" contract `pins` already
  does.

**Where a reply finds its turn.** The sidecar's `agent.event` frames carry
the agent's address and nothing finer — no occurrence id — so the reply
path matches on the newest still-`running` turn for (workbench, agent).
The one-in-flight-turn-per-workbench claim is what makes that
unambiguous in the common case; under a burst that opens more turns than
the runtime runs occurrences, older rows can be left `running`. Closing
that gap properly needs the runtime to report the occurrence id on the
event, not a heuristic here.

**Stale turns fail, never zombie (CL-6451).** A dispatch can die without
any closing event ever reaching the hub — the workflow-host supervisor's
terminal-or-park backstop failing it, or the process dying mid-turn. An
occurrence cannot legitimately outlive the per-turn timeout the section
body enforces, so both turn stores fail any row still `running` past
that timeout plus a settle grace (`AGENT_TURN_STALE_MS`) on their next
read or write: the room shows a failed turn instead of typing forever,
and the reply path can never attribute a later reply to a dead row.

**A model that cannot resolve is a failed turn, not a 500.** Wake and
mint map an unresolvable inference source to a consumer 4xx and a
failed-turn strip ("Jimmy's model isn't available here.") with an
inline picker of tenant-available chat models and a hop into that
agent's Settings — never a raw HTTP 500 or the technical resolution
dump on the timeline.

Proved live end to end by `scripts/e2e/cl-6329-turn-swap-proof.ts`: two
agents replying in one room under distinct occurrences, three rapid
messages serializing into ordered turns, and a sidecar killed
mid-occurrence leaving both the room and the section alive.

## Stopping a turn (CL-7201)

Before this, the only bound on a wedged turn was the dispatch and
wait-until-free timeouts themselves — minutes long, and no way for a
user watching an agent go wrong to do anything but wait or reload.
`POST /workbenches/:id/turns/cancel` (`packages/chat/src/routes.ts`)
closes that gap, calling `cancelWorkbenchTurn`
(`packages/chat/src/workbench-service.ts`), which runs two independent
mechanisms together because a turn can be in either place when the user
asks to stop it:

- **Still on our own call stack.** `dispatchTurnBatch` registers one
  `AbortController` per recipient it dispatches, via a workbench-keyed
  `TurnCancelRegistry` (`packages/chat/src/turn-cancellation.ts`) —
  the same "one instance, shared" pattern `WorkbenchTurnQueue` follows.
  Its signal is composed into each `withTimeout` call (`waitUntilFree`,
  `dispatchTurn`) as an **external signal** — `withTimeout` (CL-7193)
  already gives `work` an `AbortSignal` the moment its own timeout wins;
  CL-7201 extends it to also fire (with the external caller's own
  reason, not its own timeout message) the moment that external signal
  aborts, whichever comes first. `dispatchTurn`'s abort-close handler
  tells a deliberate cancellation apart from a timeout by checking
  whether the abort reason is a `TurnCancelledError`, and closes the
  turn row `cancelled` rather than `failed`.
- **Already off our call stack.** `sendMail` has no cancellable
  primitive of its own (CL-7230) — once it resolves, the agent is
  generating (or parked on an approval gate somewhere in the execution
  plane this package cannot see into) with nothing left
  registered to abort. `cancelWorkbenchTurn` snapshots every turn
  `AgentTurnStore.findRunningTurns` reports for the workbench _before_
  triggering the registry above (so a row the abort path already
  claimed is still counted), then sweeps it directly through the same
  `finishTurn` compare-and-set.

Both mechanisms race the same compare-and-set, so whichever reaches a
given row first is the only one that ever settles it or posts a notice
— `postCancelledNotice`, a `turnCancelled` text part distinct from
`postUndeliveredNotice`'s `turnFailed` (a cancellation is not a
failure, and the timeline says so). CL-7230's ceiling is honest, not
silent: settling the row is not the same as stopping the underlying
agent process. A late `connector.reply` that lands anyway finds no
`running` row left to attach to, and `postReply` will not fall back to
posting it unattached onto a 1:1 membership whose latest turn is
`cancelled`. The composer offers a Stop affordance
(`packages/chat-ui/src/composer.tsx`) whenever `isAwaitingReply`
(`streaming-reply.ts`) is true — the whole in-flight phase, including
after tokens have started streaming — independent of its own `sending`
state. A follow-up message can still be typed and queued while a turn
runs.

## Threads: workbench → thread → sub-thread

A workbench's timeline is itself a thread — its **root thread**, one per
workbench, created lazily on first use. Any message can be replied to, which
opens (or reuses) a **depth-1 thread** anchored on that message; any message
_inside_ a depth-1 thread can be **forked**, which opens (or reuses) a
**depth-2 sub-thread** anchored on that message. That's the whole model —
workbench → thread → sub-thread, stop. There is no depth 3 (owner ruling,
CL-5908): nesting a reply off a message that already lives in a sub-thread
is rejected with an honest `409 conflict` rather than silently growing a
third level.

Forking is the first-class affordance CL-5948 adds — "something Slack
doesn't have": any message inside a thread offers **Fork**, spawning a
sub-thread rooted at it. Forking from a message already inside a sub-thread
never creates a third level; it redirects to a **sibling sub-thread** under
that sub-thread's same depth-1 parent instead. Both the redirect and the
409 share one piece of pure logic, `resolveThreadAnchor` in
`packages/chat/src/threads.ts`: given the root thread and the thread a
message currently lives in, it returns where a new thread should hang and
whether that would be a third level. `openReplyThread` (implicit replies)
refuses on that signal; `forkThread` (explicit forks) redirects on it —
neither reimplements depth math.

An agent's reply lands in the thread of the message that woke its turn
(CL-6314) — the same thread, whether that message lives on the root feed
or inside a sub-thread. The dispatch records its mail id against the
message it answers, and the reply path matches the turn's
`message.run.started` bracket back to that record; after a hub restart
that dropped the process-local bracket, the running turn's last
`requestMessageIds` names the same source. Delegation needs no
separate mechanism, since a delegating message has a thread like any
other. Approve blocks and artifact deliveries thread under the turn that
produced them the same way. A reply whose waking mail was never recorded
and whose running turn names no source (a pre-rollout mail) posts
unthreaded rather than vanishing.

Every non-root thread carries a `parentThreadId` — the thread it hangs
directly off (the root thread's id for a depth-1 thread, a depth-1 thread's
id for a depth-2 sub-thread) — alongside its existing `parentMessageId`,
the origin message it answers or forks. `@corbits/chat-ui` reads
`parentThreadId` to render the breadcrumb (`Workbench / Thread / Sub-thread`,
at most three segments), to walk a fork back to its parent thread, and to
indent sub-threads under their parent in the threads menu; a forked
sub-thread also shows a small banner above its timeline linking back to its
origin message — the fork's visible back-reference.

## Participants and mentions

A workbench's participants are held in its settings as records of
`{ address, handle }`. The **handle** is the short, unique-within-workbench
name a mention actually types — `@echo`, never the underlying run's
unreadable instance id. Handles are derived from a definition's name at
invite time and de-duplicated against every handle already in the workbench
(`echo`, `echo-2`, `echo-3`, ...).

**One room participant = one live run (CL-6451).** The `/name` / `@name`
workflow commands resolve residency first
(`findResidentAgentForDefinition`, comparing by the definition's asset so
re-deployed rows still match): a definition already resident reaches the
run the room already has, never a freshly minted sibling that would then
race the original for every message. An `@name` typed as a definition's
wire name (`@assistant`) whose participant answers to a display-name
handle (`@myra`) posts as an ordinary message and rides the normal turn
pipeline into that participant's run, queueing behind an in-flight turn
like any mention. The explicit invite affordance is the one deliberate
way to place a second instance of a definition in a room — it always
launches, which is exactly what handle de-duplication ("echo", "echo-2")
exists for.

A **mention** is `@` followed by a participant's handle at a word boundary,
anywhere in a message's text. Mentioning an agent participant triggers
**fan-out**: the server sends that agent a single-recipient copy of the
message, addressed from the workbench itself rather than from the posting
principal. Sending from the workbench matters because an agent's reply
router answers the address a message came from — a principal address has
no mailbox to answer into, but the workbench's address is the mailbox every
participant already reads.

## Chats and direct messages (DMs)

`kind: "chat"` is a direct thread with exactly one counterpart, fixed at
creation and never changed afterward (`POST /workbenches/:id/invite` 409s a
chat, whichever kind of counterpart it has). The counterpart is chosen at
`POST /workbenches` time, one of:

- **An agent** — `{ kind: "chat", definitionId }`. The named definition is
  launched and joined as the chat's one participant, exactly as
  `POST /workbenches/:id/invite` joins one into a workbench (`launchAndJoinAgent`
  in `packages/chat/src/workbench-service.ts`, shared by both paths).
- **A person** — `{ kind: "chat", principalId }`. This is a **DM**: a
  two-member workbench tenancy whose second participant is an existing bench
  member, added directly with no instance to launch
  (`joinHumanParticipant`, the human-counterpart analog of
  `launchAndJoinAgent`) — a human participant reads the workbench's own
  timeline directly, so there is no mailbox to stand up, only the
  participant record and a `workbench.member-joined` audit event on the
  workbench's own timeline.

Exactly one of `definitionId`/`principalId` may be present; a `principalId`
is validated before anything is minted — it must name a real, active
`"user"`-kind principal in the calling tenant, and it can never equal the
caller's own principal id (`409 conflict`, "you cannot start a direct chat
with yourself"). Both counterpart kinds are optional on `name`: an agent
chat falls back to the agent's own handle, and a person chat falls back to
the same handle its one participant record carries — in practice always the
member's display name, since `@corbits/chat-ui`'s new-chat dialog already
has it (from the same listing Settings → People renders) and sends it as
`name` whenever the person creating the chat didn't type a custom title.

**There is no `dm: true` wire flag.** A DM is recognized the same way
everywhere it matters — `kind === "chat"` plus the absence of an
agent-shaped participant address (`isAgentAddress` in
`packages/chat/src/mentions.ts`, which is simply "does this participant's
address contain `@`" — a human participant's address is its bare principal
id). `@corbits/chat-ui`'s workbench-settings surface trims its Agents section the
same way (`workbenchSettingsSections(kind, isDm)` in
`packages/chat-ui/src/workbench-settings/model.ts` — a DM has no agent to
invite, so the section has nothing to show; Members and Danger zone are
already trimmed for every 1:1 chat, agent or person). One derivation, no
second signal to keep in sync.

## The reply bridge

An invited agent's reply is not something it posts back into the workbench on
its own — replies surface only as `connector.reply` events on that agent's
own event stream, never as mail it sends. The **reply bridge** is the piece
that turns those events into workbench messages: for each agent participant,
the platform subscribes to that agent's event stream and, on a
`connector.reply` event, posts its content onto the workbench's timeline as
a message from that agent's own address, carrying the run id it came from.

The bridge is armed when an agent is invited, and idempotently re-armed
whenever a workbench's messages are read — bridges are in-memory, so a host
restart loses them, and a read is the natural moment to notice and recreate
one.

## Bench defaults and per-workbench overrides

A workbench setting can be a bench-wide default every workbench inherits, or an
explicit per-workbench override — the same "Use bench default" vs. "Override"
shape Discord's server-default settings use. Today this applies to exactly
one setting, `chat/contextWindow` (how many prior messages a mentioned
agent sees as context):

- **Bench-wide default** — `GET`/`PATCH /bench/settings` reads and writes
  the tenant's own `chat_bench_settings` row. A bench default is never
  itself an override of anything, so it is always a plain number, never
  `null`.
- **Per-workbench override** — a workbench's own `chat/contextWindow` in its
  settings is nullable: `null` (or the key's absence) means "inherit the
  bench default," any other integer is an explicit override for that
  workbench alone.
- **Resolution** — `resolveContextWindow(workbenchSettings, benchDefault)` in
  `packages/chat/src/workbench-settings.ts` folds the two into the one
  effective value a message send actually uses, returning both the value
  and which source it came from (`"inherit"` or `"override"`). `GET`/`PATCH
/workbenches/:id/settings` include this resolved `{ value, source }` shape
  on every response, so a caller never has to re-derive it from the bench
  default and the raw workbench settings separately.

In the UI this resolved shape drives a two-state control — "Use bench
default (N)" vs. an explicit numeric field — on the workbench's own settings
panel (opened from its header, or from its sidebar row's ellipsis menu).
The bench-wide settings page only ever edits the default itself; it carries
no per-workbench editor, since a workbench's override belongs to the workbench.

## The HTTP surface

`@corbits/chat` mounts one router, under a tenant-scoped prefix, with the
following routes:

| Method & path                                                | What it does                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /workbenches`                                          | Mints the workbench's own tenant, writes its initial settings, and — for a chat — joins its one counterpart (an agent or a person; see [Chats and direct messages](#chats-and-direct-messages-dms))                               |
| `GET /workbenches`                                           | Lists the tenant's workbenches, optionally filtered by kind                                                                                                                                                                       |
| `GET /workbenches/:id/messages`                              | Reads the workbench's timeline, decoded into parts, paginated by cursor                                                                                                                                                           |
| `POST /workbenches/:id/messages`                             | Posts a message, fanning a copy to every @mentioned agent participant. `threadId` or `inReplyToMessageId` route it into a thread instead of the root feed; a reply that would nest past depth 2 is a `409 conflict`               |
| `GET /workbenches/:id/threads`                               | Lists a workbench's threads (root, delivery, replies, and sub-threads) plus its root thread id                                                                                                                                    |
| `GET /workbenches/:id/threads/:threadId/messages`            | Reads one thread's own membership, decoded into parts — never the full workbench mailbox                                                                                                                                          |
| `POST /workbenches/:id/threads/fork`                         | Forks a sub-thread rooted at any message inside a thread (CL-5948); idempotent per origin message, and redirects to a sibling sub-thread rather than nesting past depth 2 (see [Threads](#threads-workbench--thread--sub-thread)) |
| `POST /workbenches/:id/delivery-threads`                     | Creates (or reuses) the delivery thread for a routine run                                                                                                                                                                         |
| `GET /workbenches/:id/invitable`                             | Lists the tenant's deployed definitions that can be invited into a workbench                                                                                                                                                      |
| `POST /workbenches/:id/invite`                               | Launches a definition into the workbench and adds it as a participant                                                                                                                                                             |
| `POST /workbenches/:id/move`                                 | Re-parents a workbench's own tenant to a different bench                                                                                                                                                                          |
| `GET /workbenches/:id/settings`                              | Reads a workbench's settings, including its resolved context window                                                                                                                                                               |
| `PATCH /workbenches/:id/settings`                            | Updates settings, recording each change as a timeline event                                                                                                                                                                       |
| `GET /workbenches/:id/read-state`                            | Reads the calling principal's last-seen cursor for the workbench                                                                                                                                                                  |
| `PUT /workbenches/:id/read-state`                            | Advances the calling principal's last-seen cursor                                                                                                                                                                                 |
| `POST /workbenches/:id/typing`                               | Publishes an ephemeral typing indicator to the workbench's live stream                                                                                                                                                            |
| `POST /workbenches/:id/messages/:messageId/reactions/toggle` | Toggles the calling principal's reaction with a curated emoji on a message; publishes `chat.reaction`                                                                                                                             |
| `POST /workbenches/:id/messages/:messageId/pin`              | Pins a message; publishes `chat.pin`                                                                                                                                                                                              |
| `DELETE /workbenches/:id/messages/:messageId/pin`            | Unpins a message; publishes `chat.pin`                                                                                                                                                                                            |
| `GET /workbenches/:id/pins`                                  | Lists a workbench's currently-pinned messages, decoded into parts, newest pin first                                                                                                                                               |
| `GET /workbenches/:id/turns`                                 | Lists the workbench's agent turns, newest first — each carrying the child run id its reply is traceable to (CL-6329)                                                                                                              |
| `GET /workbenches/:id/turns/:turnId`                         | Reads one turn: its child run id, the messages it answered, the message it produced, and how it ended                                                                                                                             |
| `GET /workbenches/:id/stream`                                | Server-Sent Events stream of live workbench activity, including the who's-here roster (`chat.presence`/`chat.presence.snapshot`, CL-6328)                                                                                         |
| `POST /workbenches/:id/presence`                             | Refreshes the calling principal's `lastActiveAt` on the who's-here roster; 404s with no open stream connection (CL-6328) — never polled, called on real client-side activity                                                      |
| `GET /bench/settings`                                        | Reads the tenant's bench-wide chat defaults                                                                                                                                                                                       |
| `PATCH /bench/settings`                                      | Updates the tenant's bench-wide chat defaults                                                                                                                                                                                     |

Every route runs behind the hub's tenant-scoped middleware, so the calling
tenant and principal are always resolved before a handler runs; principals
never appear in a path.

## Mounting into a host

`@corbits/chat` never talks to the platform's own HTTP API or reimplements
its session, grant, or mail machinery. Instead it depends on `ChatPlatform`:
a narrow port describing exactly what the package needs — launching a
workbench or an invited agent, dispatching mail to an agent's own mailbox,
fetching an attachment's bytes, and subscribing to live events. The timeline
itself is not on that port: it is a chat-owned table behind
`RoomMessageStore`.
A host composes this port from services it already builds (a session
service, an asset service, a sidecar router, and its database), and injects
it — along with a settings store and a grant check — into
`createChatRoutes` to get a mountable router back:

```ts
import {
  createChatRoutes,
  createDrizzleChatStore,
  createHubChatPlatform,
} from "@corbits/chat";

const chatRoutes = createChatRoutes({
  store: createDrizzleChatStore(db),
  platform: createHubChatPlatform({
    db,
    sessionService,
    assetService,
    sidecarRouter,
  }),
  requireGrant,
  turnTimeoutMs: 5 * 60 * 1000,
});

app.route("/api/tenants/:tenantId/chat", chatRoutes);
```

Any host that can build an equivalent `ChatPlatform` can mount chat the same
way — the port, not this hub, is the integration contract. `turnQueue`
(see [One turn in flight per workbench](#one-turn-in-flight-per-workbench-cl-6331))
defaults to a fresh, router-scoped queue when omitted, same as
`workbenchSubscribers`; a host that also drives sends through another
surface (a workflow-participant router, a Slack mount) constructs one
`WorkbenchTurnQueue` itself and passes it to every one of them.

## Consuming it from the UI

`@corbits/chat-ui` renders the whole chat surface — sidebar, timeline,
composer, mention picker, new-workbench and invite-agent dialogs, and the live
event stream — as a single `ChatWorkspace` component. A host supplies which
bench to talk to and the current user, and mirrors the active workbench into
its own routing. Each sidebar row also carries a hover-revealed ellipsis
menu (Rename, Pin/Unpin, Workbench settings).

Workbenches are tenants, so their settings are never a dialog: the gear icon
in the workbench header routes to a full stage surface,
`WorkbenchSettingsSurface` (`packages/chat-ui/src/workbench-settings/`) —
a breadcrumb back to the workbench, a left nav grouped Shared / Personal /
Danger zone, and the active section's panel on the right. `ChatWorkspace`
takes `settingsOpen` and `onSettingsOpenChange` the same way it takes
`workbenchId` and `onWorkbenchChange`, so the host mirrors the surface into its
own routing (`@workbench/web` mounts it at `/c/:workbenchId/settings`). The
General section still PATCHes name, pinned, and the inherit/override
context-window control; Members and Agents reuse the same invite flow
already in `invite-agent-dialog.tsx` rather than duplicating it.

```tsx
import { ChatWorkspace } from "@corbits/chat-ui";
import { listPrincipals } from "@corbits/settings-ui";

<ChatWorkspace
  tenant={tenant}
  currentUser={{ principalId }}
  workbenchId={workbenchId}
  onWorkbenchChange={(workbenchId) => navigate(`/chat/${workbenchId}`)}
  settingsOpen={settingsOpen}
  onSettingsOpenChange={(open) =>
    navigate(open ? `/chat/${workbenchId}/settings` : `/chat/${workbenchId}`)
  }
  onOpenArtifact={(part) => navigate("/library")}
  listMembers={async (tenantId) => {
    const principals = await listPrincipals(tenantId);
    return principals
      .filter((p) => p.kind === "user" && p.status === "active")
      .map((p) => ({ id: p.id, displayName: p.displayName }));
  }}
/>;
```

`ChatWorkspace` talks to `@corbits/chat`'s HTTP surface directly — a host
does not hand it a client or re-derive its API calls, only tell it where to
send them and who is asking.

`listMembers` is what puts a People tab beside the new-chat dialog's
existing Agents tab: `@corbits/chat-ui` resolves no session or tenancy of
its own (see the module note atop `chat-workspace.tsx`), so the bench's
people come from the host, the same way `tenant` and `currentUser` do —
`@workbench/web` sources it from `@corbits/settings-ui`'s `listPrincipals`,
the same call Settings → People renders from. Omitted entirely, the dialog
falls back to exactly the agent-only picker it has always been — a host
that hasn't wired a member directory yet never gets a tab that silently
fails to load.

The timeline adds a day divider between messages from different calendar
days, and renders a `file` part as a clickable artifact chip once it
carries a persisted `blobId` — a still-in-flight, `data`-only attachment
renders the same chip inert, since it has no stable id yet to open. A chip
click calls the host-supplied `onOpenArtifact`, mirroring `onOpenThread`
and `onOpenProfile`: `@corbits/chat-ui` owns no router, and today a chat
blob has no stored link back to a specific Library artifact, so the most a
host can do is navigate to the Library at large — a real per-artifact deep
link (and opening in canvas rather than navigating away) is follow-up work.

A quiet typing pulse occupies the incoming-message slot after the last
timeline message — the same left indent as the next agent reply. It
lights up from two sources: the `chat.typing` event
`POST /workbenches/:id/typing` already publishes to the live stream (see
the HTTP surface table above), and an owed agent reply that has not
streamed tokens yet. `ChatWorkspace` tracks the latest human ping with a
short expiry and resolves it to the typist's participant handle, never a
raw principal id. The who-is-typing copy is announced to assistive tech;
the visual is a small three-dot bubble. The pulse stays up across tool
rounds (`inference.done` does not wipe an empty pending) and is held for
a short floor so a fast first token cannot flash it. The signed-in
reader's own messages sit on the right, like an outgoing iMessage.

### The read path: stream events apply, they never trigger a refetch (CL-6328)

`useWorkbenchFeed` (`packages/chat-ui/src/use-workbench-feed.ts`) holds the
active workbench's messages/threads/pins as three React Query caches, and
`useWorkbenchStream` (`use-workbench-stream.ts`) is the one `/stream`
connection that keeps them current. Every event that changes what those
caches hold applies straight into the cache it describes —
`applyStreamMessage`/`applyStreamReaction`/`applyStreamPin` — rather than
invalidating and refetching: `chat.message` already carries the full
rendered row (see [the message model](#the-message-model)), and
`chat.reaction`/`chat.pin` already carry the full changed row for their own
narrow concern, so a subscriber folds the delta into state it already
holds. `applyStreamMessage` also bumps the owning thread's `replyCount`/
`lastActivityAt` in the threads cache — the one piece of thread metadata a
message row itself doesn't carry. Every apply is deduped by `id`/`clientId`,
which is what lets a reader's own optimistic send (`use-optimistic-sends.ts`)
and that same send's `chat.message` echo off the stream converge on one row
instead of a refetch reconciling them: the confirmed row is written into
the cache once, from the `POST` response, and the stream's later echo of it
is a no-op.

`refreshFeed`'s coalesced `invalidateQueries` (CL-6313) still exists, but
only as the fallback poll `useWorkbenchStream` runs while the connection
itself is down or just reopening — never as a response to a live event on
an open connection. The bar this leaves is a hard one: a stream event that
can't be applied is a missing or under-specified payload in
`packages/chat/src/stream-events.ts`, fixed there, never patched over with
a refetch in `chat-ui`.

The who's-here roster follows the same rule: `chat.presence.snapshot`
seeds it the moment the stream opens and `chat.presence` deltas
(`useWorkbenchPresenceRoster`, `workbench-presence.ts`) keep it current —
no second connection, no polled HTTP heartbeat. "Here at all" comes for
free from the open stream connection itself
(`packages/chat/src/workbench-presence.ts`); the client only calls
`POST /workbenches/:id/presence` to refresh `lastActiveAt` on real
activity (a message send, the tab coming back into view), never on an
interval.

### Reactions and pinned messages (CL-6030)

Message reactions and per-workbench message pinning (the open question left
by CL-5942) are both in scope and backed by their own tables — `message_reactions`
and `pinned_messages` — in `@corbits/chat`'s own `chat` schema (see
`packages/chat/src/schema.ts`; distinct from the sidebar's whole-workbench
`chat/pinned` setting, which is unrelated). Both are presence-as-truth:
a reaction row's existence _is_ the reaction (`./reactions.ts`'s
`toggleReaction` inserts on a miss and deletes on a hit — true on/off, never
a counter that can drift), and a pin row's existence _is_ the pin.

`GET /workbenches/:id/messages` (and `GET /workbenches/:id/threads/:threadId/messages`)
attach `reactions` (a per-emoji `{ emoji, count, reactedByMe }[]`) and
`pinned` (boolean) onto every item — extending the wire type the timeline
already consumed rather than a parallel read. Both batch over the whole
page in one query each (`listReactionsForMessages`, `listPins`), and both
fields are simply absent from the wire when the host never injects the
corresponding store, the same "no store, no feature" contract
`blockResponses` already follows.

Reactions are restricted server-side to a small curated emoji set
(`REACTION_EMOJI` in `packages/chat/src/reaction-emoji.ts`, shared with
`@corbits/chat-ui`'s picker) — an emoji outside it is a `400`, never
silently accepted. Toggling and pinning both publish onto the workbench's
existing SSE subscriber registry (`chat.reaction`, `chat.pin`), live, the
same workbench `bridgeWorkbenchStream` already bridges typing and settings
events through.

In the UI, `WorkbenchTimeline` renders a reaction chip row under each message
(click a chip to toggle; an "add reaction" trigger opens the curated
picker) and a pin/unpin toggle, both hover/focus-revealed and keyboard
operable — see `ReactionActions`/`PinActions` in `timeline.tsx`. The
pinned strip the shell mock shows above the message list
(`@corbits/chat-ui`'s `PinnedStrip`) renders every currently-pinned message
as a jump-to chip; clicking one scrolls the timeline to that message's own
row (`messageDomId`).

### `ask_user` posts and ends the turn, not a park (CL-7443)

`@corbits/interaction-tools`' `ask_user` tool has no gate: it posts a
`question` block card and returns immediately with a tool result that
tells the model to end its turn — a Workbench agent is an unbounded
interactive step where every inbound mail is already its next turn, so
"ask a person" is native as "post and stop," not a structural suspend. No
correlation id, no timeout, no parked call. The person's answer arrives
later as an ordinary reply through the block-response route below, which
becomes the agent's next inbound message and therefore its next turn —
never this call's own result. (Before CL-7443, `ask_user` parked the call
on a vendored `message_response` signal/gate until a correlated reply
resolved it; that machinery, and the correlation-id plumbing it needed
through `sendMail`/`sendUserMessage`, is retired.) The tool result's
instruction to end the turn is just text in the model's context — the
runtime does not enforce it, so a model that calls another tool or keeps
talking after `ask_user` is not stopped from doing so.

Because there is no park, a warm agent's persisted pending operations can
still carry a retired kind from before this change (a `message_response`
op written by a pre-CL-7443 build). Restore drops any such unclassified
kind rather than throwing, reporting each drop — so an in-flight question
still open at deploy is simply lost: the person's eventual answer arrives
as an ordinary next turn instead of resolving anything.

### Question answers notify at most once (CL-7192)

A question block's answer is relayed into the workbench as the
responding user's own message, and the asking agent is turned on it —
but only once per question, ever. `upsertBlockResponse`
(`packages/chat/src/block-responses.ts`) is a plain "second answer
overwrites the first" write; the one-time send-and-dispatch is gated
separately by `claimBlockResponseNotification`, a guarded UPDATE on the
same row (`notifiedAt`/`notificationClaimToken`) that at most one
submission for a given (tenant, workbench, message, block, principal)
can ever win. A changed answer or a double-click that beats the UI's
disable still lands its own row and its own `block.response` timeline
event, but never wins a second claim — re-answering after the first
notification updates the stored payload without ever notifying the
agent again.

A claim a submission wins but fails to act on (the send into the
workbench throws) is released so a retried submission can still reach
the agent; `POST /workbenches/:id/messages/:id/blocks/:id/responses`
answers that case with an explicit `notify_failed` 500 telling the
caller their answer was saved and to retry, rather than leaving the row
reading "answered" with the agent silently never turned. The
`block.response` event is always posted — from the upsert's own
returned row, never the request's local payload — before this claim is
even attempted, so an agent dispatched off a won claim always finds its
own correlation event already on the timeline.
