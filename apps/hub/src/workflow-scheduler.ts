// A minimal periodic loop that ticks native ScheduleTrigger cadences on
// authored, deployed workflow definitions. The hashed cron lives on the
// frozen inert projection, and launch goes through
// `triggerNativeWorkflowRoutineRun`.
//
// Exactly-once against a concurrent claim: `claimScheduleMinute` is a
// conditional update on `workflow_definition.schedule_claimed_minute`
// (`IS DISTINCT FROM` the UTC minuteKey being claimed). A 30s poll matches
// twice per minute per process, and again per replica; the CAS loser skips
// launch. Missed minutes are not caught up (skip-missed): only the current
// wall-clock minute can match. A launch that throws is logged and the
// column is left claimed, so the next matching minute retries.
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@intx/db";
import {
  tenant as tenantTable,
  workflowDefinition,
  workflowDefinitionVersion,
} from "@intx/db/schema";
import { handleFromName, type JoinRunParticipantInput } from "@corbits/chat";
import { reportError } from "@corbits/error-sink";
import {
  cronMatchesMinute,
  minuteKey,
  scheduleCronFromProjection,
} from "@corbits/workflows";

import { triggerNativeWorkflowRoutineRun } from "./native-workflow-routine-launch";
import type { NativeWorkflowRoutineTriggerDeps } from "./native-workflow-routine-launch";

export type ScheduledDefinition = {
  definitionId: string;
  tenantId: string;
  creatorPrincipalId: string | null;
  definitionAssetId: string;
  name: string;
  cron: string;
};

export type ScheduledDeliveryJoinDeps = {
  deliveryWorkbenchRequired?: (name: string) => boolean | Promise<boolean>;
  resolveDeliveryWorkbench?: (tenantId: string) => Promise<string | undefined>;
  joinDeliveryWorkbench?: (input: JoinRunParticipantInput) => Promise<void>;
};

/**
 * After a scheduled tick launches, join the run to a workbench when the
 * catalog says this workflow delivers there. No workbench → still launched
 * (join omitted). Inbox-mode workflows skip the join. A join throw is the
 * caller's to log; this helper rethrows.
 */
export async function joinScheduledDefinitionToWorkbench(
  deps: ScheduledDeliveryJoinDeps,
  def: ScheduledDefinition,
  address: string,
): Promise<void> {
  if (def.creatorPrincipalId === null) return;
  if (
    deps.deliveryWorkbenchRequired !== undefined &&
    (await deps.deliveryWorkbenchRequired(def.name)) !== true
  ) {
    return;
  }
  if (
    deps.resolveDeliveryWorkbench === undefined ||
    deps.joinDeliveryWorkbench === undefined
  ) {
    return;
  }
  const workbenchId = await deps.resolveDeliveryWorkbench(def.tenantId);
  if (workbenchId === undefined) return;
  await deps.joinDeliveryWorkbench({
    tenantId: def.tenantId,
    workbenchId,
    principalId: def.creatorPrincipalId,
    address,
    handle: handleFromName(def.name, address),
  });
}

export type WorkflowSchedulerDeps = {
  listScheduledDefinitions: () => Promise<readonly ScheduledDefinition[]>;
  claimScheduleMinute: (
    definitionId: string,
    minute: string,
  ) => Promise<boolean>;
  launch: (def: ScheduledDefinition) => Promise<void>;
  now?: () => Date;
  pollIntervalMs?: number;
};

export const DEFAULT_WORKFLOW_SCHEDULER_POLL_INTERVAL_MS = 30_000;

/**
 * One poll: claim and launch every scheduled definition due at `at`.
 * Exported so a test can drive a single, deterministic poll against an
 * injected clock without waiting on `setInterval`.
 */
export async function tickWorkflowScheduler(
  deps: Pick<
    WorkflowSchedulerDeps,
    "listScheduledDefinitions" | "claimScheduleMinute" | "launch"
  >,
  at: Date,
): Promise<void> {
  const listed = await deps.listScheduledDefinitions();
  const minute = String(minuteKey(at));
  for (const def of listed) {
    try {
      if (!cronMatchesMinute(def.cron, at)) continue;
      if (def.creatorPrincipalId === null) continue;
      const claimed = await deps.claimScheduleMinute(def.definitionId, minute);
      if (!claimed) continue;
      try {
        await deps.launch(def);
      } catch (error) {
        reportError(error, {
          operation: "workflow-scheduler.launch",
          tenantId: def.tenantId,
          extra: { definitionId: def.definitionId },
        });
      }
    } catch (error) {
      reportError(error, {
        operation: "workflow-scheduler.tick-definition",
        tenantId: def.tenantId,
        extra: { definitionId: def.definitionId },
      });
    }
  }
}

export function createWorkflowScheduler(deps: WorkflowSchedulerDeps) {
  const now = deps.now ?? (() => new Date());
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tickWorkflowScheduler(deps, now());
    } catch (error) {
      reportError(error, { operation: "workflow-scheduler.tick" });
    } finally {
      tickInFlight = false;
    }
  }

  const interval = setInterval(
    () => void tick(),
    deps.pollIntervalMs ?? DEFAULT_WORKFLOW_SCHEDULER_POLL_INTERVAL_MS,
  );
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}

export function claimScheduleMinuteFromDb(
  db: DB["db"],
): WorkflowSchedulerDeps["claimScheduleMinute"] {
  return async (definitionId, minute) => {
    const updated = await db
      .update(workflowDefinition)
      .set({ scheduleClaimedMinute: minute })
      .where(
        and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.status, "deployed"),
          sql`${workflowDefinition.scheduleClaimedMinute} is distinct from ${minute}`,
        ),
      )
      .returning({ id: workflowDefinition.id });
    return updated.length > 0;
  };
}

export function listScheduledDefinitionsFromDb(
  db: DB["db"],
): WorkflowSchedulerDeps["listScheduledDefinitions"] {
  return async () => {
    const rows = await db
      .select({
        definitionId: workflowDefinition.id,
        tenantId: workflowDefinition.tenantId,
        creatorPrincipalId: workflowDefinition.creatorPrincipalId,
        definitionAssetId: workflowDefinition.assetId,
        name: workflowDefinition.name,
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
          eq(workflowDefinition.origin, "authored"),
          eq(workflowDefinition.status, "deployed"),
        ),
      );

    const scheduled: ScheduledDefinition[] = [];
    for (const row of rows) {
      if (row.definitionAssetId === null) continue;
      const cron = scheduleCronFromProjection(row.wireProjection);
      if (cron === undefined) continue;
      scheduled.push({
        definitionId: row.definitionId,
        tenantId: row.tenantId,
        creatorPrincipalId: row.creatorPrincipalId,
        definitionAssetId: row.definitionAssetId,
        name: row.name,
        cron,
      });
    }
    return scheduled;
  };
}

const SCHEDULE_TICK_CONTENT = "Scheduled tick.";

export function launchScheduledDefinitionFromDb(
  deps: NativeWorkflowRoutineTriggerDeps & ScheduledDeliveryJoinDeps,
): WorkflowSchedulerDeps["launch"] {
  return async (def) => {
    if (def.creatorPrincipalId === null) return;
    const [tenant] = await deps.db
      .select({ domain: tenantTable.domain })
      .from(tenantTable)
      .where(eq(tenantTable.id, def.tenantId))
      .limit(1);
    if (tenant === undefined) {
      throw new Error(`no tenant "${def.tenantId}"`);
    }
    const triggered = await triggerNativeWorkflowRoutineRun(deps, {
      tenantId: def.tenantId,
      definitionId: def.definitionId,
      principalId: def.creatorPrincipalId,
      fromDomain: tenant.domain,
      content: SCHEDULE_TICK_CONTENT,
    });
    try {
      await joinScheduledDefinitionToWorkbench(deps, def, triggered.address);
    } catch (error) {
      reportError(error, {
        operation: "workflow-scheduler.join-workbench",
        tenantId: def.tenantId,
        extra: {
          definitionId: def.definitionId,
          address: triggered.address,
        },
      });
    }
  };
}

export type RunNowScheduledDefinitionArgs = {
  tenantId: string;
  definitionId: string;
  principalId: string;
  fromDomain: string;
  content: string;
  name: string;
  definitionAssetId: string;
};

/**
 * Fire a scheduled definition now, then join the run to a workbench the
 * same way the poller does. Join failures are reported and do not fail
 * the launch — the caller still gets `{ runId }`.
 */
export async function runNowScheduledDefinition(
  deps: NativeWorkflowRoutineTriggerDeps & ScheduledDeliveryJoinDeps,
  args: RunNowScheduledDefinitionArgs,
): Promise<{ runId: string }> {
  const triggered = await triggerNativeWorkflowRoutineRun(deps, {
    tenantId: args.tenantId,
    definitionId: args.definitionId,
    principalId: args.principalId,
    fromDomain: args.fromDomain,
    content: args.content,
  });
  try {
    await joinScheduledDefinitionToWorkbench(
      deps,
      {
        definitionId: args.definitionId,
        tenantId: args.tenantId,
        creatorPrincipalId: args.principalId,
        definitionAssetId: args.definitionAssetId,
        name: args.name,
        cron: "",
      },
      triggered.address,
    );
  } catch (error) {
    reportError(error, {
      operation: "scheduled-workflow.run-now.join-workbench",
      tenantId: args.tenantId,
      extra: {
        definitionId: args.definitionId,
        address: triggered.address,
      },
    });
  }
  return { runId: triggered.runId };
}
