// Pure Insights rollups over data the web already has (workflow runs +
// routines). No new analytics backend — I1 is an honest live surface on
// existing endpoints.

import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";
import {
  runOutcomeStatus,
  withListingAbandoned,
} from "@corbits/workflows/client";

import type { InsightsRun, RunTraceSpan } from "./insights-api";
import type { ScheduledWorkflowDefinition } from "./routines-api";

export type TraceStats = {
  readonly steps: number;
  readonly completed: number;
  readonly failed: number;
  readonly durationMs: number;
};

/**
 * Run-detail stat strip (steps/completed/failed/duration) is derived from
 * the trace's own spans — never fabricated when the trace is absent or
 * empty. Returns null when there is nothing to derive from.
 */
export function computeTraceStats(
  spans: readonly RunTraceSpan[] | null,
): TraceStats | null {
  if (spans === null || spans.length === 0) return null;
  let completed = 0;
  let failed = 0;
  for (const span of spans) {
    if (span.phase === "ok") completed += 1;
    if (span.phase === "failed") failed += 1;
  }
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  return {
    steps: spans.length,
    completed,
    failed,
    durationMs: Math.max(0, end - start),
  };
}

export type InsightsStats = {
  readonly totalRuns: number;
  readonly running: number;
  readonly errored: number;
  readonly stopped: number;
  readonly deployed: number;
  readonly routineCount: number;
  readonly enabledRoutines: number;
  readonly recentRuns: readonly InsightsRun[];
};

/** Cap recent-run table rows so the page stays scannable. */
export const INSIGHTS_RECENT_LIMIT = 12;

/**
 * Purpose runs only — drop workbench-host anchors the same way Home does.
 * `insights-page.tsx` sources `runs` from `insightsTopLevelRunsPath` (see
 * `./insights-api.ts`), which already excludes every folded run with no
 * routine parent, and the resident never-fired deployment placeholder,
 * server-side via `@corbits/folded-runs`'s `scope-routes.ts`'s
 * `listTopLevelRunFires`. This filter is a client-side belt-and-suspenders
 * pass against the workbench-host naming pattern alone, not a second scoping
 * layer — a caller no longer needs to (and cannot) hand this a folded-run
 * id set. CL-6062 replaced the dead `/me/workflows/runs` feed (its
 * `anchorRunId IS NULL` filter never matched anything, since every
 * addressed run self-anchors at creation) with this scoped one.
 */
export function purposeRunsForInsights(
  runs: readonly InsightsRun[],
): readonly InsightsRun[] {
  return runs.filter(
    (run) => !isWorkbenchHostDefinitionName(run.definitionName),
  );
}

/**
 * A run's human-facing name (CL-6249): its routine's name when it fired
 * from one, honestly falling back to the definition name for a run with
 * no routine/task parent — e.g. a directly launched workflow. Never
 * mapped from a client-side lookup table; the route already resolved
 * `routineName` server-side (`@corbits/folded-runs`'s
 * `listTopLevelRunFires`).
 */
export function runDisplayName(run: InsightsRun): string {
  return run.routineName ?? run.definitionName;
}

/**
 * Keep runs whose `createdAt` falls inside `[fromIso, toIso]` (inclusive).
 * Invalid timestamps are dropped so KPIs never invent rows.
 */
export type DefinitionRunGroup = {
  /** `routineId` when the newest run in the group fired from one,
   * else `definitionId` — two different routines sharing one
   * definition (e.g. two workbench-digest schedules) never merge into
   * one group. */
  readonly groupKey: string;
  readonly displayName: string;
  /** Newest run first. */
  readonly runs: readonly InsightsRun[];
};

/**
 * "Run history" grouping for the Insights runs page: the same feed already
 * fetched for the flat list, bucketed by routine (falling back to
 * definition, for a run with no routine parent) and sorted newest-run
 * first — a client-side grouping of already-fetched data, no new endpoint.
 * Group order follows each group's own newest run, newest overall first.
 */
export function groupRunsByDefinition(
  runs: readonly InsightsRun[],
): readonly DefinitionRunGroup[] {
  const byGroupKey = new Map<string, InsightsRun[]>();
  for (const run of runs) {
    const groupKey = run.routineId ?? run.definitionId;
    const bucket = byGroupKey.get(groupKey);
    if (bucket === undefined) {
      byGroupKey.set(groupKey, [run]);
    } else {
      bucket.push(run);
    }
  }
  const groups = [...byGroupKey.entries()].map(([groupKey, group]) => {
    const runs = [...group].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    // Name from the newest run, after sorting — a routine or definition
    // rename must show the current name in the group header, not
    // whatever name its oldest fetched run happened to carry.
    return {
      groupKey,
      displayName: runs[0] !== undefined ? runDisplayName(runs[0]) : groupKey,
      runs,
    };
  });
  return groups.sort((a, b) =>
    (b.runs[0]?.createdAt ?? "").localeCompare(a.runs[0]?.createdAt ?? ""),
  );
}

export function filterRunsByCreatedAt(
  runs: readonly InsightsRun[],
  fromIso: string,
  toIso: string,
): readonly InsightsRun[] {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return [];
  return runs.filter((run) => {
    const t = Date.parse(run.createdAt);
    if (Number.isNaN(t)) return false;
    return t >= fromMs && t <= toMs;
  });
}

export function computeInsightsStats(
  runs: readonly InsightsRun[],
  routines: readonly ScheduledWorkflowDefinition[],
  recentLimit: number = INSIGHTS_RECENT_LIMIT,
  now: number = Date.now(),
): InsightsStats {
  const purposeful = purposeRunsForInsights(runs);
  let running = 0;
  let errored = 0;
  let stopped = 0;
  let deployed = 0;
  for (const run of purposeful) {
    const outcome =
      runOutcomeStatus(withListingAbandoned(run, now), now) ?? run.status;
    switch (outcome) {
      case "running":
      case "updating":
        running += 1;
        break;
      case "error":
        errored += 1;
        break;
      case "stopped":
      case "completed":
        stopped += 1;
        break;
      case "deployed":
        deployed += 1;
        break;
    }
  }

  const recentRuns = [...purposeful]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, recentLimit);

  return {
    totalRuns: purposeful.length,
    running,
    errored,
    stopped,
    deployed,
    routineCount: routines.length,
    enabledRoutines: routines.filter((r) => r.status === "deployed").length,
    recentRuns,
  };
}
