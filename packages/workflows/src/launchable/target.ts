// The one place a launch target (a workflow asset id) becomes the
// definition that actually runs. Interchange keys `workflow_definition`
// on `(asset_id, wire_hash)` and has no "newest approved deployment of
// this asset" indirection of its own (docs/workflow-model.md), so this
// module supplies exactly that query — and nothing else: no search by
// name, no fallback to an unfrozen row, no pinning. Every caller
// (create, retarget, launch, and the target list) resolves through here
// so a fire can never run, or offer, a definition this rule would not
// have picked.
//
// "What is launchable" is definition-domain logic in `@corbits/workflows`.
// The pure follow-latest rule lives in
// `./target-rule.ts` (no `drizzle-orm`/`@intx/db`, so it is safe on
// `@corbits/workflows/client`); this file is the DB-touching half, and
// both `resolveLaunchableDefinition` and `listLaunchableDefinitions`
// below share the one row query and the one `pickLaunchableDefinition`
// reduction.
import { and, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { workflowDefinition, workflowDefinitionVersion } from "@intx/db/schema";

import { pickLaunchableDefinition } from "./target-rule";
import type {
  LaunchableDefinitionCandidate,
  LaunchableDefinitionResolution,
} from "./target-rule";

export * from "./target-rule";

type LaunchableDb = PostgresJsDatabase<Record<string, unknown>>;

type LaunchableRow = LaunchableDefinitionCandidate & {
  readonly definitionAssetId: string | null;
  readonly name: string;
  readonly description: string | null;
};

/** The newest launchable definition per source asset in a tenant: an
 * `authored` row with `status = 'deployed'` whose current version row is
 * frozen. The row shape `listLaunchableDefinitions` (below) returns once
 * `pickLaunchableDefinition` has picked the winner per asset. */
export type LaunchableDefinition = {
  readonly definitionId: string;
  readonly definitionAssetId: string;
  readonly name: string;
  readonly description: string | null;
  readonly wireHash: string;
  readonly wireProjection: unknown;
};

/** Every `authored` `workflow_definition` row in a tenant with an asset
 * id, joined to its current version's freeze columns — unfiltered by
 * status or freeze state, so a caller can tell "no such asset" apart
 * from "not deployed" apart from "not yet frozen" via
 * `pickLaunchableDefinition`'s rejection reasons. The one query both
 * `resolveLaunchableDefinition` and `listLaunchableDefinitions` reduce
 * through `pickLaunchableDefinition` to reach the same rule.
 */
async function fetchLaunchableRows(
  db: LaunchableDb,
  extraWhere: ReturnType<typeof eq>,
): Promise<readonly LaunchableRow[]> {
  const rows = await db
    .select({
      id: workflowDefinition.id,
      tenantId: workflowDefinition.tenantId,
      status: workflowDefinition.status,
      createdAt: workflowDefinition.createdAt,
      definitionAssetId: workflowDefinition.assetId,
      name: workflowDefinition.name,
      description: workflowDefinition.description,
      approvedWireHash: workflowDefinitionVersion.approvedWireHash,
      grantSnapshot: workflowDefinitionVersion.grantSnapshot,
      wireProjection: workflowDefinitionVersion.wireProjection,
    })
    .from(workflowDefinition)
    .leftJoin(
      workflowDefinitionVersion,
      and(
        eq(workflowDefinitionVersion.definitionId, workflowDefinition.id),
        eq(
          workflowDefinitionVersion.version,
          workflowDefinition.currentVersion,
        ),
      ),
    )
    .where(and(eq(workflowDefinition.origin, "authored"), extraWhere))
    .orderBy(desc(workflowDefinition.createdAt));
  return rows.map((row) => ({
    ...row,
    approvedWireHash: row.approvedWireHash ?? null,
    grantSnapshot: row.grantSnapshot ?? null,
    wireProjection: row.wireProjection ?? null,
  }));
}

/**
 * Resolves the definition a routine targeting `definitionAssetId` would
 * run right now, per `pickLaunchableDefinition`. One query, read at the
 * moment of use — a create/retarget validates through it, and a launch
 * re-resolves through it rather than trusting anything stored.
 */
export async function resolveLaunchableDefinition(input: {
  db: LaunchableDb;
  tenantId: string;
  definitionAssetId: string;
}): Promise<LaunchableDefinitionResolution> {
  const rows = await fetchLaunchableRows(
    input.db,
    eq(workflowDefinition.assetId, input.definitionAssetId),
  );
  return pickLaunchableDefinition(rows, input.tenantId);
}

/**
 * The newest launchable definition per source asset in a tenant, per
 * `pickLaunchableDefinition` — callers (the web picker, schedule list)
 * reduce further by catalog/authorization; not authorized itself, so
 * callers gate what leaves.
 */
export async function listLaunchableDefinitions(
  db: LaunchableDb,
  tenantId: string,
): Promise<readonly LaunchableDefinition[]> {
  const rows = await fetchLaunchableRows(
    db,
    eq(workflowDefinition.tenantId, tenantId),
  );
  const byAsset = new Map<string, LaunchableRow[]>();
  for (const row of rows) {
    if (row.definitionAssetId === null) continue;
    const bucket = byAsset.get(row.definitionAssetId);
    if (bucket === undefined) {
      byAsset.set(row.definitionAssetId, [row]);
    } else {
      bucket.push(row);
    }
  }
  const result: LaunchableDefinition[] = [];
  for (const [definitionAssetId, candidates] of byAsset) {
    const picked = pickLaunchableDefinition(candidates, tenantId);
    if (!picked.ok) continue;
    const winner = candidates.find((row) => row.id === picked.definitionId);
    if (winner === undefined) continue;
    result.push({
      definitionId: picked.definitionId,
      definitionAssetId,
      name: winner.name,
      description: winner.description,
      wireHash: picked.wireHash,
      wireProjection: winner.wireProjection,
    });
  }
  return result;
}
