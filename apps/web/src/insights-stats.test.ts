import { describe, expect, test } from "bun:test";

import { FIRE_RUNNING_WINDOW_MS } from "@corbits/workflows/client";

import {
  computeInsightsStats,
  computeTraceStats,
  filterRunsByCreatedAt,
  groupRunsByDefinition,
  INSIGHTS_RECENT_LIMIT,
  purposeRunsForInsights,
  runDisplayName,
} from "./insights-stats";
import type { InsightsRun, RunTraceSpan } from "./insights-api";
import type { ScheduledWorkflowDefinition } from "./routines-api";

function span(
  partial: Partial<RunTraceSpan> & Pick<RunTraceSpan, "id">,
): RunTraceSpan {
  return {
    label: partial.id,
    kind: "tool",
    start: 0,
    end: 1000,
    durationMs: null,
    tokens: null,
    phase: "ok",
    error: null,
    timingSource: "measured",
    ...partial,
  };
}

function run(
  partial: Partial<InsightsRun> & Pick<InsightsRun, "id" | "status">,
): InsightsRun {
  return {
    tenantId: "t1",
    definitionId: "def",
    definitionName: partial.definitionName ?? "research-brief",
    address: "addr",
    createdAt: partial.createdAt ?? "2026-01-02T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-02T00:00:00.000Z",
    routineId: partial.routineId ?? null,
    routineName: partial.routineName ?? null,
    ...partial,
  };
}

function scheduled(
  partial: Partial<ScheduledWorkflowDefinition> &
    Pick<ScheduledWorkflowDefinition, "definitionId" | "status">,
): ScheduledWorkflowDefinition {
  return {
    assetId: "ast_def",
    name: "Daily dig",
    tenantId: "t1",
    cron: "0 9 * * *",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("computeInsightsStats", () => {
  test("counts purposeful runs by status and drops workbench hosts", () => {
    const stats = computeInsightsStats(
      [
        run({
          id: "1",
          status: "running",
          createdAt: "2026-01-03T00:00:00.000Z",
        }),
        run({
          id: "2",
          status: "error",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
        run({
          id: "3",
          status: "stopped",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        run({
          id: "host",
          status: "running",
          definitionName: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          createdAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
      [
        scheduled({ definitionId: "r1", status: "deployed" }),
        scheduled({ definitionId: "r2", status: "stopped" }),
      ],
      INSIGHTS_RECENT_LIMIT,
      Date.parse("2026-01-03T00:01:00.000Z"),
    );

    expect(stats.totalRuns).toBe(3);
    expect(stats.running).toBe(1);
    expect(stats.errored).toBe(1);
    expect(stats.stopped).toBe(1);
    expect(stats.routineCount).toBe(2);
    expect(stats.enabledRoutines).toBe(1);
    expect(stats.recentRuns.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  test("a live running run past the fire window is still counted as running", () => {
    const stats = computeInsightsStats(
      [
        run({
          id: "stale",
          status: "running",
          createdAt: new Date(
            Date.now() - FIRE_RUNNING_WINDOW_MS - 1,
          ).toISOString(),
        }),
      ],
      [],
    );
    expect(stats.running).toBe(1);
  });

  test("endedAt drops a just-finished running run from the running count immediately", () => {
    const stats = computeInsightsStats(
      [
        run({
          id: "just-finished",
          status: "running",
          createdAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        }),
      ],
      [],
    );
    expect(stats.running).toBe(0);
  });

  test("limits recent runs", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      run({
        id: String(i),
        status: "deployed",
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
    const stats = computeInsightsStats(runs, [], 2);
    expect(stats.recentRuns).toHaveLength(2);
    expect(stats.deployed).toBe(5);
  });
});

describe("purposeRunsForInsights", () => {
  const workbenchHost = run({
    id: "host",
    status: "running",
    definitionName: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  });
  const deployment = run({ id: "ins_deployed", status: "running" });

  test("drops a workbench-host run by its definition-name pattern", () => {
    expect(purposeRunsForInsights([deployment, workbenchHost])).toEqual([
      deployment,
    ]);
  });

  test("leaves an ordinary top-level deployment run alone", () => {
    expect(purposeRunsForInsights([deployment])).toEqual([deployment]);
  });

  test("an empty feed (server already scoped out everything) reads as zero, not an error", () => {
    expect(purposeRunsForInsights([])).toEqual([]);
  });
});

describe("computeTraceStats", () => {
  test("returns null when spans are absent or empty", () => {
    expect(computeTraceStats(null)).toBeNull();
    expect(computeTraceStats([])).toBeNull();
  });

  test("derives steps, completed, failed, and duration from spans", () => {
    const stats = computeTraceStats([
      span({ id: "a", phase: "ok", start: 0, end: 500 }),
      span({ id: "b", phase: "failed", start: 200, end: 900 }),
      span({ id: "c", phase: "awaiting", start: 400, end: 1200 }),
    ]);
    expect(stats).toEqual({
      steps: 3,
      completed: 1,
      failed: 1,
      durationMs: 1200,
    });
  });
});

describe("groupRunsByDefinition", () => {
  test("groups runs by definitionId, newest first within each group", () => {
    const groups = groupRunsByDefinition([
      run({
        id: "a1",
        status: "deployed",
        definitionId: "wfd_a",
        definitionName: "Research brief",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      run({
        id: "b1",
        status: "running",
        definitionId: "wfd_b",
        definitionName: "Weekly digest",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      run({
        id: "a2",
        status: "error",
        definitionId: "wfd_a",
        definitionName: "Research brief",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    ]);

    expect(groups.map((g) => g.groupKey)).toEqual(["wfd_a", "wfd_b"]);
    expect(groups[0]?.runs.map((r) => r.id)).toEqual(["a2", "a1"]);
    expect(groups[0]?.displayName).toBe("Research brief");
  });

  test("an empty feed groups to nothing", () => {
    expect(groupRunsByDefinition([])).toEqual([]);
  });

  test("uses the newest run's name, not input-array-first, when a definition was renamed", () => {
    // Old run (chronologically oldest) appears FIRST in the input array,
    // simulating an unsorted/out-of-order feed. Newer run (renamed) is second.
    const groups = groupRunsByDefinition([
      run({
        id: "old",
        status: "deployed",
        definitionId: "wfd_a",
        definitionName: "Old Name",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      run({
        id: "new",
        status: "deployed",
        definitionId: "wfd_a",
        definitionName: "New Name",
        createdAt: "2026-01-05T00:00:00.000Z",
      }),
    ]);
    expect(groups[0]?.runs.map((r) => r.id)).toEqual(["new", "old"]);
    // The group header should reflect the current (newest) name.
    expect(groups[0]?.displayName).toBe("New Name");
  });

  test("groups a routine fire by its routine, not its shared definition, and shows the routine's name", () => {
    const groups = groupRunsByDefinition([
      run({
        id: "fire1",
        status: "running",
        definitionId: "wfd_workbench_digest",
        definitionName: "workbench-digest",
        routineId: "rtn_pulse_check",
        routineName: "Pulse check",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      // A second routine firing the very same definition must land in
      // its own group, not merge with "Pulse check" above.
      run({
        id: "fire2",
        status: "running",
        definitionId: "wfd_workbench_digest",
        definitionName: "workbench-digest",
        routineId: "rtn_weekly_roundup",
        routineName: "Weekly roundup",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    expect(groups.map((g) => g.groupKey).sort()).toEqual(
      ["rtn_pulse_check", "rtn_weekly_roundup"].sort(),
    );
    expect(groups.map((g) => g.displayName).sort()).toEqual(
      ["Pulse check", "Weekly roundup"].sort(),
    );
  });
});

describe("runDisplayName", () => {
  test("prefers the routine's name when the run fired from one", () => {
    expect(
      runDisplayName(
        run({
          id: "fire1",
          status: "running",
          definitionName: "workbench-digest",
          routineId: "rtn_pulse_check",
          routineName: "Pulse check",
        }),
      ),
    ).toBe("Pulse check");
  });

  test("falls back to the definition name for a run with no routine/task parent", () => {
    expect(
      runDisplayName(
        run({
          id: "direct1",
          status: "running",
          definitionName: "researcher",
          routineId: null,
          routineName: null,
        }),
      ),
    ).toBe("researcher");
  });
});

describe("filterRunsByCreatedAt", () => {
  const from = "2026-01-08T18:00:00.000Z";
  const to = "2026-01-15T18:00:00.000Z";

  test("keeps runs inside the inclusive window", () => {
    const filtered = filterRunsByCreatedAt(
      [
        run({
          id: "old",
          status: "stopped",
          createdAt: "2026-01-08T17:59:59.000Z",
        }),
        run({ id: "edge-from", status: "stopped", createdAt: from }),
        run({
          id: "mid",
          status: "running",
          createdAt: "2026-01-12T12:00:00.000Z",
        }),
        run({ id: "edge-to", status: "deployed", createdAt: to }),
        run({
          id: "future",
          status: "running",
          createdAt: "2026-01-15T18:00:01.000Z",
        }),
      ],
      from,
      to,
    );
    expect(filtered.map((r) => r.id)).toEqual(["edge-from", "mid", "edge-to"]);
  });

  test("drops invalid createdAt timestamps", () => {
    const filtered = filterRunsByCreatedAt(
      [
        run({ id: "bad", status: "stopped", createdAt: "not-a-date" }),
        run({
          id: "ok",
          status: "stopped",
          createdAt: "2026-01-10T00:00:00.000Z",
        }),
      ],
      from,
      to,
    );
    expect(filtered.map((r) => r.id)).toEqual(["ok"]);
  });
});
