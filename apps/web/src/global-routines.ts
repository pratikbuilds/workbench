// Scheduled workflow definitions across every bench the signed-in account
// belongs to — the aggregation both Routines surfaces read from: the
// roster at `/routines` and the detail page at `/routines/<definitionId>`.
import {
  classifyBenchMembership,
  listWorkbenchTenantIds,
} from "@corbits/bench-ui";
import { toast } from "@corbits/react-ui";
import { reportError } from "@corbits/error-sink";
import { useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@corbits/api-query";
import type { APIQuery } from "@corbits/api-query";

import type { Principal } from "./api";
import { useBench } from "./bench-context";
import { ROUTINES_PATH_PREFIX } from "./path-ids";
import { meKeys, tenantKeys } from "./query-client";
import {
  listScheduledWorkflows,
  runScheduledWorkflowNow,
  setScheduledWorkflowStatus,
} from "./routines-api";
import type { ScheduledWorkflowDefinition } from "./routines-api";

const ROUTINES_QUERY_SCOPE = "global-page";

export type GlobalRoutineRow = {
  readonly definition: ScheduledWorkflowDefinition;
  readonly tenantId: string;
  readonly tenantName: string;
};

export function routineDetailPath(definitionId: string): string {
  return `${ROUTINES_PATH_PREFIX}/${encodeURIComponent(definitionId)}`;
}

function useMemberBenches(): {
  readonly kind: "loading" | "ready";
  readonly benches: readonly { tenantId: string; tenantName: string }[];
} {
  const { memberships } = useBench();
  const allMemberships: readonly Principal[] =
    memberships.kind === "ready" ? memberships.data.data : [];
  const tenantIds = useMemo(
    () => allMemberships.map((m) => m.tenantId),
    [allMemberships],
  );
  const workbenchTenancyKinds = useQuery({
    queryKey: meKeys.workbenchTenancyKinds(tenantIds),
    queryFn: () => listWorkbenchTenantIds(tenantIds),
    enabled: tenantIds.length > 0,
  });
  const benches = useMemo(
    () =>
      allMemberships
        .filter(
          (m) =>
            classifyBenchMembership(
              m,
              workbenchTenancyKinds.data ?? new Set(),
            ) === "bench",
        )
        .map((m) => ({ tenantId: m.tenantId, tenantName: m.tenantName })),
    [allMemberships, workbenchTenancyKinds.data],
  );
  if (memberships.kind !== "ready") return { kind: "loading", benches: [] };
  return { kind: "ready", benches };
}

export function useGlobalRoutines(): APIQuery<readonly GlobalRoutineRow[]> {
  const { kind: benchesKind, benches } = useMemberBenches();
  const results = useQueries({
    queries: benches.map((bench) => ({
      queryKey: [...tenantKeys.routines(bench.tenantId), ROUTINES_QUERY_SCOPE],
      queryFn: () => listScheduledWorkflows(bench.tenantId),
    })),
  });

  if (benchesKind === "loading") return { kind: "loading" };
  if (results.some((r) => r.isLoading)) return { kind: "loading" };
  const failed = results.find((r) => r.isError);
  if (failed !== undefined) {
    return {
      kind: "error",
      message:
        failed.error instanceof Error
          ? failed.error.message
          : "Couldn't load routines.",
      retry: () => {
        for (const result of results) void result.refetch();
      },
    };
  }

  const rows: GlobalRoutineRow[] = [];
  benches.forEach((bench, index) => {
    const items = results[index]?.data;
    if (items === undefined) return;
    for (const definition of items) {
      rows.push({
        definition,
        tenantId: bench.tenantId,
        tenantName: bench.tenantName,
      });
    }
  });
  return { kind: "ready", data: rows };
}

export function useInvalidateRoutines(): (tenantId: string) => void {
  const queryClient = useQueryClient();
  return (tenantId: string) => {
    void queryClient.invalidateQueries({
      queryKey: [...tenantKeys.routines(tenantId), ROUTINES_QUERY_SCOPE],
    });
  };
}

export type RoutineActions = {
  readonly runNow: (row: GlobalRoutineRow) => Promise<void>;
  readonly setEnabled: (
    row: GlobalRoutineRow,
    enabled: boolean,
  ) => Promise<void>;
};

export function useRoutineActions(): RoutineActions {
  const invalidate = useInvalidateRoutines();
  return {
    runNow: async (row) => {
      try {
        await runScheduledWorkflowNow(
          row.tenantId,
          row.definition.definitionId,
        );
        invalidate(row.tenantId);
        toast(`${row.definition.name} started`);
      } catch (cause) {
        reportError(cause, {
          operation: "scheduled_workflow_run_now",
          tenantId: row.tenantId,
        });
        toast(
          `Couldn't start ${row.definition.name}: ${describeApiError(cause, "starting this routine")}`,
        );
      }
    },
    setEnabled: async (row, enabled) => {
      try {
        await setScheduledWorkflowStatus(
          row.tenantId,
          row.definition.definitionId,
          enabled ? "deployed" : "stopped",
        );
        invalidate(row.tenantId);
      } catch (cause) {
        reportError(cause, {
          operation: "scheduled_workflow_set_status",
          tenantId: row.tenantId,
        });
        toast(
          `Couldn't ${enabled ? "resume" : "pause"} ${row.definition.name}: ${describeApiError(
            cause,
            enabled ? "resuming this routine" : "pausing this routine",
          )}`,
        );
      }
    },
  };
}
