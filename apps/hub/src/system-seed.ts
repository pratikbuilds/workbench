// CL-7382: seeds the root tenant's default workflow set and catalog at
// hub boot — the boot-time replacement for `workbench seed`. Runs
// against the hub's real, already-listening origin (`config.baseUrl`),
// not an in-process `fetch` entry point the way `env-credential-plant.ts`
// runs: `seedTenant`'s workflow push shells out a real `git push` over
// HTTP, so it needs a reachable origin to exist, not just a composed
// app object.
//
// The deploy step needs a connected sidecar; until one dials in, every
// deploy answers 502 and `seedTenant` throws (see
// `scripts/e2e/local-rip.test.ts`'s own `deploySeededWorkflows` retry
// loop, which this mirrors). Boot itself must never block on that or
// fail over it — `bun run dev` starts the hub and sidecar together, but
// they race, and a production boot may reasonably outlive its sidecar's
// own startup. So this polls with a bounded deadline and gives up
// quietly, logged once: every step here is ensure-then-create and every
// workflow push is content-addressed and skips an unchanged tree, so
// the very next boot picks up exactly where this one left off.

import { reportError } from "@corbits/error-sink";
import { getLogger } from "@intx/log";
import {
  seedTenant,
  seedCatalog,
  createGitWorkflowPusher,
  publishCorbitsToolsRegistry,
  DEFAULT_WORKFLOWS,
  PLACEHOLDER_CATALOG_API_KEY,
  type ModelSource,
} from "@corbits/seeding";
import { createHubAPI, signIn, type ApiCall } from "@corbits/hub-api-client";
import { findPersonalTenant } from "@workbench/onboarding";

const log = getLogger(["hub", "system-seed"]);

const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

// Matches `workbench seed`'s own default model source (readSeedConfig in
// the now-deleted `packages/cli/src/config.ts`): real anthropic/
// claude-sonnet-5 when a hub-owned key is configured (`config.seedModel`),
// a placeholder key otherwise so the default workflow set still deploys
// and the catalog is still browsable, just not launchable.
const SEED_MODEL_PROVIDER = "anthropic";
const SEED_MODEL = "claude-sonnet-5";
const SEED_MODEL_BASE_URL = "https://api.anthropic.com";

function resolvedModel(seedModel: ModelSource | undefined): ModelSource {
  return (
    seedModel ?? {
      provider: SEED_MODEL_PROVIDER,
      model: SEED_MODEL,
      baseURL: SEED_MODEL_BASE_URL,
      apiKey: PLACEHOLDER_CATALOG_API_KEY,
    }
  );
}

export type SystemSeedDeps = {
  baseUrl: string;
  orgSlug: string;
  admin: { email: string; password: string };
  seedModel?: ModelSource;
  deadlineMs?: number;
  pollIntervalMs?: number;
};

/**
 * Seeds the root tenant once: the default workflow set, then the tenant
 * catalog (a real credential when a hub-owned seed model is configured, a
 * placeholder one otherwise). Never throws — a failure that persists past
 * the deadline is logged and left for the next boot to retry, the same
 * "safe to re-run" property `workbench seed` always had.
 */
export async function runSystemSeed(deps: SystemSeedDeps): Promise<void> {
  const api: ApiCall = createHubAPI(deps.baseUrl);
  const model = resolvedModel(deps.seedModel);
  const deadline = Date.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pushWorkflow = createGitWorkflowPusher();

  let lastLoggedReason: string | undefined;
  for (;;) {
    try {
      const session = await signIn(api, deps.admin);
      const tenant = await findPersonalTenant(
        api,
        session.cookies,
        deps.orgSlug,
      );
      if (tenant === undefined) {
        throw new Error(
          `root bench "${deps.orgSlug}" is not visible to ${deps.admin.email} yet`,
        );
      }

      // `workbench setup` used to publish `corbits-tools` onto the root
      // explicitly, before `workbench seed` ran. Every descendant tenant
      // inherits the registry from its parent, so this is the one place
      // it needs publishing — packing is content-addressed and skips an
      // already-present filename, so a re-publish on every boot is cheap.
      await publishCorbitsToolsRegistry({
        api,
        cookies: session.cookies,
        hubUrl: deps.baseUrl,
        tenantId: tenant.tenantId,
        log: (line) => log.info`${line}`,
      });

      await seedTenant({
        api,
        cookies: session.cookies,
        hubUrl: deps.baseUrl,
        tenant: {
          tenantId: tenant.tenantId,
          principalId: tenant.principalId,
          domain: tenant.tenantDomain,
        },
        model,
        pushWorkflow,
        log: (line) => log.info`${line}`,
        workflows: DEFAULT_WORKFLOWS,
      });

      await seedCatalog({
        api,
        cookies: session.cookies,
        tenantId: tenant.tenantId,
        log: (line) => log.info`${line}`,
        ...(deps.seedModel !== undefined
          ? { apiKey: deps.seedModel.apiKey }
          : { placeholderCredential: true }),
      });

      log.info`root tenant seed complete`;
      return;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (Date.now() >= deadline) {
        reportError(cause, { operation: "system-seed.seedRootTenant" });
        log.error`root tenant seed did not complete before its deadline (last error: ${reason}); the next boot will retry`;
        return;
      }
      if (reason !== lastLoggedReason) {
        log.info`root tenant seed not ready yet (${reason}); retrying`;
        lastLoggedReason = reason;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
