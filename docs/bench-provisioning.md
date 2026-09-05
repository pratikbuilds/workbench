# Bench provisioning

Connecting a provider deploys nothing.

That is the whole rule, and it exists because the alternative was
measured: pasting an Anthropic key on onboarding sat on a static
"Connecting…" for over two minutes, because the connect request
deployed five default workflows — around twenty seconds each — before it
answered. Long enough that the owner concluded the app had frozen.

## The split

Connecting a credential has a fast half and a slow half, and only the
fast half is allowed on a request.

- **Fast half** (`testAndPersistCredential`) — persist the credential,
  seed its model catalog. Durable, and measured in seconds. This is all
  `POST /api/onboarding/complete` does before it answers.
- **Slow half** (`ensureSeeded` → `seedTenant`) — deploy the bench's
  default workflows. This runs in the background, in
  `createBenchProvisioner` (`packages/onboarding/src/bench-provisioning.ts`).

No HTTP route runs the slow half. `POST /complete` and `POST
/complete-setup` both answer with where the bench's agents stand and
hand the deploying to the drain; `GET /api/onboarding/provisioning-status`
reports the same thing for anything that needs to poll.

`completeCredentialSetup` still composes both halves back to back, but
only for harnesses that need a fully deployed bench before a scenario
can begin (`@workbench/evals`' real target). A route that calls it
re-creates the freeze.

## Why the drain converges

The drain is not a job queue. It is a pass over
`onboarding.pending_seed`, where the row _is_ the work item and means
"this bench has a credential and does not yet have its agents". Three
properties follow from that framing rather than having to be built:

- **Idempotent** — every pass re-reads the bench's real asset and
  deployment state before acting, and `seedTenant` underneath is
  ensure-then-create at every step. A pass over a finished bench deploys
  nothing and clears the row.
- **Convergent** — a pass that gets partway leaves the row in place, so
  the next pass picks up exactly the workflows still missing.
- **Restart-safe** — nothing about outstanding work lives in the
  process. A hub that dies mid-deploy leaves the row; the next boot's
  first tick finishes it. In-memory state is only ever a dedupe guard or
  a retry backoff, never a fact the system needs to be correct.

A failing bench is held off with exponential backoff (15s, doubling to a
10-minute ceiling) so a sidecar outage is not hammered, and a bench is
never dropped for failing — the row stays until it converges or its TTL
(24 hours) expires. That backoff bookkeeping is reclaimed once the row
itself is gone — TTL-expiry or otherwise — not only when the bench
converges, so a permanently-failing bench never leaves a stale backoff
behind for a later, unrelated connect to the same user/tenant to
inherit (CL-7233).

## Sessions

A background loop has no request to borrow cookies from, and everything
`seedTenant` drives speaks the hub's own HTTP API. The provisioner takes
`sessionFor` as a seam; the hub fills it (`apps/hub/src/bench-session.ts`)
by minting the bench owner's own session in process.

It has to be the owner's session. The hub resolves a tenant by looking
up a principal for that user, and rights do not flow from a parent org
down to a child bench — an administrator acting on someone else's
personal bench is refused outright. These sessions are tagged with a
`workbench-bench-provisioner` user agent so they are never mistaken for
a human sign-in, and are cached per user rather than minted per tick.

## What someone sees

Connecting hands the person forward immediately, and the wait on the
other side is as short as it can honestly be: the setup agent (Myra)
leads `DEFAULT_WORKFLOWS`, so she is deployed before anything else, and
the land hop drops the person into her room the moment she can answer.
The other catalog workflows (digest, recurring-task, research) are not
seeded at all — they are deployable through the catalog instantiate route
(CL-7073) once someone picks one, not on a critical path nobody is waiting
on.

While she is still coming up, the shared warm loader is the whole
screen: one honest headline and a rotating tip, never an internal count.
How many workflows a bench seeds is an implementation detail, and "0 of
5 ready" told a waiting person nothing they could act on. A wait that
runs past a sensible interval says so plainly and offers another go,
rather than showing an unchanging number.

Once the person has landed, anything still deploying is at most a single
dismissible line — never a screen that blocks them.

Whether a bench can be started is asked of the bench, never read off an
error message: `GET /api/onboarding/provisioning-status` answers with
`setupAgentReady`, which is the only field a waiting surface should
branch on. `deployed`/`pending` stay in the response for operators and
logs.
