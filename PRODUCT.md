# Product

Corbits Workbench is the multiplayer workspace for humans and agents — a
team and its AI agents working side by side, with the same conversations
and routines. It is the default implementation of the Corbits
Platform, built on [Interchange](https://github.com/faremeter/interchange).

## The one concept

Everything in Workbench collapses to a single idea: **a workbench is a
conversation tenant.** People and agents are both principals
(Interchange). Opening an agent opens the one 1:1 DM with that agent
(`kind: chat`) — two clicks never clone a second DM. Opening a channel
opens a multi-principal room (`kind: workbench`). There is no separate
"project" or "space" object sitting above the conversation; the
conversation is the unit of work.

This is why the sidebar is one recency list of conversations (pins
first) — agent DMs mixed with channels — not two labeled sections, and
not a list titled Workbenches. That noun is the product name and the
mint verb. The same Interchange agent can sit in its DM and in
many channels; product reopens or invites, and does not clone the
definition or mint a sibling instance per room. See
[docs/GLOSSARY.md](docs/GLOSSARY.md) for the full term mapping and
[docs/CHAT.md](docs/CHAT.md) for how a conversation is built underneath.

## Who it's for

Teams adopting agentic workflows who want their agents working in the same
place their people already talk — not a separate agent console bolted onto
a chat tool. A signed-in user belongs to one or more **benches** (shared
team spaces); within a bench, they open, create, and work in workbenches.

## The guided, single-column experience

Workbench is intentionally not a multi-pane IDE. The product surface is one
column at a time:

- **A sidebar of conversations** lists agent DMs and channels together
  by recency, pins first, in the selected bench. Agent rows are DMs
  (`kind: chat`); channel rows are shared rooms (`kind: workbench`).
  There are not two labeled empty sections, and the list is not titled
  Workbenches.
- **"New workbench" always creates.** It opens `/new` — the shipped
  prompt-primary picker — never home, and never a picker of existing
  things to join. Plus mints an empty channel. Nobody is auto-hosted.
- **Agents are principals, not templates.** Opening Sales opens Sales —
  the one 1:1 tenant with that agent. The same agent can sit in its DM
  and in many channels. Product reopens or invites; it does not clone
  the definition or mint a sibling instance per room. Myra is the
  first-run guide in her DM, not a special home slot and not a
  parallel home route. When she creates a specialist (`create_agent`),
  the default is to mint or reopen that specialist's own DM
  (`kind: chat`) — never to invite them into Myra's conversation. A
  DM stays 1:1; another agent belongs in a channel.
- The active workbench occupies the main column; a contextual panel beside
  it carries account-wide surfaces (approvals, recent activity) that stay
  visible regardless of which workbench is open.

## First run

A brand-new account is walked through login and a credential connect, then
lands in Myra's one DM rather than `/new` or an empty shell:

1. **Login.**
2. **Credential** — connect a model provider (one-click OAuth for
   supported providers, or a pasted API key); see `packages/onboarding`.
3. **Myra's DM** — `/` hops an empty bench to that agent's one DM
   (`openAgentDm` / find-or-reopen). There is no parallel Myra home
   route. `/new` stays the create door (sidebar `+`), not this hop.

Connecting a local Ollama uses a completion model that instance has
actually pulled, so Myra's first DM message is a real agent turn — even
on a machine that only has models like llama3.2 or qwen3. An inherited
catalog seed the instance never pulled is not the default when the
tenant already owns a pulled completion model. Embedding models never
become that default. A local model that writes a tool it meant to
invoke as JSON in the reply still becomes a human turn: the person
sees Myra's words (and ordinary tool activity), not that JSON as the
message.

Create stays on `/new` (`apps/web/src/pages/new-workbench-picker.tsx`):
a prompt box is the primary act: typing a goal and submitting mints an
empty channel and sends that text as the first message; blank plus
invites nobody. Named-template rows underneath mint that same empty
channel with no host and no mint `definitionId`, then instantiate the
picked Workbench Definition's own agents (Myra joins only when the
definition names her) — one-click shortcuts, not a kind-then-Create
second step. There is no Describe door and no
`describe-first-workbench.tsx`.

A bench that already has one or more workbenches skips first-run and
lands on `workbenches[0]` (see `apps/web/src/pages/home-page.tsx`). Myra
is the first-run guide in her DM, not a home slot.

The shell's first-run destinations stay small on purpose:
Mission Control is pinned above the footer rail; the rail itself is
Routines, Files, Skills, Agents, and Plugins. Insights and Evals appear
on that rail only after honest usage exists. New benches should not
meet an empty Insights / Evals gallery before they have anything to
put there.

### Code review's first minute

Code review is the product scene for the definition-driven path:
minting the Code review workbench opens an empty room with no host —
its Workbench Definition names three reviewers and no Myra. The room
itself posts the onboarding card as a scene, not a member's message:
no author row, the job as its title, the promise beneath, and the
walkthrough's steps listed with the current one marked in words. A
walkthrough with no steps hides the step list rather than drawing an
empty one. Connect GitHub with a personal access token (the shipped
path today). The same in-room card reads live connection state and
flips in place to pick repositories — already connected GitHub is
that card, not a `/new` dialog — then Start reviewing. Once repos are
recorded the same card shows what it is reviewing, with a change-repos
link back to the picker — a reviewing card never still says Connect.
Once reviewing starts, each reviewer posts its own canned introduction
under its own address, in roster order — the first thing a person
reads is who is reviewing and what for, never a join dump. Consecutive
agent-joined rows collapse into one line naming everyone. A GitHub App
/ hosted OAuth welcome mat is future work (CL-6343), not current
product. Inviting teammates into the room is a later slice, not part
of this first minute.

Settle for a template-key-only wait posts from a system sender and
does not wake an agent. Generic `connections/pending` still wakes the
asking agent. Neither path posts the connected notice as the connecting
person.

## Reusing an own prompt

A person can **Edit** their own previous prompt. Edit copies that text
into the composer, replacing any leftover draft — slash command, mention,
invite, and attachments. Sending posts a new message on the same
timeline: it does not rewrite the original, and it does not fork a
thread. Other people's prompts have no Edit.

## Plugins and Skills

A **Skill** is a named, reusable capability — instructions an agent can
pin and a workbench can install, backed by the platform's native
`kind:"skill"` asset (see `packages/skills`). Skills are visible only to
the principal or tenant that owns them; nothing crosses tenant boundaries
implicitly. Plugins extend what a workbench can do the same way Skills
extend what an agent knows — both are installable, both are scoped to the
bench or workbench that installs them, and neither requires touching
platform internals.

The Plugins rail is how a person connects remote MCP servers: curated
preset cards plus an add-by-URL path. Canva is an OAuth preset — Connect
sends them through that app's sign-in, then back to Plugins. After a
successful OAuth return, the row can show how many tools the connect
probe found; a missing or non-integer count stays a bare "Connected". If
sign-in cannot start, Plugins distinguishes an unreachable authorization
server from the app rejecting Workbench as a client (redirect URL or
registration). Agent MCP tool calls are allowed two minutes so a slow
design tool can finish inside a chat turn.

Live Canva OAuth against Canva's own servers is **not** verified as of
CL-7083. This documents the shipped connect path, not a proven live
handshake.

## Workbench settings

Each workbench has its own full-stage settings surface, not a dialog —
reached from the workbench itself, never a separate console. It covers
what is specific to that one conversation: name, purpose, and pinned
state; its agent and human participants; per-agent name, instructions,
and capabilities; dedicated vs. shared inference capacity (CL-6117);
per-workbench connector and plugin overrides against the account default
(CL-6099); inference model/provider fallback order; applying a saved
config profile; per-person notification preferences for that workbench;
and archiving. See ARCHITECTURE.md's "Conversation as workbench data"
for how a workbench's settings relate to its tenant, and
`packages/chat-ui`'s `workbench-settings` for the implementation.

## Routines, through conversation

A **Routine** is a scheduled workflow — an authored definition whose
frozen projection carries a native `ScheduleTrigger`. Cadence is set
from inside conversation, not from a separate scheduling console: a
person names what should happen again, on what schedule, and where the
result should land. See `@corbits/workflows` for the schedule/cron
helpers and the hub's `workflow-scheduler.ts` for the poller. The
Routines page also offers an Available section (CL-7073): every
catalog workflow this workbench hasn't added yet, with an Add action
that deploys it in place — no separate create flow.

## Inbox and approvals

Approvals sit outside any single workbench. Inbox does not:

- **Inbox is not a product page.** The groups UI (action / mention /
  delivery) is gone. `/inbox` stays routable only as a redirect home
  (CL-6151) so old links and bookmarks land somewhere real. The hub
  inbox API (`packages/inbox`, `/api/tenants/:tenantId/inbox`) may still
  exist as a backend; it is not a live groups page.
- **Approvals ("needs you")** surface a paused agent run waiting on a
  human decision. There is no dedicated Approvals page — pending approvals
  show up in the Activity band, a permanent section of the contextual
  panel visible from every page, resolved by name ("`<agent name>` in
  `<bench name>`") rather than a raw id. See
  [docs/needs-you.md](docs/needs-you.md).

## Insights

Workbench exposes tenant-level usage and activity data — cost, token
consumption, and run activity — surfaced as read-only queries over data a
usage sink persists from the live inference stream. Missing data is shown
as an explicit absence, never a fabricated zero. See `packages/insights`.

## Vocabulary

User-facing surfaces (UI, docs, support) use exactly these nouns:

- **Workbench** — the product name, and the mint verb ("New workbench").
  A workbench is a conversation tenant: a DM or a channel. Do not title
  the sidebar list Workbenches.
- **Agent** — a coworker principal. Opening the row reopens that agent's
  one DM. Never "template." Myra is the first-run guide in her DM.
  Creating a specialist opens (or reopens) that specialist's own DM,
  not a seat in Myra's.
- **DM** — the one 1:1 conversation with an agent. Never cloned by a
  second open, and never a room for a second agent.
- **Channel** — a shared room between people and agents. Plus mints an
  empty one; nobody is auto-hosted. Named templates instantiate their
  Workbench Definition's own agents into that room (Myra joins only
  when the definition names her).
- **Bench** — the shared team scope a person signs into and switches
  between; shown in the bench switcher, never called a "workspace" or
  "org" in copy.

Internally these map onto platform primitives (principal, tenant, kind:
chat vs kind: workbench) — see [docs/GLOSSARY.md](docs/GLOSSARY.md) for
the authoritative table. Code and API paths generally keep the
platform's own names; "workbench" is the one exception (CL-6260), since
its package (`@corbits/chat`) is ours, not the platform's — only
user-facing surfaces use the rest of the product vocabulary above.

## Open questions

- Template-key-only settle (system sender, no agent wake) is shipped;
  generic `connections/pending` still wakes the asking agent.
- Settle attribution via a synthetic system sender is shipped (CL-6741);
  `connection.connected` is never posted as the signed-in user. See
  [docs/connect-cards.md](docs/connect-cards.md).
- A leftover agent 401 after GitHub already succeeded, and a stale
  Connect after success, remain first-minute bugs — see
  [docs/connect-cards.md](docs/connect-cards.md); do not document those
  as shipped.
- Live Canva MCP OAuth (sign-in, DCR, and post-OAuth probe against
  Canva's own servers) is not verified; do not document a proven live
  Canva handshake.
- The precise boundary of what Insights surfaces to a non-admin bench
  member (all tenant activity vs. only their own) is not spelled out in
  `packages/insights`'s own docs as of this writing.
