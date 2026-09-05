# Hugging Face connect: notify-to-reconnect

The onboarding wizard's OAuth tier offers Hugging Face below OpenRouter:
"Sign in with Hugging Face — pay-as-you-go across Groq, Together,
Fireworks & more, billed to your HF account." Unlike OpenRouter's
registration-free flow, Hugging Face requires a self-serve-registered
OAuth app (see "Registering the app" below), and unlike OpenRouter's
durable minted key, HF's token **expires** — this doc also covers the
notify-to-reconnect design that fallback requires.

## Registering the app

1. Sign in to a Hugging Face account with access to the client id this
   deployment will use, then go to
   [huggingface.co/settings/applications/new](https://huggingface.co/settings/applications/new).
2. Create the app **without a client secret** ("Public OAuth apps" —
   HF's own term for this). A public app authenticates with PKCE and a
   client id alone; there is nothing else to keep secret or rotate.
3. Set the redirect URI to
   `<BASE_URL>/api/onboarding/oauth/huggingface/callback`, where
   `BASE_URL` is this hub's configured public origin (the same value
   `BASE_URL` in `.env` already names). Register one redirect URI per
   deployment (dev, staging, prod each need their own).
4. Copy the app's client id into `HUGGINGFACE_OAUTH_CLIENT_ID` in
   `.env` (see `.env.example`). Leaving it unset disables the connect
   card's routes; Hugging Face still works as a paste-a-token provider
   card either way, since `PROVIDER_TEST_CONFIG` and `CATALOG_SEEDS`
   don't depend on the OAuth app existing.

No other HF-side configuration is needed — scopes are requested at
authorize time, not configured on the app.

## The round trip

All server pieces live in `@workbench/onboarding` (mounted by the hub
at `/api/onboarding`); the wizard only navigates. The shape mirrors
OpenRouter's connect (`docs/onboarding-openrouter-connect.md`) with two
differences the provider forces: a registered client id, and an
expiring token.

1. **`GET /oauth/huggingface/start`** — requires a signed-in session
   and a configured `HUGGINGFACE_OAUTH_CLIENT_ID`; without one, it
   redirects with `outcome=error&code=not_configured` rather than
   crash. Generates a fresh PKCE verifier and its S256 challenge
   (`huggingface-connect.ts`, sharing the same PKCE primitives
   OpenRouter's flow uses — see `pkce.ts`), seals the verifier into a
   single-use state with a ten-minute TTL — encrypted through the same
   `CredentialCipher` seam `CREDENTIAL_ENCRYPTION_KEY` backs everywhere
   else a secret is encrypted at rest, so the verifier never leaves the
   server in the clear — sets that state in an HttpOnly `SameSite=Lax`
   cookie, and 302s the
   browser to
   `https://huggingface.co/oauth/authorize?client_id=...&redirect_uri=...&scope=openid+inference-api&state=...&code_challenge=...&code_challenge_method=S256`.
   The `redirect_uri`'s origin comes from the hub's configured
   `BASE_URL` (never the request's host header) and its path from the
   request, exactly as OpenRouter's callback URL is built.
2. **User approves on Hugging Face.** HF's consent screen names the
   registered app and the requested scopes.
3. **`GET /oauth/huggingface/callback?code=...&state=...`** — Hugging
   Face, unlike OpenRouter, echoes `state` on the callback; this route
   checks the query `state` against the cookie's before even touching
   the state store, on top of the store's own single-use/cross-user
   checks. It then POSTs a standard `authorization_code` + PKCE form
   (`grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`)
   to `https://huggingface.co/oauth/token`. The response is parsed with
   arktype at the trust boundary; a 200 without an `access_token` is a
   failure, never a crash or a fabricated success. When the response
   carries `expires_in`, it is converted to an ISO `expiresAt` instant.
4. **Only the fast half runs inline, plus expiry metadata.** The minted
   token goes through `testAndPersistCredential` with provider
   `huggingface`: the free `testProviderCredential` probe
   (`GET https://huggingface.co/api/whoami-v2`, HF's own documented
   account endpoint — the router's model list is a public catalog and
   proves nothing) is the only proof the token gets — a rejected probe
   is the sole way this ends in `key_rejected`. Once it passes, the
   curated Hugging Face seed from `CATALOG_SEEDS` (three router models
   on one provider row, plugin `openai-compatible`, base URL
   `https://router.huggingface.co/v1`) is planted and the token is
   stored, typed `oauth_token` rather than `api_key`, with the reported
   expiry (when present) on the credential's `metadata.expiresAt` field
   — a plain HTTP field on the credential row, never baked into a URL or
   a log line, alongside the token itself. **Deploying the default
   routines against that token never happens here** — see
   `docs/onboarding-openrouter-connect.md`'s step 4 for why (the same
   duplicate-callback defect and fast/slow split apply here unchanged).
5. **The plaintext token rides forward server-side**, the same
   `@workbench/onboarding` pending-seed store OpenRouter's flow uses
   (step 5 in `docs/onboarding-openrouter-connect.md`) — a row keyed by
   `(userId, tenantId)` carrying `provider: "huggingface"` and the
   minted access token, never the expiry metadata (that's already
   stored on the credential row by this point) and never anything the
   browser sees.
6. **Back to the wizard.** Every ending 302s to
   `/onboarding?connect=huggingface&...`, parsed by
   `readHuggingFaceConnectReturn` exactly as `readOpenRouterConnectReturn`
   parses OpenRouter's: `outcome=connected` with the bench slug, or
   `outcome=error` with a short machine code (`state_expired`,
   `exchange_failed`, `key_rejected`, `no_bench`, `setup_failed`,
   `signed_out`, `rate_limited`, plus HF's own `not_configured`). The
   same duplicate-callback recovery OpenRouter's flow runs (step 6
   there) applies here too, keyed on an active `huggingface` credential
   instead.
7. **The wizard finishes the job** exactly as it does for OpenRouter —
   see step 7 in `docs/onboarding-openrouter-connect.md`.

## Why the token expires, and why that's fine (notify-to-reconnect)

Hugging Face's consumer PKCE flow documents no silent-renewal
(`prompt=none`) path and no usable `refresh_token` grant — the only
place those terms appear in HF's docs is an Enterprise-only,
org-bound Token Exchange feature, architecturally unrelated to this
flow. Building a keep-alive loop on either would be building on
documentation that doesn't exist for this shape. So this connect ships
**notify-to-reconnect** instead of silent renewal:

- **The router fails deterministically.** An expired or invalid token
  against `https://router.huggingface.co/v1` (or HF's own
  `whoami-v2`) returns a clean `401` — confirmed live, not
  documentation-only. That is a reliable trigger.
- **Interchange already degrades gracefully.** `@intx/inference`'s
  reactor classifies a `401` as a credential-category error, which is
  source-specific and already fails over to the next configured
  inference source with **no changes needed here** — this is existing,
  tested behavior. The one caveat: failover is per-cycle, not sticky,
  so a permanently-expired Hugging Face credential is retried (and
  fails over again) every cycle until it's fixed or removed — a
  standing one-cycle tax, not a one-time skip. A bench that wants this
  safety net needs at least one other configured source for the
  reactor to land on.
- **A human is told.** `@corbits/notify`'s `credential-expired`
  `NotificationEvent` kind (`packages/notify/src/events.ts`) carries
  `tenantId`, `credentialId`, `providerId`, `providerLabel`, and
  recipients; `deliverCredentialMail` (`deliver.ts`) sends it through
  the same mailbox/inbox/bell pipeline the other three notification
  kinds use. The rendered copy: _"Reconnect Hugging Face — your token
  expired"_, explaining that reconnecting is the same connect card in
  Settings/onboarding, and naming the fine-grained personal access
  token (permission: "Make calls to Inference Providers") as the
  durable alternative for anyone who'd rather not re-click periodically.
  Dedupe is keyed on the credential id alone, not the sweep tick, so a
  still-unfixed credential is mailed once, not every poll.
- **A light periodic sweep finds the expiry.** `apps/hub`'s
  `credential-expiry-sweep.ts` mirrors `routine-scheduler.ts`'s own
  shape: every five minutes it loads every `active` credential on a
  swept provider (today: `huggingface`), asks
  `@corbits/notify`'s pure `findDueCredentialExpiries` which of them
  just crossed their stored `expiresAt`, conditionally claims each due
  expiry (`active` → `expired`, guarded so a racing hub replica never
  double-mails), and mails the winners. The claim/decision split keeps
  the "which credentials are due" logic pure and unit-tested in
  `@corbits/notify`, and the store-behind-an-interface seam
  (`CredentialExpirySweepStore`) makes the loop itself testable against
  an in-memory store, the same store-behind-an-interface seam the hub's
  native schedule poller uses.

This sweep's live delivery — writing an actual mailbox row — depends on
`@corbits/mailbox`'s and `@corbits/notify`'s own migrations being
applied against `DATABASE_URL`; this is the first live caller of the
mailbox delivery adapter the hub's composition root already
constructed, but approval/run-failure/mention notifications still have
no writer wired to it. That gap predates this connect and is unrelated
to it.

## Dev notes

- In `vite dev`, the start navigation goes through the `/api` proxy to
  the hub; Hugging Face then calls back on the hub origin (`BASE_URL`),
  so the wizard resumes there rather than on the vite origin — the same
  behavior OpenRouter's flow has.
- The pending-connect state is a signed/encrypted token, not a
  server-side lookup, so it survives a hub restart between `/start` and
  `/callback` (a dev watch reload, a deploy) as long as
  `CREDENTIAL_ENCRYPTION_KEY` is stable — the callback no longer has to
  land on the exact process that issued it. See `pkce.ts`'s
  `createConnectStateStore`.
- A second OAuth-connected provider whose tokens expire should extend
  `SWEPT_PROVIDER_LABELS` in `credential-expiry-sweep.ts`, not add a
  second sweep loop.
