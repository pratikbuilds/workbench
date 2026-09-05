// A periodic loop covering two different OAuth-expiry stories under one
// sweep. The original (CL-5988, Hugging Face): a consumer PKCE flow that
// documents no silent-renewal or refresh-token grant, so a credential's
// `metadata.expiresAt` (set at connect time by `completeCredentialSetup`)
// is the only signal a background sweep has, and the only thing this
// sweep can do is mail a human a reconnect nudge. The second (CL-6207,
// any OAuth-connected MCP server): the MCP SDK's own `auth()`
// orchestrator refreshes natively when handed a stored `refresh_token`,
// so a `mcp:<slug>` `oauth_token` credential nearing its real `expiresAt`
// column gets refreshed in place instead — the reconnect nudge is now a
// last resort, sent only when that refresh itself fails.
//
// This mirrors the hub's native schedule poller shape: the decision of
// *which* Hugging-Face-style credentials are due lives in
// `@corbits/notify` (`findDueCredentialExpiries`), pure and unit-tested
// there; `CredentialExpirySweepStore` is a store-behind-an-interface
// seam, so this loop's own claim/refresh/mail orchestration is testable
// against an in-memory store without a live Postgres.
//
// Interchange's inference reactor already fails a credential-category
// error over to the next configured source with no changes here — for
// the still-unrefreshable case, this sweep exists only to tell a human
// the failover is happening and how to stop it (reconnect, or drop in a
// durable fine-grained PAT instead).
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { type } from "arktype";
import { credential, principal, provider } from "@intx/db/schema";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { reportError } from "@corbits/error-sink";
import {
  deliverCredentialMail,
  findDueCredentialExpiries,
  type CredentialExpiredNotification,
  type ExpiringCredential,
  type NotifyDeliveryDeps,
} from "@corbits/notify";
import { pushSourceUpdates, type SidecarRouter } from "@intx/hub-sessions";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { MCP_STREAMABLE_HTTP_PROVIDER_KEY } from "@corbits/credential-providers";
import {
  mcpSlugOf,
  refreshMcpOAuthTokens,
  type McpOAuthRefreshResult,
} from "@corbits/connections";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
// How far ahead of its stored `expiresAt` an MCP oauth_token credential
// is refreshed — a token expiring before the *next* tick is refreshed
// this tick, so a live session never sees the gap.
const MCP_REFRESH_LEAD_MS = POLL_INTERVAL_MS;
const MCP_OAUTH_CLIENT_NAME = "Corbits Workbench";
const log = getLogger(["hub", "credential-expiry-sweep"]);

// Mail-first-claim-after (see `mailThenClaimExpiry`) leaves a still-due
// credential `active` for as long as it keeps failing to notify anyone —
// on purpose, so a transient mail outage or a not-yet-provisioned
// recipient gets more than one tick to resolve. Left unbounded, though,
// `active` stops meaning "usable": the credential is genuinely dead at
// the provider, and the rest of the system (anything selecting an
// `active` credential to actually use) would keep trusting a row that
// will never work again. Past these ages the sweep gives up on ever
// notifying anyone and claims the expiry anyway, so the stored status
// stops asserting something false — reported loudly, since nobody was
// told.
//
// The two failure shapes get different budgets: a mail outage is a
// transient, systemic condition most likely to resolve within a day if
// it's going to resolve at all, while a credential with zero active
// recipients is more often a slow-moving tenant-provisioning gap (a new
// tenant, a departed user being replaced) that deserves more real-world
// time before writing off the notification as unreachable.
const MAX_UNMAILED_CREDENTIAL_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_UNOWNED_CREDENTIAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The OAuth-connected providers whose tokens expire, and how to name
// each in the notification. A second such provider generalizes this
// list, never a second parallel sweep.
export const SWEPT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  huggingface: "Hugging Face",
};

const CredentialMetadata = type({ "expiresAt?": "string" });
const McpCredentialMetadata = type({
  url: "string",
  "name?": "string",
  "clientInformation?": "unknown",
});

function mcpOAuthCallbackUrl(
  hubUrl: string,
  tenantId: string,
  slug: string,
): string {
  return new URL(
    `/api/tenants/${tenantId}/mcp-servers/oauth/${slug}/callback`,
    hubUrl,
  ).toString();
}

export type RefreshableMcpCredential = {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly tokens: OAuthTokens;
  readonly clientInformation?: OAuthClientInformationMixed;
  readonly recipients: readonly { tenantId: string; principalId: string }[];
  /** The credential's real `expiresAt` column — when it became due for
   * this reconnect-nudge fallback, used to bound how long an unmailed
   * expiry is left `active` (see `MAX_UNMAILED_CREDENTIAL_AGE_MS`). */
  readonly expiresAt: Date;
};

export type CredentialExpirySweepStore = {
  /** Every `active` credential on a swept provider, with its parsed
   * expiry (if any) and the recipients a reconnect nudge would reach. */
  loadActiveCandidates(): Promise<readonly ExpiringCredential[]>;
  /** Conditionally moves one credential from `active` to `expired`.
   * Returns whether this call won the claim — `false` means another
   * caller (a racing replica) already claimed this exact expiry. */
  claimExpiry(credentialId: string, now: Date): Promise<boolean>;
  /** Every `active`, refresh-capable `mcp:<slug>` `oauth_token`
   * credential whose stored `expiresAt` is at or before `cutoff`. */
  loadRefreshableMcpCandidates(
    cutoff: Date,
  ): Promise<readonly RefreshableMcpCredential[]>;
  /** Persists a successful refresh's new token pair and re-pushes live
   * inference sources for the credential's tenant, mirroring the
   * credentials PATCH route's own post-rotation behavior. Returns
   * whether the row was still `active` to update — `false` means
   * another replica already claimed it as expired. */
  applyMcpRefresh(
    credentialId: string,
    tenantId: string,
    tokens: OAuthTokens,
  ): Promise<boolean>;
};

export function createDrizzleCredentialExpirySweepStore(
  db: DB["db"],
  credentialCipher: CredentialCipher,
  sidecarRouter: SidecarRouter,
): CredentialExpirySweepStore {
  return {
    async loadActiveCandidates() {
      const sweptProviderNames = Object.keys(SWEPT_PROVIDER_LABELS);
      const rows = await db
        .select({
          id: credential.id,
          tenantId: credential.tenantId,
          status: credential.status,
          metadata: credential.metadata,
          providerName: provider.name,
        })
        .from(credential)
        .innerJoin(provider, eq(provider.id, credential.providerId))
        .where(
          and(
            eq(credential.status, "active"),
            inArray(provider.name, sweptProviderNames),
          ),
        );
      if (rows.length === 0) return [];

      const tenantIds = [...new Set(rows.map((row) => row.tenantId))];
      const recipientRows = await db
        .select({ tenantId: principal.tenantId, principalId: principal.id })
        .from(principal)
        .where(
          and(
            inArray(principal.tenantId, tenantIds),
            eq(principal.kind, "user"),
            eq(principal.status, "active"),
          ),
        );
      const recipientsByTenant = new Map<
        string,
        { tenantId: string; principalId: string }[]
      >();
      for (const row of recipientRows) {
        const list = recipientsByTenant.get(row.tenantId) ?? [];
        list.push(row);
        recipientsByTenant.set(row.tenantId, list);
      }

      return rows.map((row) => {
        const parsedMetadata = CredentialMetadata(row.metadata ?? {});
        const expiresAt =
          parsedMetadata instanceof type.errors
            ? undefined
            : parsedMetadata.expiresAt;
        return {
          credentialId: row.id,
          tenantId: row.tenantId,
          providerId: row.providerName,
          providerLabel:
            SWEPT_PROVIDER_LABELS[row.providerName] ?? row.providerName,
          status: row.status,
          expiresAt,
          recipients: recipientsByTenant.get(row.tenantId) ?? [],
        };
      });
    },
    async claimExpiry(credentialId, now) {
      const claimed = await db
        .update(credential)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(eq(credential.id, credentialId), eq(credential.status, "active")),
        )
        .returning({ id: credential.id });
      return claimed.length > 0;
    },
    async loadRefreshableMcpCandidates(cutoff) {
      const rows = await db
        .select({
          id: credential.id,
          tenantId: credential.tenantId,
          secret: credential.secret,
          refreshSecret: credential.refreshSecret,
          expiresAt: credential.expiresAt,
          metadata: credential.metadata,
          providerName: provider.name,
          apiBaseUrl: provider.apiBaseUrl,
        })
        .from(credential)
        .innerJoin(provider, eq(provider.id, credential.providerId))
        .where(
          and(
            eq(credential.status, "active"),
            eq(credential.type, "oauth_token"),
            eq(provider.plugin, MCP_STREAMABLE_HTTP_PROVIDER_KEY),
            isNotNull(credential.refreshSecret),
          ),
        );

      const due = rows.filter(
        (row): row is typeof row & { expiresAt: Date } =>
          row.expiresAt !== null && row.expiresAt.getTime() <= cutoff.getTime(),
      );
      if (due.length === 0) return [];

      const tenantIds = [...new Set(due.map((row) => row.tenantId))];
      const recipientRows = await db
        .select({ tenantId: principal.tenantId, principalId: principal.id })
        .from(principal)
        .where(
          and(
            inArray(principal.tenantId, tenantIds),
            eq(principal.kind, "user"),
            eq(principal.status, "active"),
          ),
        );
      const recipientsByTenant = new Map<
        string,
        { tenantId: string; principalId: string }[]
      >();
      for (const row of recipientRows) {
        const list = recipientsByTenant.get(row.tenantId) ?? [];
        list.push(row);
        recipientsByTenant.set(row.tenantId, list);
      }

      const candidates: RefreshableMcpCredential[] = [];
      for (const row of due) {
        // `refreshSecret` is guaranteed non-null by `isNotNull` above;
        // a row that fails to parse its own metadata (missing `url`) is
        // a stored-data bug, not a transient condition — skip it loudly
        // rather than guess at a server URL.
        const parsedMetadata = McpCredentialMetadata(row.metadata ?? {});
        if (parsedMetadata instanceof type.errors) {
          log.warn`mcp oauth credential ${row.id} has unparseable metadata, skipping refresh: ${parsedMetadata.summary}`;
          continue;
        }
        const accessToken = await credentialCipher.decrypt(
          row.secret,
          credentialAad(row.id, "secret"),
        );
        const refreshToken = await credentialCipher.decrypt(
          row.refreshSecret as string,
          credentialAad(row.id, "refreshSecret"),
        );
        candidates.push({
          credentialId: row.id,
          tenantId: row.tenantId,
          slug: mcpSlugOf(row.providerName),
          name: parsedMetadata.name ?? row.providerName,
          serverUrl: row.apiBaseUrl ?? parsedMetadata.url,
          expiresAt: row.expiresAt,
          tokens: {
            access_token: accessToken,
            token_type: "bearer",
            refresh_token: refreshToken,
          },
          ...(parsedMetadata.clientInformation !== undefined
            ? {
                clientInformation:
                  parsedMetadata.clientInformation as OAuthClientInformationMixed,
              }
            : {}),
          recipients: recipientsByTenant.get(row.tenantId) ?? [],
        });
      }
      return candidates;
    },
    async applyMcpRefresh(credentialId, tenantId, tokens) {
      const now = new Date();
      const encryptedSecret = await credentialCipher.encrypt(
        tokens.access_token,
        credentialAad(credentialId, "secret"),
      );
      const encryptedRefreshSecret =
        tokens.refresh_token === undefined
          ? undefined
          : await credentialCipher.encrypt(
              tokens.refresh_token,
              credentialAad(credentialId, "refreshSecret"),
            );
      const updated = await db
        .update(credential)
        .set({
          secret: encryptedSecret,
          ...(encryptedRefreshSecret !== undefined
            ? { refreshSecret: encryptedRefreshSecret }
            : {}),
          ...(tokens.expires_in !== undefined
            ? { expiresAt: new Date(now.getTime() + tokens.expires_in * 1000) }
            : {}),
          updatedAt: now,
        })
        .where(
          and(eq(credential.id, credentialId), eq(credential.status, "active")),
        )
        .returning({ id: credential.id });
      if (updated.length === 0) return false;

      void pushSourceUpdates(db, sidecarRouter, tenantId, credentialCipher);
      return true;
    },
  };
}

export type CredentialExpirySweepDeps = {
  store: CredentialExpirySweepStore;
  notify: NotifyDeliveryDeps;
  /** The hub's own base URL — reconstructs the exact `/callback` route an
   * MCP oauth_token credential's client was registered against, so a
   * refresh that needs a fresh dynamic client registration lands on the
   * same redirect URI the original connect used. */
  hubUrl: string;
  /** Re-invokes the MCP SDK's `auth()` orchestrator non-interactively.
   * Defaults to the real `@corbits/connections` implementation;
   * overridable so a test can stub the authorization server round trip. */
  refreshMcpTokens?: typeof refreshMcpOAuthTokens;
  /** Injectable for deterministic tests; defaults to `Date.now`-backed wall time. */
  now?: () => Date;
};

/**
 * Mail a credential-expiry reconnect nudge, then claim the credential as
 * `expired` only once that mail has gone out (or is already out — a
 * `credential-expired` event dedupes on `credentialId` alone, so a
 * redelivery from a retried tick is a harmless no-op, never a second
 * mail). Claiming is deliberately the LAST step: `active` is the durable
 * "still needs a decision" state, and this function leaves a credential
 * `active` whenever that decision (mail sent, credential marked expired)
 * did not fully land, so the next tick's own due-scan is the retry —
 * no separate retry queue is needed. A thrown mail error is reported
 * and swallowed here (never `active` → `expired` with the notification
 * lost), and never propagates out to abort sibling candidates in the
 * same tick.
 *
 * That "stay active and retry" grace is bounded by `dueSince` (see
 * `MAX_UNMAILED_CREDENTIAL_AGE_MS` / `MAX_UNOWNED_CREDENTIAL_AGE_MS`):
 * once a credential has been due for longer than its budget with the
 * notification still unsent, this claims the expiry anyway rather than
 * asserting `active` forever for a credential that is genuinely dead at
 * the provider — reported loudly, since giving up here means nobody was
 * ever told.
 */
async function mailThenClaimExpiry(
  deps: CredentialExpirySweepDeps,
  now: Date,
  target: {
    readonly credentialId: string;
    readonly tenantId: string;
    readonly recipients: readonly { tenantId: string; principalId: string }[];
    readonly dueSince: Date;
  },
  event: CredentialExpiredNotification,
): Promise<void> {
  const ageMs = now.getTime() - target.dueSince.getTime();

  if (target.recipients.length === 0) {
    if (ageMs < MAX_UNOWNED_CREDENTIAL_AGE_MS) {
      log.warn`credential ${target.credentialId} has no active recipient to notify; leaving it active until one exists`;
      return;
    }
    reportError(
      new Error(
        "credential expiry never had an active recipient to notify; claiming it as expired unnotified",
      ),
      {
        operation: "credential-expiry-sweep.abandon-unowned",
        tenantId: target.tenantId,
        extra: {
          credentialId: target.credentialId,
          dueSince: target.dueSince.toISOString(),
        },
      },
    );
    await deps.store.claimExpiry(target.credentialId, now);
    return;
  }

  try {
    await deliverCredentialMail(deps.notify, event);
  } catch (err) {
    if (ageMs < MAX_UNMAILED_CREDENTIAL_AGE_MS) {
      reportError(err, {
        operation: "credential-expiry-sweep.deliver",
        tenantId: target.tenantId,
        extra: { credentialId: target.credentialId },
      });
      return;
    }
    reportError(err, {
      operation: "credential-expiry-sweep.abandon-unmailed",
      tenantId: target.tenantId,
      extra: {
        credentialId: target.credentialId,
        dueSince: target.dueSince.toISOString(),
      },
    });
    await deps.store.claimExpiry(target.credentialId, now);
    return;
  }
  const claimed = await deps.store.claimExpiry(target.credentialId, now);
  // False means another replica already claimed this exact expiry
  // between the mail attempt and this claim — not an error.
  if (!claimed) return;
}

/**
 * One sweep: mail-then-claim every Hugging-Face-style credential expiry
 * due at `now`, then refresh (or, on refresh failure, mail-then-claim)
 * every MCP oauth_token credential nearing its own real expiry. Exported
 * (rather than kept as a closure) so a test can drive a single,
 * deterministic pass without waiting on `setInterval`.
 */
export async function tickCredentialExpirySweep(
  deps: CredentialExpirySweepDeps,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const refreshMcpTokens = deps.refreshMcpTokens ?? refreshMcpOAuthTokens;

  const candidates = await deps.store.loadActiveCandidates();
  const due = findDueCredentialExpiries(candidates, now);

  for (const { credential: expiring, event } of due) {
    // Guaranteed defined and parseable for anything `findDueCredentialExpiries`
    // returned; `now` is an unreachable fallback, never a real fallback value.
    const dueSince =
      expiring.expiresAt !== undefined ? new Date(expiring.expiresAt) : now;
    await mailThenClaimExpiry(
      deps,
      now,
      {
        credentialId: expiring.credentialId,
        tenantId: expiring.tenantId,
        recipients: expiring.recipients,
        dueSince,
      },
      event,
    );
  }

  const refreshable = await deps.store.loadRefreshableMcpCandidates(
    new Date(now.getTime() + MCP_REFRESH_LEAD_MS),
  );
  for (const candidate of refreshable) {
    const result: McpOAuthRefreshResult = await refreshMcpTokens({
      serverUrl: candidate.serverUrl,
      tokens: candidate.tokens,
      ...(candidate.clientInformation !== undefined
        ? { clientInformation: candidate.clientInformation }
        : {}),
      callbackUrl: mcpOAuthCallbackUrl(
        deps.hubUrl,
        candidate.tenantId,
        candidate.slug,
      ),
      clientName: MCP_OAUTH_CLIENT_NAME,
    });

    if (result.ok) {
      await deps.store.applyMcpRefresh(
        candidate.credentialId,
        candidate.tenantId,
        result.tokens,
      );
      continue;
    }

    log.warn`mcp oauth refresh failed for credential ${candidate.credentialId} ("${candidate.name}"): ${result.message}`;
    await mailThenClaimExpiry(
      deps,
      now,
      {
        credentialId: candidate.credentialId,
        tenantId: candidate.tenantId,
        recipients: candidate.recipients,
        dueSince: candidate.expiresAt,
      },
      {
        kind: "credential-expired",
        tenantId: candidate.tenantId,
        credentialId: candidate.credentialId,
        providerId: `mcp:${candidate.slug}`,
        providerLabel: candidate.name,
        recipients: [...candidate.recipients],
        createdAt: now.toISOString(),
      },
    );
  }
}

export function createCredentialExpirySweep(deps: CredentialExpirySweepDeps) {
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tickCredentialExpirySweep(deps);
    } catch (err) {
      log.error`credential expiry sweep failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      tickInFlight = false;
    }
  }

  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}
