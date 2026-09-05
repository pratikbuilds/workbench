// Authored workflow definitions whose frozen projection carries a
// ScheduleTrigger, of any status — the Routines page's list. The hub
// poller uses a deployed-only sibling (`listScheduledDefinitionsFromDb`);
// this helper is the ops table, so a paused (`stopped`) digest still
// appears.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowDefinition, workflowDefinitionVersion } from "@intx/db/schema";

import { scheduleCronFromProjection } from "./from-projection";

export type ScheduledWorkflowDefinition = {
  definitionId: string;
  assetId: string;
  name: string;
  tenantId: string;
  status: "deployed" | "stopped";
  cron: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ScheduledWorkflowDefinitionRow = {
  definitionId: string;
  tenantId: string;
  assetId: string | null;
  name: string;
  status: "deployed" | "stopped";
  createdAt: Date;
  updatedAt: Date;
  wireProjection: unknown;
};

/**
 * Keep authored rows whose frozen projection has a valid ScheduleTrigger
 * cron, including `stopped`. Exported so a test can prove the page list
 * includes paused schedules without a live Postgres.
 */
export function scheduledDefinitionsFromRows(
  rows: readonly ScheduledWorkflowDefinitionRow[],
): ScheduledWorkflowDefinition[] {
  const scheduled: ScheduledWorkflowDefinition[] = [];
  for (const row of rows) {
    if (row.assetId === null) continue;
    const cron = scheduleCronFromProjection(row.wireProjection);
    if (cron === undefined) continue;
    scheduled.push({
      definitionId: row.definitionId,
      assetId: row.assetId,
      name: row.name,
      tenantId: row.tenantId,
      status: row.status,
      cron,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
  return scheduled;
}

export async function listScheduledWorkflowDefinitions(
  db: DB["db"],
  tenantId: string,
): Promise<readonly ScheduledWorkflowDefinition[]> {
  const rows = await db
    .select({
      definitionId: workflowDefinition.id,
      tenantId: workflowDefinition.tenantId,
      assetId: workflowDefinition.assetId,
      name: workflowDefinition.name,
      status: workflowDefinition.status,
      createdAt: workflowDefinition.createdAt,
      updatedAt: workflowDefinition.updatedAt,
      wireProjection: workflowDefinitionVersion.wireProjection,
    })
    .from(workflowDefinition)
    .innerJoin(
      workflowDefinitionVersion,
      and(
        eq(workflowDefinitionVersion.definitionId, workflowDefinition.id),
        eq(
          workflowDefinitionVersion.version,
          workflowDefinition.currentVersion,
        ),
      ),
    )
    .where(
      and(
        eq(workflowDefinition.tenantId, tenantId),
        eq(workflowDefinition.origin, "authored"),
      ),
    );

  return scheduledDefinitionsFromRows(rows);
}
