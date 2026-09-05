// The source form a catalog workflow deploys as when someone asks for it
// on demand — the instantiate path's block-workflow resolution
// (CL-6405) generalized to any catalog entry with a source package
// under `workflows/<name>` (CL-7073), not just `code-review`.
// `@corbits/seeding`'s `CATALOG_WORKFLOWS` is the one source of truth
// for which asset names are deployable this way and how to build each
// one's definition JSON — the exact same list and `buildJson` the CLI's
// `workbench seed` / the first-login provisioning hook would use to
// deploy the same asset via its own HTTP self-call path. This module
// only adapts that shared build step to the tenant's real, ordered
// inference preferences and to the source-form deploy this route uses
// (see `./template-block-routes.ts` and the hub's `deployWorkflowSource`
// binding).
//
// Server-only, on purpose: building a catalog workflow's definition
// pulls in its workflow package (e.g. `@corbits/granola-call-workflow`)
// and with it `@intx/agent`/`@intx/workflow` — the heavy graph
// `./templates.ts` keeps every manifest consumer off. Only
// `./template-block-routes.ts` (mounted in `apps/hub`) imports this; it
// is deliberately not re-exported from the package root.

import { deployableCatalogWorkflow } from "@corbits/seeding";
import { workflowCatalogEntry } from "@workbench/templates";

export interface BlockWorkflowBuildInput {
  readonly tenantDomain: string;
  readonly inferencePreferences: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
}

export interface BlockWorkflowSource {
  readonly assetName: string;
  readonly displayName: string;
  readonly workflowJson: string;
}

/**
 * The serialized source-form definition for one catalog workflow, or
 * `undefined` for an asset name with no declared source package —
 * `assistant` (seeded, never redeployed here) and `heartbeat`
 * (test-only, never deployed onto a real bench) both answer `undefined`,
 * same as any name outside the catalog entirely. A route answering
 * `undefined` as a 404 is the honest statement of that gap.
 */
export function buildBlockWorkflowSource(
  assetName: string,
  input: BlockWorkflowBuildInput,
): BlockWorkflowSource | undefined {
  const entry = deployableCatalogWorkflow(assetName);
  if (entry === undefined) return undefined;
  return {
    assetName,
    displayName: workflowCatalogEntry(assetName)?.displayName ?? assetName,
    workflowJson: entry.buildJson(
      input.tenantDomain,
      input.inferencePreferences,
    ),
  };
}
