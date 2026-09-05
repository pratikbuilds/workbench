// CL-6099: the landing view's default scope must always be something the
// caller can actually see — resolveInsightsScope is the pure decision
// InsightsRoute defers to, covered here directly against both membership
// shapes `/scope` (packages/insights/src/routes.ts) can now report: a
// workspace member (parent present) and a non-member (parent absent).
// CL-5879 retired the `/insights/workbench/:tenantId` deep link that used
// to override this default outright — per-workbench Insights is now its
// own `/insights/workbench/:workbenchId` route (see `InsightsWorkbenchPage`),
// so this landing scope never takes a workbench override anymore.
import { describe, expect, test } from "bun:test";
import type { DayActivity } from "@corbits/insights/client";
import { FIRE_RUNNING_WINDOW_MS } from "@corbits/workflows/client";

import {
  costPerDay,
  elapsedLabel,
  isRunningNow,
  resolveInsightsScope,
  runsPerDay,
} from "./insights-page";
import type { InsightsRun, InsightsScope } from "../insights-api";

const workspaceMemberScope: InsightsScope = {
  tenantId: "tnt_bench_a",
  name: "Support bench",
  parent: { tenantId: "tnt_workspace", name: "Acme workspace" },
  workbenches: [
    { tenantId: "tnt_bench_a", name: "Support bench" },
    { tenantId: "tnt_bench_b", name: "Sales bench" },
  ],
};

const nonMemberScope: InsightsScope = {
  tenantId: "tnt_bench_a",
  name: "Support bench",
  parent: null,
  workbenches: [{ tenantId: "tnt_bench_a", name: "Support bench" }],
};

describe("resolveInsightsScope", () => {
  test("workspace member default landing: parent aggregate, labeled 'All workbenches'", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(result.effectiveTenantId).toBe("tnt_workspace");
    expect(result.scopeLabel).toBe("All workbenches");
  });

  test("parentless landing IS the aggregate: every workbench's runs land on the root tenancy", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      selectedTenantId: "tnt_bench_a",
      scopeData: nonMemberScope,
    });
    expect(result.effectiveTenantId).toBe(nonMemberScope.tenantId);
    expect(result.scopeLabel).toBe("All workbenches");
  });

  test("scope not yet resolved: stays on the current workbench id but never labels it with a raw id", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      selectedTenantId: "tnt_bench_a",
      scopeData: null,
    });
    expect(result.effectiveTenantId).toBe("tnt_bench_a");
    expect(result.scopeLabel).toBe("All workbenches");
  });

  test("non-landing modes always stay tied to the current workbench, ignoring scope", () => {
    const runsResult = resolveInsightsScope({
      mode: "runs",
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(runsResult.effectiveTenantId).toBe("tnt_bench_a");

    const runResult = resolveInsightsScope({
      mode: "run",
      selectedTenantId: "tnt_bench_a",
      scopeData: workspaceMemberScope,
    });
    expect(runResult.effectiveTenantId).toBe("tnt_bench_a");
  });

  test("no selected tenant and unresolved scope: never fabricates a tenant to view", () => {
    const result = resolveInsightsScope({
      mode: "landing",
      selectedTenantId: null,
      scopeData: null,
    });
    expect(result.effectiveTenantId).toBeNull();
  });
});

function day(
  partial: Partial<DayActivity> & Pick<DayActivity, "day">,
): DayActivity {
  return { turns: 0, tokens: 0, byModel: [], ...partial };
}

function run(
  partial: Partial<InsightsRun> & Pick<InsightsRun, "id" | "createdAt">,
): InsightsRun {
  return {
    tenantId: "t1",
    definitionId: "wfd_a",
    definitionName: "Research brief",
    address: "addr",
    status: "running",
    updatedAt: partial.createdAt,
    routineId: null,
    routineName: null,
    ...partial,
  };
}

describe("runsPerDay", () => {
  test("buckets each run's date onto the matching day, zero elsewhere", () => {
    const days = [
      day({ day: "2026-01-01" }),
      day({ day: "2026-01-02" }),
      day({ day: "2026-01-03" }),
    ];
    const runs = [
      run({ id: "a", createdAt: "2026-01-01T09:00:00.000Z" }),
      run({ id: "b", createdAt: "2026-01-01T18:00:00.000Z" }),
      run({ id: "c", createdAt: "2026-01-03T00:00:01.000Z" }),
    ];
    expect(runsPerDay(runs, days)).toEqual([2, 0, 1]);
  });

  test("a run outside the window contributes to no bucket", () => {
    const days = [day({ day: "2026-01-01" })];
    const runs = [run({ id: "a", createdAt: "2025-12-25T00:00:00.000Z" })];
    expect(runsPerDay(runs, days)).toEqual([0]);
  });

  test("no days: returns an empty series, not a fabricated one", () => {
    expect(
      runsPerDay([run({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" })], []),
    ).toEqual([]);
  });
});

describe("costPerDay", () => {
  test("sums known per-model costs for each day", () => {
    const days = [
      day({
        day: "2026-01-01",
        byModel: [
          { model: "opus-5", tokens: 100, costUsd: 1.5 },
          { model: "sonnet-5", tokens: 50, costUsd: 0.25 },
        ],
      }),
      day({ day: "2026-01-02", byModel: [] }),
    ];
    expect(costPerDay(days)).toEqual([1.75, 0]);
  });

  test("a null model rate contributes 0, not NaN — caller decides whether to show it", () => {
    const days = [
      day({
        day: "2026-01-01",
        byModel: [{ model: "new-model", tokens: 10, costUsd: null }],
      }),
    ];
    expect(costPerDay(days)).toEqual([0]);
  });
});

describe("elapsedLabel", () => {
  test("formats wall-clock time since createdAt", () => {
    const now = Date.parse("2026-01-01T00:02:12.000Z");
    expect(elapsedLabel("2026-01-01T00:00:00.000Z", now)).toBe("2.2m");
  });

  test("an invalid timestamp reads as unknown, not a fabricated duration", () => {
    expect(elapsedLabel("not-a-date", Date.now())).toBe("—");
  });
});

describe("isRunningNow", () => {
  test("a running run still inside the fire window is in flight", () => {
    expect(
      isRunningNow(
        run({
          id: "fresh",
          createdAt: new Date().toISOString(),
          status: "running",
        }),
      ),
    ).toBe(true);
  });

  test("updating is in flight", () => {
    expect(
      isRunningNow(
        run({
          id: "updating",
          createdAt: new Date().toISOString(),
          status: "updating",
        }),
      ),
    ).toBe(true);
  });

  test("a stopped run is not in flight", () => {
    expect(
      isRunningNow(
        run({
          id: "done",
          createdAt: new Date().toISOString(),
          status: "stopped",
        }),
      ),
    ).toBe(false);
  });

  // Warm-keep (CL-6681 / CL-6778): a routine's delivery agent stays deployed
  // after it replies, so workflow_run.status lingers on `running`. Past the
  // fire window that is not an in-flight job — Insights must not keep it in
  // "Running now" forever.
  test("endedAt drops in-flight immediately, even while status is still running inside the window", () => {
    expect(
      isRunningNow(
        run({
          id: "just-finished",
          createdAt: new Date().toISOString(),
          status: "running",
          endedAt: new Date().toISOString(),
        }),
      ),
    ).toBe(false);
  });

  test("a live running run past the fire window is still in flight", () => {
    expect(
      isRunningNow(
        run({
          id: "stale",
          createdAt: new Date(
            Date.now() - FIRE_RUNNING_WINDOW_MS - 1,
          ).toISOString(),
          status: "running",
        }),
      ),
    ).toBe(true);
  });
});
