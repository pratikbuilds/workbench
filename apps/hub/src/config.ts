// The one boundary that reads the process environment. Everything the
// hub needs from the outside world is an irreducible deployment fact:
// where the database is, what origin the hub serves, how sessions are
// signed, and where durable state and the built interface live on disk.
// Anything else the hub learns is data in the database, never
// configuration.
//
// ANTHROPIC_API_KEY is the one model-related variable a freshly
// self-served personal bench needs: when set, the hub carries a seed
// model credential (anthropic/claude-sonnet-5) it hands to
// `@workbench/onboarding` so that bench gets the default workflow set
// deployed at first login. Left unset, that deployment step is skipped
// — the bench is still provisioned, only the default workflow
// deployment is skipped, and the skip is logged.
//
// ANTHROPIC_API_KEY and every other curated provider's conventional key
// (`@workbench/onboarding`'s `PROVIDER_ENV_VARS` — OPENAI_API_KEY,
// GEMINI_API_KEY/GOOGLE_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY,
// OPENCODE_ZEN_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY,
// HUGGINGFACE_API_KEY) are also read as an env-key auto-plant (CL-6101):
// once the hub finds its own operator bench (HUB_ADMIN_EMAIL/PASSWORD
// signed in, ORG_SLUG resolved — the same identity `workbench setup` /
// `workbench seed` use), it plants a real, probed credential for every
// key it finds there, making that bench's catalog launchable with no
// `workbench seed` re-run. See `../env-credential-plant.ts`. All of
// these — including HUB_ADMIN_EMAIL/PASSWORD/ORG_SLUG — are optional:
// the plant is skipped, quietly and non-fatally, whenever the admin
// identity cannot be resolved or no provider key is set.
//
// GOOGLE_CLIENT_ID/SECRET and GITHUB_CLIENT_ID/SECRET are each an
// optional pair: set both to enable that OAuth provider on the sign-in
// screen, leave both unset to leave it off — email/password remains
// available either way. Setting only one half of a pair is a boot-time
// error, never a silently-disabled provider.
//
// HUGGINGFACE_OAUTH_CLIENT_ID is a single optional value, not a pair —
// Hugging Face's connect flow uses a public OAuth app with no client
// secret. Set it to enable the onboarding wizard's Hugging Face connect
// card; leave it unset and Hugging Face stays available only as a
// paste-a-token provider card.

import { type } from "arktype";
import {
  envProviderBaseUrlsFrom,
  envProviderKeysFrom,
} from "@workbench/onboarding";
import type { SupportedCredentialProvider } from "@corbits/connections/credential-test";

const HTTP_URL = /^https?:\/\/.+$/;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Whether `baseUrl` names a loopback address — the one fact that
 * distinguishes a developer's own machine from a real deployment
 * without trusting an operator to have overridden anything. Used to
 * refuse `ALLOW_PLAINTEXT_SECRETS` (see `readHubConfig`) rather than
 * relying on an operator to have removed it from an inherited `.env`.
 */
function isLoopbackBaseUrl(baseUrl: string): boolean {
  return LOOPBACK_HOSTNAMES.has(new URL(baseUrl).hostname);
}

const HubEnv = type({
  DATABASE_URL: type(/^postgres(ql)?:\/\/.+$/).describe(
    "a Postgres connection URL, e.g. postgres://workbench:workbench@localhost:5432/workbench",
  ),
  BASE_URL: type(HTTP_URL).describe(
    "an http(s) origin, e.g. http://localhost:3000",
  ),
  "PORT?": type(/^\d{1,5}$/).describe(
    "the local port to listen on when it differs from BASE_URL's — set this when a reverse proxy (Tailscale serve, nginx) fronts the hub and BASE_URL is the public https origin",
  ),
  SESSION_SECRET: type("string >= 32").describe(
    "a session-signing secret of at least 32 characters",
  ),
  HUB_DATA_DIR: type("string > 0").describe(
    "a filesystem directory for the hub's durable repo and asset state, e.g. .data/hub",
  ),
  HUB_STATIC_DIR: type("string > 0").describe(
    "a directory of built user-interface files the hub serves, e.g. apps/hub/public",
  ),
  "WORKBENCH_DEFAULT_TENANT?": type(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  ).describe(
    'slug of the root tenant the hub ensures at boot; every self-served personal bench parents under it, and setup/seed/plant resolve the same slug — ORG_SLUG is an alias when this is unset; default "workbench"',
  ),
  "SIGNUP_RATE_LIMIT_WINDOW_SECONDS?": type(/^[1-9]\d*$/).describe(
    "the per-IP sign-up rate-limit window, in seconds, e.g. 60",
  ),
  "SIGNUP_RATE_LIMIT_MAX?": type(/^[1-9]\d*$/).describe(
    "the maximum sign-ups a single IP may make per window, e.g. 5",
  ),
  "SIGNIN_RATE_LIMIT_WINDOW_SECONDS?": type(/^[1-9]\d*$/).describe(
    "the per-account sign-in rate-limit window, in seconds, e.g. 60; overrides better-auth's built-in 10-second/3-attempt default, which is too tight for a person retyping a password",
  ),
  "SIGNIN_RATE_LIMIT_MAX?": type(/^[1-9]\d*$/).describe(
    "the maximum failed sign-in attempts a single account may accrue per window before further failures are rejected, e.g. 10 — keyed on the target email, not client IP (see sign-in-rate-limit.ts); a correct password always succeeds regardless of this budget",
  ),
  "WORKBENCH_SIGNUP?": type("'open' | 'closed'").describe(
    "open = self-serve email signup allowed; closed (default) = owner adds users or copy-link invite only",
  ),
  "WORKBENCH_ALLOWED_EMAIL_DOMAINS?": type("string").describe(
    "comma-separated email domains allowed when WORKBENCH_SIGNUP=open, e.g. acme.example",
  ),
  "ROUTINE_SCHEDULER_POLL_INTERVAL_MS?": type(/^[1-9]\d*$/).describe(
    "dev/test-only override for the routine scheduler's poll interval, in milliseconds — unset (default) runs the real 30s production cadence; the e2e harness sets this to a fast interval so a scheduled-routine test doesn't wait out the real cadence",
  ),
  "ANTHROPIC_API_KEY?": type("string > 0").describe(
    "your Anthropic API key; optional, enables the default workflow set for freshly self-served benches, and auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "OPENAI_API_KEY?": type("string > 0").describe(
    "your OpenAI API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "GEMINI_API_KEY?": type("string > 0").describe(
    "your Google Gemini API key; optional, auto-plants a probed catalog credential on the operator bench at hub start — GOOGLE_API_KEY is used when this is unset",
  ),
  "GOOGLE_API_KEY?": type("string > 0").describe(
    "your Google Gemini API key, under its other common name; only read when GEMINI_API_KEY is unset",
  ),
  "XAI_API_KEY?": type("string > 0").describe(
    "your xAI API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "OPENROUTER_API_KEY?": type("string > 0").describe(
    "your OpenRouter API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "OPENCODE_ZEN_API_KEY?": type("string > 0").describe(
    "your Opencode Zen API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "GROQ_API_KEY?": type("string > 0").describe(
    "your Groq API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "DEEPSEEK_API_KEY?": type("string > 0").describe(
    "your DeepSeek API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "MISTRAL_API_KEY?": type("string > 0").describe(
    "your Mistral API key; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "HUGGINGFACE_API_KEY?": type("string > 0").describe(
    "your Hugging Face router API token; optional, auto-plants a probed catalog credential on the operator bench at hub start",
  ),
  "OLLAMA_BASE_URL?": type("string > 0").describe(
    "the origin your local (or tailscale-tunneled) Ollama instance listens on, e.g. http://localhost:11434; optional, auto-plants a probed catalog credential (no key required) on the operator bench at hub start",
  ),
  "HUB_ADMIN_EMAIL?": type(/^[^@\s]+@[^@\s]+$/).describe(
    "the administrator account the env-key auto-plant signs in as to find the operator bench; same identity `workbench setup`/`workbench seed` use — unset falls back to alice@example.com, the same default those commands use",
  ),
  "HUB_ADMIN_PASSWORD?": type("string >= 8").describe(
    "the administrator password the env-key auto-plant signs in with; unset falls back to password123, the same default `workbench setup`/`workbench seed` use",
  ),
  "ORG_SLUG?": type(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).describe(
    'alias for WORKBENCH_DEFAULT_TENANT when that is unset — same root/operator slug the hub, setup, seed, and the env-key auto-plant resolve; default "workbench"',
  ),
  "GOOGLE_CLIENT_ID?": type("string > 0").describe(
    "Google OAuth client id; set together with GOOGLE_CLIENT_SECRET to enable Google sign-in",
  ),
  "GOOGLE_CLIENT_SECRET?": type("string > 0").describe(
    "Google OAuth client secret; set together with GOOGLE_CLIENT_ID to enable Google sign-in",
  ),
  "GITHUB_CLIENT_ID?": type("string > 0").describe(
    "GitHub OAuth client id; set together with GITHUB_CLIENT_SECRET to enable GitHub sign-in",
  ),
  "GITHUB_CLIENT_SECRET?": type("string > 0").describe(
    "GitHub OAuth client secret; set together with GITHUB_CLIENT_ID to enable GitHub sign-in",
  ),
  "HUGGINGFACE_OAUTH_CLIENT_ID?": type("string > 0").describe(
    "Hugging Face public OAuth app client id (huggingface.co/settings/applications, no secret — see docs/onboarding-huggingface-connect.md); optional, enables the onboarding wizard's Hugging Face connect card",
  ),
  "GITHUB_APP_CLIENT_ID?": type("string > 0").describe(
    "GitHub OAuth App client id for the `github` connector's hosted one-click connect (github.com/settings/developers — a separate app from GITHUB_CLIENT_ID's sign-in app); set together with GITHUB_APP_CLIENT_SECRET, or the Plugins/connect-github card falls back to a pasted personal access token",
  ),
  "GITHUB_APP_CLIENT_SECRET?": type("string > 0").describe(
    "GitHub OAuth App client secret; set together with GITHUB_APP_CLIENT_ID to enable the hosted GitHub connect",
  ),
  "GMAIL_CLIENT_ID?": type("string > 0").describe(
    "Google OAuth client id for the `gmail` connector's hosted connect (console.cloud.google.com — a separate OAuth client from GOOGLE_CLIENT_ID's sign-in app); set together with GMAIL_CLIENT_SECRET, or the Gmail connect card renders not-configured",
  ),
  "GMAIL_CLIENT_SECRET?": type("string > 0").describe(
    "Google OAuth client secret; set together with GMAIL_CLIENT_ID to enable the hosted Gmail connect",
  ),
  "GITHUB_API_BASE_URL?": type(/^https?:\/\/.+$/).describe(
    "override for the GitHub REST API origin the `github` connector's PAT probe and credential delivery target, e.g. a fake server recorded for tests/evals; unset (default) targets https://api.github.com — never set this for a real deployment",
  ),
  "CREDENTIAL_ENCRYPTION_KEY?": type(/^[0-9a-fA-F]{64}$/).describe(
    "a 64-character hex-encoded 32-byte AES-256 key (openssl rand -hex 32) encrypting secrets at rest through Interchange's CredentialCipher seam — webhook-trigger signing secrets and onboarding's OAuth PKCE connect state; boot fails without it unless ALLOW_PLAINTEXT_SECRETS opts into dev/test's unencrypted fallback",
  ),
  "ALLOW_PLAINTEXT_SECRETS?": type("'1' | 'true'").describe(
    "dev/test-only opt-in to boot without CREDENTIAL_ENCRYPTION_KEY, storing secrets at rest unencrypted with a boot warning; refused unless BASE_URL is a loopback address, so a real deployment can never inherit it by accident",
  ),
  "ALLOW_UNVERIFIED_EMAILS?": type("'1' | 'true'").describe(
    "dev/test-only opt-in to let @workbench/access-policy trust an email that better-auth has not verified — self-signup domain checks and pending-invite redemption normally require emailVerified; never set this for a real deployment",
  ),
  "HUB_ALLOW_GIT_INSIDE_WORK_TREE?": type("'1' | 'true'").describe(
    "opt-in to initialize hub git-on-disk state inside a directory that is already a git work tree; refused by default because a nested init that misses its own .git walks up and commits onto the enclosing working branch",
  ),
  "SIDECAR_PROVISIONERS?": type("string").describe(
    "comma-separated sidecar-allocation backend ids to register for workbenches placed on their own exclusive sidecar: 'process' (a child process on this host), 'docker', or 'e2b'; unset or empty (default) registers 'process' alone, so a single-server install provisions exclusive sidecars with no operator configuration",
  ),
  "SIDECAR_DEFAULT_PROVISIONER?": type("string > 0").describe(
    "which id listed in SIDECAR_PROVISIONERS is the default backend exclusive placements provision on; required when SIDECAR_PROVISIONERS lists more than one id, optional (defaults to that one id) when it lists exactly one",
  ),
  "PROCESS_PROVISIONER_SIDECAR_ENTRY?": type("string > 0").describe(
    "the sidecar entry point the process backend spawns for each exclusive allocation; unset (default) resolves this repository's own apps/sidecar/src/index.ts",
  ),
  "PROCESS_PROVISIONER_RUNTIME?": type("string > 0").describe(
    "the executable the process backend runs that entry point with; unset (default) reuses the bun binary running the hub",
  ),
  "E2B_API_KEY?": type("string > 0").describe(
    "the E2B API key the e2b sidecar provisioner authenticates with; required when SIDECAR_PROVISIONERS includes 'e2b'",
  ),
  "E2B_TEMPLATE?": type("string > 0").describe(
    "the immutable E2B template id sandboxes are created from; required when SIDECAR_PROVISIONERS includes 'e2b'",
  ),
  "E2B_SANDBOX_TIMEOUT_MS?": type("string > 0").describe(
    "how long an E2B sandbox may live before E2B reclaims it; defaults to 15 minutes",
  ),
  "DOCKER_PROVISIONER_IMAGE?": type("string > 0").describe(
    "the container image the docker sidecar provisioner runs for each exclusive allocation; required when SIDECAR_PROVISIONERS includes 'docker'",
  ),
  "HUB_SIDECAR_WEBSOCKET_URL?": type(/^wss?:\/\/.+$/).describe(
    "the ws(s):// URL a provisioned sidecar container dials back to reach this hub; unset (default) derives it from BASE_URL, which is wrong for a docker sidecar provisioner — that container's own localhost is itself, not the hub host — so set this whenever SIDECAR_PROVISIONER=docker",
  ),
  "WORKBENCH_CHAT_IDLE_REAP_MS?": type("string").describe(
    "how long a chat resident (workbench host or invited agent) may sit idle before the hub reaps it via a state-preserving undeploy, in milliseconds; unset defaults to 30 minutes",
  ),
});

const DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_SIGNUP_RATE_LIMIT_MAX = 5;
// better-auth's own built-in special rule for /sign-in* is 3 attempts per
// 10 seconds, keyed per client IP -- too tight for a bucket that can end up
// shared (CL-6494): when the IP can't be resolved, or is forged, every
// signed-out visitor, or an attacker replaying the same forged header, can
// starve it. index.ts now disables that built-in rule for sign-in entirely
// (see sign-in-rate-limit.ts) and uses these knobs to configure its
// account-keyed replacement instead, applied the same in every environment
// rather than branched on NODE_ENV (this file already rejects inferring
// auth behavior from NODE_ENV — see `rateLimit.enabled` below). This gives
// real users room to mistype a password, and a lone local developer room
// to keep working even while no IP can be resolved, without loosening
// brute-force resistance.
const DEFAULT_SIGNIN_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_SIGNIN_RATE_LIMIT_MAX = 10;

/**
 * Production default for `WORKBENCH_CHAT_IDLE_REAP_MS`: 30 minutes,
 * matching the old sidecar-side `WORKBENCH_CHILD_IDLE_REAP_MS` default
 * this replaces for chat.
 */
export const DEFAULT_CHAT_IDLE_REAP_MS = 30 * 60_000;

/**
 * Parse an optional positive-integer-milliseconds env value, defaulting
 * to `fallback` when unset. Rejects zero and negative values — unlike
 * the sidecar's now-deleted reap knob, there is no "disable reaping"
 * mode here.
 */
function parsePositiveMsEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `invalid hub environment: ${name} must be a positive integer (milliseconds); got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

const SEED_MODEL_PROVIDER = "anthropic";
const SEED_MODEL = "claude-sonnet-5";
const SEED_MODEL_BASE_URL = "https://api.anthropic.com";

// Matches boot-time seeding's own defaults (`system-seed.ts`) exactly,
// so a zero-.env-edit local checkout that seeds its admin account
// through `bun run dev` also resolves the same operator bench for the
// env-key auto-plant with no extra configuration.
const DEFAULT_PLANT_ADMIN_EMAIL = "alice@example.com";
const DEFAULT_PLANT_ADMIN_PASSWORD = "password123";
const DEFAULT_PLANT_ORG_SLUG = "workbench";

export type ModelSource = {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
};

// One member per implemented `SidecarProvisioner` backend. Adding a new
// backend (e.g. a remote sandbox) is: implement the contract in its own
// package, add a member here with its settings, add its id to
// `SIDECAR_PROVISIONER_IDS`, and register it in
// `sidecarProvisionerFrom`'s per-id parsing below.
export type DockerSidecarProvisionerConfig = {
  readonly id: "docker";
  readonly image: string;
};

/** The sandbox backend. Its API key and template come from the process
 * environment; its hub-side state directory is derived from `hubDataDir`,
 * never configured separately, so it cannot drift from the other backends'
 * state or be confused with the sandbox's own `SIDECAR_DATA_DIR`. */
export type E2BSidecarProvisionerConfig = {
  readonly id: "e2b";
  readonly apiKey: string;
  readonly template: string;
  readonly sandboxTimeoutMs?: string;
};

/** The default backend: one `apps/sidecar` child process per allocation
 * on this host. It needs no operator settings at all — an unconfigured
 * install gets it — and both env keys below are overrides for an operator
 * running a sidecar build from somewhere other than this repository. */
export type ProcessSidecarProvisionerConfig = {
  readonly id: "process";
  readonly sidecarEntryPath?: string;
  readonly runtimePath?: string;
};

export type SidecarProvisionerConfig =
  | ProcessSidecarProvisionerConfig
  | DockerSidecarProvisionerConfig
  | E2BSidecarProvisionerConfig;

const SIDECAR_PROVISIONER_IDS = ["process", "docker", "e2b"] as const;
type SidecarProvisionerId = (typeof SIDECAR_PROVISIONER_IDS)[number];

function isSidecarProvisionerId(value: string): value is SidecarProvisionerId {
  return (SIDECAR_PROVISIONER_IDS as readonly string[]).includes(value);
}

export type SocialProviderId = "google" | "github";

export type SocialProviderCredential = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export type HubConfig = {
  readonly databaseUrl: string;
  readonly baseUrl: string;
  readonly listenPort?: number;
  readonly sessionSecret: string;
  readonly hubDataDir: string;
  readonly hubStaticDir: string;
  readonly defaultTenantSlug: string;
  readonly signupRateLimit: {
    readonly windowSeconds: number;
    readonly max: number;
  };
  readonly signInRateLimit: {
    readonly windowSeconds: number;
    readonly max: number;
  };
  /** Self-serve signup. Default closed — see docs/TENANCY.md. */
  readonly signupMode: "open" | "closed";
  /** Domains allowed when signupMode is open. Empty = any domain. */
  readonly allowedEmailDomains: readonly string[];
  readonly seedModel?: ModelSource;
  readonly socialProviders: Readonly<
    Partial<Record<SocialProviderId, SocialProviderCredential>>
  >;
  readonly huggingfaceOAuthClientId?: string;
  readonly githubAppClientId?: string;
  readonly githubAppClientSecret?: string;
  readonly gmailClientId?: string;
  readonly gmailClientSecret?: string;
  /** Override for the GitHub REST API origin the `github` connector's PAT
   * probe and credential delivery target. Unset (default) targets
   * https://api.github.com; a fake server substitutes cleanly in
   * tests/evals — never set this for a real deployment. */
  readonly githubApiBaseUrl?: string;
  readonly credentialEncryptionKeyHex?: string;
  /** Dev/test-only opt-in to boot without CREDENTIAL_ENCRYPTION_KEY. */
  readonly allowPlaintextSecrets: boolean;
  /** Dev/test-only opt-in to skip @workbench/access-policy's email-
   * verification requirement. */
  readonly allowUnverifiedEmails: boolean;
  /** Opt-in to initialize git-on-disk state inside an existing git work tree. */
  readonly allowGitInsideWorkTree?: boolean;
  /** Dev/test-only override for the routine scheduler's poll interval —
   * see `ROUTINE_SCHEDULER_POLL_INTERVAL_MS` above. Unset runs the real
   * production cadence (`routine-scheduler.ts`'s own default). */
  readonly routineSchedulerPollIntervalMs?: number;
  /** Every sidecar-allocation backend registered for exclusive placement,
   * one or more, each addressable by its provisioner id. Never empty: an
   * install that configures nothing registers the `process` backend, so
   * exclusive placement works on a single server out of the box. */
  readonly sidecarProvisioners: readonly SidecarProvisionerConfig[];
  /** Which registered id exclusive placements provision on. */
  readonly defaultSidecarProvisionerId?: string;
  /** Overrides the ws(s):// URL a provisioned sidecar dials back to reach
   * this hub. Unset derives it from baseUrl instead. */
  readonly sidecarWebSocketUrl?: string;
  /** How long an idle chat resident may sit before the hub reaps it via
   * a state-preserving undeploy. Defaults to `DEFAULT_CHAT_IDLE_REAP_MS`. */
  readonly chatIdleReapMs: number;
  /** Every curated provider's key found under its conventional env var
   * name (`@workbench/onboarding`'s `PROVIDER_ENV_VARS`). Empty when
   * none are set — the env-key auto-plant then does nothing. */
  readonly envProviderKeys: Partial<
    Record<SupportedCredentialProvider, string>
  >;
  /** The configured base URL for whichever curated providers carry one
   * (`OLLAMA_BASE_URL` today, the only such provider). Empty when unset
   * — the env-key auto-plant then probes and seeds ollama, if present in
   * `envProviderKeys`, against its own default local origin. */
  readonly envProviderBaseUrls: Partial<
    Record<SupportedCredentialProvider, string>
  >;
  /** The identity the env-key auto-plant signs in as to find the
   * operator bench — the same identity `workbench setup`/`workbench
   * seed` use, defaulted the same way when unset. Always populated
   * (never optional): an unset HUB_ADMIN_EMAIL/PASSWORD/ORG_SLUG is a
   * valid local-dev shape, not a reason to skip the plant outright —
   * the plant itself degrades to a no-op, logged, when this identity
   * does not resolve to a real operator bench. */
  readonly envCredentialPlantAdmin: {
    readonly email: string;
    readonly password: string;
    readonly orgSlug: string;
  };
};

type ParsedHubEnv = typeof HubEnv.infer;

const SOCIAL_PROVIDER_ENV_KEYS: Record<
  SocialProviderId,
  {
    readonly id: "GOOGLE_CLIENT_ID" | "GITHUB_CLIENT_ID";
    readonly secret: "GOOGLE_CLIENT_SECRET" | "GITHUB_CLIENT_SECRET";
  }
> = {
  google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  github: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
};

/**
 * Builds the social-provider credential map. A provider is enabled only
 * when both its id and secret are set; a half-configured pair (one set,
 * the other missing) is a boot-time error — never a silently-disabled
 * provider, per the DX mandate that misconfiguration fails loudly.
 */
function socialProvidersFrom(
  parsed: ParsedHubEnv,
): Readonly<Partial<Record<SocialProviderId, SocialProviderCredential>>> {
  const providers: Partial<Record<SocialProviderId, SocialProviderCredential>> =
    {};
  const errors: string[] = [];
  for (const [providerId, keys] of Object.entries(SOCIAL_PROVIDER_ENV_KEYS) as [
    SocialProviderId,
    (typeof SOCIAL_PROVIDER_ENV_KEYS)[SocialProviderId],
  ][]) {
    const clientId = parsed[keys.id];
    const clientSecret = parsed[keys.secret];
    if (clientId === undefined && clientSecret === undefined) continue;
    if (clientId === undefined || clientSecret === undefined) {
      errors.push(
        `${keys.id} and ${keys.secret} must be set together to enable ${providerId} sign-in; only one is set`,
      );
      continue;
    }
    providers[providerId] = { clientId, clientSecret };
  }
  if (errors.length > 0) {
    throw new Error(
      [
        `invalid hub environment: ${errors.join("; ")}`,
        "Set both values in .env, or unset both to leave the provider disabled; see .env.example.",
      ].join("\n"),
    );
  }
  return providers;
}

type SidecarProvisionersConfig = {
  readonly provisioners: readonly SidecarProvisionerConfig[];
  readonly defaultProvisionerId?: string;
};

/**
 * Resolves every sidecar-provisioner backend named in
 * `SIDECAR_PROVISIONERS` plus which one is the default. Each named
 * backend's own required settings (e.g. `DOCKER_PROVISIONER_IMAGE` for
 * `docker`) must be present, and an unknown id, a duplicate id, or a
 * `SIDECAR_DEFAULT_PROVISIONER` naming a backend that isn't listed all
 * fail boot loudly. With `SIDECAR_PROVISIONERS` unset or empty, the
 * `process` backend is registered as the sole default: an operator who
 * configures nothing gets exclusive sidecar placement on the hub's own
 * host, which is what makes a single-server install work with many
 * chats and workflows on one VPS. Choosing where sidecars run is then
 * one variable — `SIDECAR_PROVISIONERS` — and listing it explicitly
 * (including `process`) behaves exactly as any other explicit list.
 */
function sidecarProvisionersFrom(
  parsed: ParsedHubEnv,
): SidecarProvisionersConfig {
  const ids = (parsed.SIDECAR_PROVISIONERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (ids.length === 0) {
    if (parsed.SIDECAR_DEFAULT_PROVISIONER !== undefined) {
      throw new Error(
        [
          `invalid hub environment: SIDECAR_DEFAULT_PROVISIONER=${parsed.SIDECAR_DEFAULT_PROVISIONER} names a backend but SIDECAR_PROVISIONERS is unset`,
          "List that id in SIDECAR_PROVISIONERS, or unset SIDECAR_DEFAULT_PROVISIONER to leave exclusive sidecar placement disabled; see .env.example.",
        ].join("\n"),
      );
    }
    return {
      provisioners: [sidecarProvisionerConfigFor("process", parsed)],
      defaultProvisionerId: "process",
    };
  }

  const seen = new Set<string>();
  const provisioners: SidecarProvisionerConfig[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(
        `invalid hub environment: SIDECAR_PROVISIONERS lists ${id} more than once`,
      );
    }
    seen.add(id);
    if (!isSidecarProvisionerId(id)) {
      throw new Error(
        [
          `invalid hub environment: SIDECAR_PROVISIONERS names unknown backend ${id}`,
          `Supported ids: ${SIDECAR_PROVISIONER_IDS.join(", ")}.`,
        ].join("\n"),
      );
    }
    provisioners.push(sidecarProvisionerConfigFor(id, parsed));
  }

  const defaultProvisionerId = parsed.SIDECAR_DEFAULT_PROVISIONER;
  if (defaultProvisionerId === undefined) {
    if (provisioners.length > 1) {
      throw new Error(
        [
          "invalid hub environment: SIDECAR_DEFAULT_PROVISIONER must be set when SIDECAR_PROVISIONERS lists more than one backend",
          "Set SIDECAR_DEFAULT_PROVISIONER to one of the listed ids; see .env.example.",
        ].join("\n"),
      );
    }
    const onlyId = provisioners[0]?.id;
    return onlyId === undefined
      ? { provisioners }
      : { provisioners, defaultProvisionerId: onlyId };
  }
  if (!seen.has(defaultProvisionerId)) {
    throw new Error(
      [
        `invalid hub environment: SIDECAR_DEFAULT_PROVISIONER=${defaultProvisionerId} is not listed in SIDECAR_PROVISIONERS`,
        "Add it to SIDECAR_PROVISIONERS, or point SIDECAR_DEFAULT_PROVISIONER at a listed id; see .env.example.",
      ].join("\n"),
    );
  }
  return { provisioners, defaultProvisionerId };
}

function sidecarProvisionerConfigFor(
  id: SidecarProvisionerId,
  parsed: ParsedHubEnv,
): SidecarProvisionerConfig {
  switch (id) {
    case "process":
      return {
        id: "process",
        ...(parsed.PROCESS_PROVISIONER_SIDECAR_ENTRY === undefined
          ? {}
          : { sidecarEntryPath: parsed.PROCESS_PROVISIONER_SIDECAR_ENTRY }),
        ...(parsed.PROCESS_PROVISIONER_RUNTIME === undefined
          ? {}
          : { runtimePath: parsed.PROCESS_PROVISIONER_RUNTIME }),
      };
    case "docker": {
      if (parsed.DOCKER_PROVISIONER_IMAGE === undefined) {
        throw new Error(
          [
            "invalid hub environment: DOCKER_PROVISIONER_IMAGE must be set when SIDECAR_PROVISIONERS includes docker",
            "Set DOCKER_PROVISIONER_IMAGE in .env, or remove docker from SIDECAR_PROVISIONERS; see .env.example.",
          ].join("\n"),
        );
      }
      return { id: "docker", image: parsed.DOCKER_PROVISIONER_IMAGE };
    }
    case "e2b": {
      if (
        parsed.E2B_API_KEY === undefined ||
        parsed.E2B_TEMPLATE === undefined
      ) {
        throw new Error(
          [
            "invalid hub environment: E2B_API_KEY and E2B_TEMPLATE must both be set when SIDECAR_PROVISIONERS includes e2b",
            "Set them in .env (E2B_TEMPLATE is the immutable template id printed by the template build), or remove e2b from SIDECAR_PROVISIONERS; see .env.example.",
          ].join("\n"),
        );
      }
      return parsed.E2B_SANDBOX_TIMEOUT_MS === undefined
        ? {
            id: "e2b",
            apiKey: parsed.E2B_API_KEY,
            template: parsed.E2B_TEMPLATE,
          }
        : {
            id: "e2b",
            apiKey: parsed.E2B_API_KEY,
            template: parsed.E2B_TEMPLATE,
            sandboxTimeoutMs: parsed.E2B_SANDBOX_TIMEOUT_MS,
          };
    }
  }
}

function seedModelFrom(parsed: ParsedHubEnv): ModelSource | undefined {
  const apiKey = parsed.ANTHROPIC_API_KEY;
  if (apiKey === undefined) return undefined;
  return {
    provider: SEED_MODEL_PROVIDER,
    model: SEED_MODEL,
    baseURL: SEED_MODEL_BASE_URL,
    apiKey,
  };
}

/**
 * Parse the hub's configuration out of an environment map. Throws at
 * the call site when any variable is missing or malformed, reporting
 * every problem at once and naming each variable and the shape it must
 * have, so a misconfigured process dies at boot instead of failing at
 * first use.
 */
export function readHubConfig(
  env: Record<string, string | undefined>,
): HubConfig {
  if (env.OPERATOR_TENANT_ID !== undefined) {
    throw new Error(
      "OPERATOR_TENANT_ID is no longer read: the hub ensures the root tenant by slug at boot. " +
        "Set WORKBENCH_DEFAULT_TENANT to your existing root tenant's slug " +
        '(or remove OPERATOR_TENANT_ID to keep the default slug "workbench"), then restart.',
    );
  }

  const parsed = HubEnv(env);
  if (parsed instanceof type.errors) {
    throw new Error(
      [
        `invalid hub environment: ${parsed.summary}`,
        "Set the values above in .env; see .env.example for the expected shape of each.",
      ].join("\n"),
    );
  }

  const seedModel = seedModelFrom(parsed);
  const socialProviders = socialProvidersFrom(parsed);
  const sidecarProvisioners = sidecarProvisionersFrom(parsed);

  const allowedEmailDomains =
    parsed.WORKBENCH_ALLOWED_EMAIL_DOMAINS === undefined ||
    parsed.WORKBENCH_ALLOWED_EMAIL_DOMAINS.trim() === ""
      ? []
      : parsed.WORKBENCH_ALLOWED_EMAIL_DOMAINS.split(",")
          .map((d) => d.trim())
          .filter((d) => d.length > 0);

  // One deployment fact shared by boot parenting, setup/seed, and the
  // env-key auto-plant. WORKBENCH_DEFAULT_TENANT wins; ORG_SLUG is the
  // alias when that is unset.
  const defaultTenantSlug =
    parsed.WORKBENCH_DEFAULT_TENANT ??
    parsed.ORG_SLUG ??
    DEFAULT_PLANT_ORG_SLUG;

  const hubConfig: { -readonly [K in keyof HubConfig]: HubConfig[K] } = {
    databaseUrl: parsed.DATABASE_URL,
    baseUrl: parsed.BASE_URL,
    sessionSecret: parsed.SESSION_SECRET,
    hubDataDir: parsed.HUB_DATA_DIR,
    hubStaticDir: parsed.HUB_STATIC_DIR,
    defaultTenantSlug,
    socialProviders,
    signupMode: parsed.WORKBENCH_SIGNUP ?? "closed",
    allowedEmailDomains,
    allowPlaintextSecrets: parsed.ALLOW_PLAINTEXT_SECRETS !== undefined,
    allowUnverifiedEmails: parsed.ALLOW_UNVERIFIED_EMAILS !== undefined,
    sidecarProvisioners: sidecarProvisioners.provisioners,
    signupRateLimit: {
      windowSeconds: parsed.SIGNUP_RATE_LIMIT_WINDOW_SECONDS
        ? Number(parsed.SIGNUP_RATE_LIMIT_WINDOW_SECONDS)
        : DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_SECONDS,
      max: parsed.SIGNUP_RATE_LIMIT_MAX
        ? Number(parsed.SIGNUP_RATE_LIMIT_MAX)
        : DEFAULT_SIGNUP_RATE_LIMIT_MAX,
    },
    signInRateLimit: {
      windowSeconds: parsed.SIGNIN_RATE_LIMIT_WINDOW_SECONDS
        ? Number(parsed.SIGNIN_RATE_LIMIT_WINDOW_SECONDS)
        : DEFAULT_SIGNIN_RATE_LIMIT_WINDOW_SECONDS,
      max: parsed.SIGNIN_RATE_LIMIT_MAX
        ? Number(parsed.SIGNIN_RATE_LIMIT_MAX)
        : DEFAULT_SIGNIN_RATE_LIMIT_MAX,
    },
    envProviderKeys: envProviderKeysFrom(parsed),
    envProviderBaseUrls: envProviderBaseUrlsFrom(parsed),
    envCredentialPlantAdmin: {
      email: parsed.HUB_ADMIN_EMAIL ?? DEFAULT_PLANT_ADMIN_EMAIL,
      password: parsed.HUB_ADMIN_PASSWORD ?? DEFAULT_PLANT_ADMIN_PASSWORD,
      orgSlug: defaultTenantSlug,
    },
    chatIdleReapMs: parsePositiveMsEnv(
      parsed.WORKBENCH_CHAT_IDLE_REAP_MS,
      "WORKBENCH_CHAT_IDLE_REAP_MS",
      DEFAULT_CHAT_IDLE_REAP_MS,
    ),
  };
  if (parsed.HUB_ALLOW_GIT_INSIDE_WORK_TREE !== undefined)
    hubConfig.allowGitInsideWorkTree = true;
  if (parsed.PORT !== undefined) hubConfig.listenPort = Number(parsed.PORT);
  if (parsed.ROUTINE_SCHEDULER_POLL_INTERVAL_MS !== undefined)
    hubConfig.routineSchedulerPollIntervalMs = Number(
      parsed.ROUTINE_SCHEDULER_POLL_INTERVAL_MS,
    );
  if (seedModel !== undefined) hubConfig.seedModel = seedModel;
  if (parsed.HUGGINGFACE_OAUTH_CLIENT_ID !== undefined)
    hubConfig.huggingfaceOAuthClientId = parsed.HUGGINGFACE_OAUTH_CLIENT_ID;
  if (parsed.GITHUB_APP_CLIENT_ID !== undefined)
    hubConfig.githubAppClientId = parsed.GITHUB_APP_CLIENT_ID;
  if (parsed.GITHUB_APP_CLIENT_SECRET !== undefined)
    hubConfig.githubAppClientSecret = parsed.GITHUB_APP_CLIENT_SECRET;
  if (parsed.GMAIL_CLIENT_ID !== undefined)
    hubConfig.gmailClientId = parsed.GMAIL_CLIENT_ID;
  if (parsed.GMAIL_CLIENT_SECRET !== undefined)
    hubConfig.gmailClientSecret = parsed.GMAIL_CLIENT_SECRET;
  if (parsed.GITHUB_API_BASE_URL !== undefined)
    hubConfig.githubApiBaseUrl = parsed.GITHUB_API_BASE_URL;
  if (parsed.CREDENTIAL_ENCRYPTION_KEY !== undefined)
    hubConfig.credentialEncryptionKeyHex = parsed.CREDENTIAL_ENCRYPTION_KEY;
  if (parsed.HUB_SIDECAR_WEBSOCKET_URL !== undefined)
    hubConfig.sidecarWebSocketUrl = parsed.HUB_SIDECAR_WEBSOCKET_URL;
  if (sidecarProvisioners.defaultProvisionerId !== undefined)
    hubConfig.defaultSidecarProvisionerId =
      sidecarProvisioners.defaultProvisionerId;

  if (
    hubConfig.allowPlaintextSecrets &&
    !isLoopbackBaseUrl(hubConfig.baseUrl)
  ) {
    throw new Error(
      [
        `ALLOW_PLAINTEXT_SECRETS is set, but BASE_URL (${hubConfig.baseUrl}) is not a loopback address.`,
        "Storing secrets unencrypted at rest is a dev/test-only fallback for",
        "http://localhost — refused here because this looks like a real",
        "deployment. Generate a real key instead and add it to .env:",
        "",
        "  openssl rand -hex 32",
        "",
        "then set CREDENTIAL_ENCRYPTION_KEY to it and remove ALLOW_PLAINTEXT_SECRETS.",
      ].join("\n"),
    );
  }

  return hubConfig;
}
