# The local rip

A "local rip" is the whole platform proof, run by hand on your own
machine, with your own real key: sign up, get a personal bench, connect a
real inference provider, and watch a working workbench come up in front of
you — nothing mocked, nothing skipped. `scripts/e2e/local-rip.test.ts`
proves the same path with a stubbed provider probe and a scratch database
(see its own header comment); this doc is the honest, no-shortcuts version
for a person, not CI.

This covers the whole path: sign-up through a fully connected bench, with
a real inference provider wired up end to end.

## Prerequisites

- [Bun](https://bun.sh) >= 1.2
- A local [Postgres](https://www.postgresql.org) 17 with pgvector — see
  [README.md](../README.md#running-locally) for the `brew install` line
- `git` on your `PATH` — the onboarding connect flow pushes the default
  workflow definitions into the hub over git smart-HTTP
  (`packages/seeding/src/workflow-push.ts`'s `createGitWorkflowPusher`
  shells out to the system `git` binary; it fails loud with an install
  hint if `git` isn't found)
- A real API key for the provider you want to connect (this walkthrough
  uses OpenRouter's OAuth connect, which needs no key of your own to
  paste — see below — but any of the providers in
  [`packages/seeding/src/catalog-seed-data.ts`](../packages/seeding/src/catalog-seed-data.ts)
  works the same way with a pasted key)

## 1. Bring up a clean stack

```sh
cp .env.example .env
bun run reset   # only if you have a previous local-rip's state lying around
bun run dev
```

`bun run reset` drops the schema and every on-disk asset directory
`bun run dev` and its boot-time seeding created — skip it on a
genuinely fresh checkout. `bun run dev` validates `.env`, confirms
`DATABASE_URL` is reachable, applies pending migrations, builds the web
UI, seeds the administrator account, and starts the hub, one sidecar, and
the web dev server together — the hub then provisions and seeds the root
tenant itself once it is serving (see
[README.md](../README.md#running-locally) for exactly what it checks).
Leave `ANTHROPIC_API_KEY` unset in `.env` for
this walkthrough — the point is proving a bench with no hub-owned seed
model gets fully seeded through a person's own connected credential, not
through the operator's key.

Once `bun run dev` reports the hub and web server up, open
`http://localhost:3000` (or whatever `BASE_URL`/`PORT` you set in `.env`).

## 2. Sign up

The app root renders the sign-in screen when you're not authenticated
(`apps/web/src/app.tsx`'s `<AuthScreen>`); toggle it to sign-up and create
an account with any email/password. `WORKBENCH_SIGNUP` defaults to
`closed` — `bun run dev` forces it `open` for the duration of the dev
process regardless of what `.env` says (unless `.env` sets it explicitly),
so self-serve sign-up works out of the box here. On a deployed hub with no
override, the same sign-up attempt is refused at `POST /api/auth/sign-up/email`
with `signup_closed` — `scripts/e2e/local-rip.test.ts`'s first hop proves
exactly that response.

## 3. Name your bench

Signing up lands you on `/onboarding`. Submitting the "Create your
workbench" name form calls `POST /api/onboarding/provision` with that name,
which mints your personal bench through the platform's native
tenant-creation route. With no `ANTHROPIC_API_KEY` configured, the response
reports the bench as provisioned but unseeded (`seeded: false`, with a
`seedSkipReason` naming why) — the UI keeps you on the credential step
rather than pretending you're done.

## 4. Connect a provider

The credential step offers a "Connect with OpenRouter" button (PKCE OAuth,
no client id or secret needed — OpenRouter's connect works with zero extra
config) alongside a paste-a-key form for any provider in
`CREDENTIAL_PROVIDERS` (`apps/web/src/onboarding.ts`), Anthropic included.
Either path:

1. proves your key or exchanged token with a real, free call against the
   provider's own auth-gated endpoint (`testProviderCredential` —
   `packages/connections/src/credential-test.ts`) before storing anything;
2. plants it as a credential on your bench alongside that provider's
   curated model catalog;
3. deploys and (unlike the OAuth callback's own fast half) confirms the
   one default workflow every real signup gets: **assistant**
   (`packages/seeding/src/seed.ts`'s `DEFAULT_WORKFLOWS`, CL-7074).
   **echo** and **workbench-digest** are on-demand `CATALOG_WORKFLOWS`
   entries now — deployed only when something asks for them by name,
   never automatically at signup.

Expect the page to show a short "setting up your workbench" wait while
`/complete-setup` polls, then land on a "Your first routines are running"
screen listing each routine as confirmed running with your credential, and
a "Meet Myra" button into the bench itself.

### Publishing the corbits-tools registry

The **assistant** default workflow pins the `@corbits/memory-tools` tool
package (`workflows/assistant/src/index.ts`), and that pin only resolves
once a `package-registry`-kind asset named `corbits-tools` carries its
tarball (see `apps/hub/src/index.ts`'s `CORBITS_TOOLS_REGISTRY` comment).
Boot-time seeding (`apps/hub/src/system-seed.ts`) publishes that asset onto
the root tenant via `@corbits/tool-registry-publish` (bundles
`@corbits/memory-tools` into a self-contained tarball and pushes it
through the hub's native asset REST routes). Descendants inherit it;
`seedTenant` does not pack. Isolated
tests run with no explicit tenant config so the walkthrough's personal
bench is itself the root — then the same publish happens once onto that
bench, and **assistant** comes up live by default; `scripts/e2e/local-rip.test.ts`
also deploys **echo** and **workbench-digest** from `CATALOG_WORKFLOWS`
onto that same bench (the on-demand path, exercised directly rather
than assumed) to prove they still come up live too. The default
self-serve story is the other way: the hub ensures a root tenant at boot
(`WORKBENCH_DEFAULT_TENANT`, default `workbench`), and first-login
personal benches parent under it.

## 5. Check the Connections surface

Back in Settings → Connections, the provider you connected shows as
`connected`, cross-referenced from your tenant's own credentials list
(`GET /api/tenants/:id/credentials`) the same way
`packages/settings-ui/src/connections-status.ts`'s `connectorStatus`
does — the credential named `<provider>-default`
(`inferenceCredentialName`, `packages/seeding/src/seed.ts`), `status:
"active"`.

That's the onboard → connect leg, proven with your own real key end to
end.
