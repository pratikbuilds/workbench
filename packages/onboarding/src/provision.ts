// The first-login decision: a signed-in session with zero principals
// anywhere gets a personal bench, minted through the native tenant-
// creation route (never a product-owned tenant table of our own),
// parented under the operator tenant when one is configured, and
// seeded with the default workflow set when the hub carries a seed
// model credential. Every step reuses a native route or
// `@corbits/seeding`; nothing here re-implements tenant creation,
// grant planting, or workflow deployment.

import {
  AssetWithOriginResponse,
  paginatedSchema,
  PrincipalSummary,
  TenantResponse,
} from "@intx/types";
import { type } from "arktype";
import {
  DEFAULT_WORKFLOWS,
  reconcileSeedGrants,
  seedTenant,
  isCorbitsToolsRegistrySeeded,
  type ModelSource,
  type WorkflowPusher,
  isLiveDeploymentStatus,
} from "@corbits/seeding";
import { parseAs, type ApiCall } from "@corbits/hub-api-client";
import { reportError } from "@corbits/error-sink";
import {
  checkSignupGate,
  resolvePendingInviteOnLogin,
  type AccessPolicyStore,
} from "@workbench/access-policy";

export type ProvisionResult =
  | {
      readonly kind: "existing-member";
      /**
       * Present only when the caller owns the personal bench this hook
       * itself provisions: `true` once every default workflow is
       * deployed, `false` when it is still waiting on a working
       * credential (the `bench_unseeded` condition the onboarding UI
       * reads to keep the credential step open instead of declaring
       * setup finished). Absent when membership belongs to some other
       * tenant this hook does not own — its seed state is none of this
       * hook's business.
       *
       * `seeded: true` here means every default workflow has an active
       * deployment (`isFullySeeded`'s own check) — it is not, by itself,
       * proof of a working inference credential. The onboarding UI must
       * not hard-skip the credential step on this flag alone; see
       * `tenantId` below.
       */
      readonly seeded?: boolean;
      /**
       * Present under the same condition as `seeded`: the caller's own
       * personal bench. Lets the onboarding UI independently confirm a
       * working inference credential exists (a cheap credentials read)
       * before trusting `seeded: true` enough to skip the credential
       * step entirely.
       */
      readonly tenantId?: string;
    }
  | { readonly kind: "needs-onboarding" }
  | {
      readonly kind: "provisioned";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly seeded: boolean;
      readonly seedSkipReason?: string;
    };

/**
 * A typed provisioning failure. `kind` lets the routes layer distinguish
 * a retryable (transient) failure — sidecar down, race, network — from a
 * permanent one — slug conflict with no principal, tenant created but
 * membership missing — so the client can decide whether to retry without
 * parsing a free-text message.
 */
export type ProvisionErrorKind = "transient" | "permanent";

export class ProvisionError extends Error {
  readonly code: string;
  readonly errorKind: ProvisionErrorKind;
  constructor(code: string, message: string, errorKind: ProvisionErrorKind) {
    super(message);
    this.name = "ProvisionError";
    this.code = code;
    this.errorKind = errorKind;
  }
}

export type ProvisionArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  userId: string;
  userEmail: string;
  /** better-auth is configured without `requireEmailVerification` — an
   * unverified email must never pass a domain-allowlist or redeem a
   * pending invite meant for someone else. See
   * `@workbench/access-policy`'s `evaluateSignupGate` doc comment. */
  userEmailVerified: boolean;
  /** Display name for the personal bench. Required to mint: when omitted
   * (shell membership probe), returns `needs-onboarding` and creates nothing. */
  displayName?: string;
  operatorTenantId?: string;
  seedModel?: ModelSource;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
  /** The closed-by-default access-policy gate. Absent means this hub
   * runs with no access-policy package wired in at all — never a valid
   * production shape, but some tests exercise provisioning in
   * isolation from it. */
  accessPolicy?: {
    store: AccessPolicyStore;
    envSignupMode: "open" | "closed";
    envAllowedDomains: readonly string[];
    /** Dev/test-only opt-out of the `userEmailVerified` requirement —
     * mirrors `ALLOW_PLAINTEXT_SECRETS`. Never set for a real deployment. */
    allowUnverifiedEmails: boolean;
  };
};

/** A lowercase-kebab personal-bench slug, unique per user without a
 * coordinating registry: the local part of the email plus a short
 * fragment of the user's own id, which the platform already treats as
 * unique. */
export function personalTenantSlug(email: string, userId: string): string {
  const local = email.split("@")[0] ?? email;
  const kebab = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = userId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `${kebab || "bench"}-${suffix || "personal"}`;
}

async function fetchPrincipals(
  api: ApiCall,
  cookies: string[],
): Promise<{ tenantId: string; tenantSlug: string; principalId: string }[]> {
  const response = await api("GET", "/api/me/principals", undefined, cookies);
  const summary = parseAs(
    paginatedSchema(PrincipalSummary),
    response.data,
    "principals response",
  );
  return summary.data.map((p) => ({
    tenantId: p.tenantId,
    tenantSlug: p.tenantSlug,
    principalId: p.principalId,
  }));
}

const WorkflowDeploymentStatus = type({
  definitionAssetId: "string",
  status: "string",
});

/** Which of `DEFAULT_WORKFLOWS`' asset names already carry an active
 * deployment on this tenant, split from those that do not — the same
 * asset-then-deployment lookup `isFullySeeded` and `seedTenant` each
 * perform before deciding whether a step has already run. Read-only: it
 * never creates or deploys anything. */
async function seededWorkflowNames(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<{ deployed: string[]; pending: string[] }> {
  const assetsResponse = await api(
    "GET",
    `/api/tenants/${tenantId}/assets?kind=workflow&inherited=false`,
    undefined,
    cookies,
  );
  const assets = parseAs(
    AssetWithOriginResponse.array(),
    assetsResponse.data,
    "assets response",
  );

  const deploymentsResponse = await api(
    "GET",
    `/api/tenants/${tenantId}/workflows/deployments`,
    undefined,
    cookies,
  );
  const deployments = parseAs(
    WorkflowDeploymentStatus.array(),
    deploymentsResponse.data,
    "deployments response",
  );

  const deployed: string[] = [];
  const pending: string[] = [];
  for (const workflow of DEFAULT_WORKFLOWS) {
    const asset = assets.find((a) => a.name === workflow.assetName);
    const isDeployed =
      asset !== undefined &&
      deployments.some(
        (d) =>
          d.definitionAssetId === asset.id && isLiveDeploymentStatus(d.status),
      );
    (isDeployed ? deployed : pending).push(workflow.assetName);
  }
  return { deployed, pending };
}

/**
 * Whether every default workflow already has an active deployment on
 * this tenant AND the `corbits-tools` registry exists with the seeded
 * tool-package tarballs (at least `@corbits/memory-tools`). Read-only:
 * it never creates or deploys anything. A dangling empty registry row
 * is not fully seeded — assistant-deployed-but-unpublishable is the
 * first-launch failure this check exists to catch.
 */
export async function isFullySeeded(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<boolean> {
  const { pending } = await seededWorkflowNames(api, cookies, tenantId);
  if (pending.length > 0) return false;
  return isCorbitsToolsRegistrySeeded(api, cookies, tenantId);
}

/**
 * The honest partial-seed report `ensureSeeded` reads after catching a
 * sidecar-unavailable deploy failure (CL-6264): which default workflows
 * already deployed before the sidecar dropped out, and which are still
 * waiting on it. Exported so `@workbench/onboarding`'s
 * `complete-credential.ts` never re-derives this asset-then-deployment
 * lookup by hand.
 */
export async function seededWorkflowStatus(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<{ deployed: string[]; pending: string[] }> {
  return seededWorkflowNames(api, cookies, tenantId);
}

/**
 * Runs the first-login hook: checks whether the caller already belongs
 * to any tenant and, if not, provisions and seeds a personal bench for
 * them. Safe to call on every sign-in — an existing member is a single
 * read and nothing else.
 */
export async function provisionPersonalTenantIfNeeded(
  args: ProvisionArgs,
): Promise<ProvisionResult> {
  const expectedSlug = personalTenantSlug(args.userEmail, args.userId);
  const before = await fetchPrincipals(args.api, args.cookies);
  if (before.length > 0) {
    // A membership already exists. If it is not the personal bench this
    // hook itself owns, there is nothing to recover — some other bench
    // added this user, and that is none of this hook's business. If it
    // is our own personal bench, an earlier call may have created the
    // tenant and then failed before seeding it; re-seed rather than
    // silently treating "created but never seeded" as done.
    const own = before.find((p) => p.tenantSlug === expectedSlug);
    // Not our personal bench: some other tenant added this user, which
    // is none of this hook's business. Membership is decided here without
    // depending on a seed credential — recovery of a half-provisioned
    // bench must not hang forever just because no seed model is configured.
    if (own === undefined) return { kind: "existing-member" };

    // SEED_GRANTS can grow after this tenant was first seeded (CL-6465
    // added eval-run:*/read well after some tenants were provisioned) —
    // reconcile it on every sign-in so a grant added later still reaches
    // an already-seeded tenant, not only a brand-new one. Cheap and
    // idempotent (`reconcileSeedGrants` skips any grant that already
    // exists), and runs regardless of `fullySeeded` below, which tracks
    // workflow deployments only and must never gate grant reconciliation.
    // A failure here must never block sign-in for an otherwise healthy
    // tenant, so it is reported rather than thrown.
    try {
      await reconcileSeedGrants(
        args.api,
        args.cookies,
        own.tenantId,
        own.principalId,
        args.log,
      );
    } catch (cause) {
      reportError(cause, {
        operation: "reconcile_seed_grants",
        tenantId: own.tenantId,
      });
    }

    const tenantResponse = await args.api(
      "GET",
      `/api/tenants/${own.tenantId}`,
      undefined,
      args.cookies,
    );
    const ownTenant = parseAs(
      TenantResponse,
      tenantResponse.data,
      "tenant response",
    );
    const fullySeeded = await isFullySeeded(
      args.api,
      args.cookies,
      own.tenantId,
    );
    if (fullySeeded)
      return { kind: "existing-member", seeded: true, tenantId: own.tenantId };

    // Own bench exists but is not fully seeded. With a hub-owned seed
    // model we can re-seed right here to recover. Without one there is
    // nothing this hook can do — completing seeding from the caller's
    // own credential is `completeCredentialSetup`'s job (the onboarding
    // credential step), not this sign-in hook's — so we exit as an
    // existing-member with `seeded: false`, the typed `bench_unseeded`
    // condition the onboarding UI reads to keep the credential step open
    // rather than declaring setup finished.
    if (args.seedModel === undefined) {
      args.log(
        `personal bench ${own.tenantId} exists but is not fully seeded, and no seed model is configured; returning as existing-member without re-seeding`,
      );
      return { kind: "existing-member", seeded: false, tenantId: own.tenantId };
    }

    const existingMemberSeedArgs = {
      api: args.api,
      cookies: args.cookies,
      hubUrl: args.hubUrl,
      tenant: {
        tenantId: own.tenantId,
        principalId: own.principalId,
        domain: ownTenant.domain,
      },
      model: args.seedModel,
      pushWorkflow: args.pushWorkflow,
      log: args.log,
      workflows: DEFAULT_WORKFLOWS,
    };
    await seedTenant(existingMemberSeedArgs);
    return { kind: "existing-member", seeded: true, tenantId: own.tenantId };
  }

  // No membership yet. Before any signup decision, check whether this
  // email was already pre-vetted through a pending invite (an admin
  // invited an email — or a whole domain — that had no user row yet at
  // invite time). A match joins the invited tenant directly; the
  // closed-by-default signup gate below never runs for it. This check
  // runs on every call, including the bare membership probe, because
  // resolving an invite is itself the first-login decision, not
  // something that waits on the naming step.
  if (args.accessPolicy !== undefined) {
    const resolved = await resolvePendingInviteOnLogin({
      store: args.accessPolicy.store,
      api: args.api,
      cookies: args.cookies,
      email: args.userEmail,
      emailVerified: args.userEmailVerified,
      allowUnverifiedEmails: args.accessPolicy.allowUnverifiedEmails,
    });
    if (resolved !== undefined) return { kind: "existing-member" };
  }

  // Creation requires an explicit display name from the onboarding
  // naming step — a shell membership probe (no name) must not silently
  // mint a personal bench.
  if (args.displayName === undefined || args.displayName.trim().length === 0) {
    return { kind: "needs-onboarding" };
  }

  if (args.accessPolicy !== undefined) {
    const signupGateArgs = {
      store: args.accessPolicy.store,
      envSignupMode: args.accessPolicy.envSignupMode,
      envAllowedDomains: args.accessPolicy.envAllowedDomains,
      email: args.userEmail,
      emailVerified: args.userEmailVerified,
      allowUnverifiedEmails: args.accessPolicy.allowUnverifiedEmails,
    };
    const gate = await checkSignupGate(
      args.operatorTenantId !== undefined
        ? { ...signupGateArgs, operatorTenantId: args.operatorTenantId }
        : signupGateArgs,
    );
    if (!gate.allowed) {
      throw new ProvisionError(
        "signup_not_allowed",
        `self-serve signup is not allowed for ${args.userEmail} (${gate.reason})`,
        "permanent",
      );
    }
  }

  const tenantCreateBody: { name: string; slug: string; parentId?: string } = {
    name: args.displayName.trim(),
    slug: expectedSlug,
  };
  if (args.operatorTenantId !== undefined)
    tenantCreateBody.parentId = args.operatorTenantId;

  const created = await args.api(
    "POST",
    "/api/tenants",
    tenantCreateBody,
    args.cookies,
  );
  if (created.status === 409) {
    // Lost a race: another concurrent first-login call for this same
    // user already created the (deterministically-slugged) personal
    // bench between our own "zero principals" read and this create. The
    // loser recognizes "someone already provisioned me" rather than
    // surfacing the native route's slug conflict as a failure.
    const afterRace = await fetchPrincipals(args.api, args.cookies);
    if (afterRace.length > 0) return { kind: "existing-member" };
    throw new ProvisionError(
      "slug_conflict_no_principal",
      `first-login provisioning hit a slug conflict creating a personal bench, but the caller still has no principal anywhere: ${JSON.stringify(created.data)}`,
      "permanent",
    );
  }
  if (created.status !== 201) {
    throw new ProvisionError(
      "tenant_create_failed",
      `first-login provisioning could not create a personal bench (status ${created.status}): ${JSON.stringify(created.data)}`,
      created.status >= 500 ? "transient" : "permanent",
    );
  }
  const tenant = parseAs(TenantResponse, created.data, "tenant response");

  const after = await fetchPrincipals(args.api, args.cookies);
  const membership = after.find((p) => p.tenantId === tenant.id);
  if (membership === undefined) {
    throw new ProvisionError(
      "tenant_created_no_membership",
      `personal bench ${tenant.id} was created but the caller has no principal in it`,
      "transient",
    );
  }

  if (!args.seedModel) {
    const seedSkipReason =
      "no hub-owned seed model credential is configured (ANTHROPIC_API_KEY); the bench was provisioned without the default workflow set";
    args.log(`bench ${tenant.slug}: ${seedSkipReason}`);
    return {
      kind: "provisioned",
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      seeded: false,
      seedSkipReason,
    };
  }

  const provisionedSeedArgs = {
    api: args.api,
    cookies: args.cookies,
    hubUrl: args.hubUrl,
    tenant: {
      tenantId: tenant.id,
      principalId: membership.principalId,
      domain: tenant.domain,
    },
    model: args.seedModel,
    pushWorkflow: args.pushWorkflow,
    log: args.log,
    workflows: DEFAULT_WORKFLOWS,
  };
  await seedTenant(provisionedSeedArgs);

  return {
    kind: "provisioned",
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    seeded: true,
  };
}
