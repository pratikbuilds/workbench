// A malformed percent-escape on an Insights deep link
// (`/insights/workbench/%E0%A4%A`, `/insights/runs/%`) must render the
// same landing dashboard any other unrecognized Insights path gets — never
// a blank page, and never `InsightsWorkbenchPage`/the run-detail route with
// no entity to show (see `insights-path.ts`'s `parseInsightsPath`, which
// InsightsPage calls with the exact same `path` prop this test passes).

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { APIQuery } from "@corbits/api-query";
import {
  EMPTY_OVERALL_USAGE,
  EMPTY_TOKEN_TOTALS,
} from "@corbits/insights/client";

import { InsightsPage, useInsightsWindow } from "./insights-page";
import { BenchContext } from "../bench-context";
import type { BenchState } from "../bench-context";
import type { InsightsRun } from "../insights-api";
import { NavigationProvider } from "../navigation";

type RunsStub = { data: readonly InsightsRun[]; nextCursor: string | null };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const readyEmpty = <T,>(data: T): APIQuery<T> => ({ kind: "ready", data });

const benchState: BenchState = {
  memberships: { kind: "ready", data: { data: [], nextCursor: null } },
  selectedTenantId: "tnt_bench_a",
  selectedPrincipalId: "prn_bench_a",
  selectTenant: () => {},
  onBenchCreated: () => {},
};

function InsightsPageAtPath({
  path,
  runs = { data: [], nextCursor: null },
}: {
  readonly path: string;
  readonly runs?: RunsStub;
}) {
  const range = useInsightsWindow();
  return (
    <NavigationProvider navigate={() => {}}>
      <BenchContext.Provider value={benchState}>
        <InsightsPage
          path={path}
          summary={readyEmpty(EMPTY_OVERALL_USAGE)}
          activity={readyEmpty([])}
          byTool={readyEmpty([])}
          runs={readyEmpty(runs)}
          routines={readyEmpty([])}
          workbenches={readyEmpty({ items: [] })}
          latency={{ kind: "loading" }}
          range={range}
          scope={null}
          resolveWorkbenchIdForTenant={() => null}
          scopeLabel="All workbenches"
        />
      </BenchContext.Provider>
    </NavigationProvider>
  );
}

function render(path: string, runs?: RunsStub) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <InsightsPageAtPath
        path={path}
        {...(runs === undefined ? {} : { runs })}
      />,
    );
  });
  return container;
}

describe("InsightsPage with a malformed URL escape", () => {
  test("a malformed workbench deep link still renders the landing dashboard", () => {
    const el = render("/insights/workbench/%E0%A4%A");
    expect(el.textContent).not.toBe("");
    expect(el.textContent).toContain("Insights");
    expect(el.textContent).toContain("All workbenches");
  });

  test("a malformed run deep link still renders the landing dashboard, not run detail", () => {
    const el = render("/insights/runs/%");
    expect(el.textContent).not.toBe("");
    expect(el.textContent).toContain("Insights");
    expect(el.textContent).toContain("All workbenches");
  });
});

describe("InsightsPage 'Running now' strip", () => {
  test("no in-flight runs: the strip renders nothing, not an empty-state fixture", () => {
    const el = render("/insights", { data: [], nextCursor: null });
    expect(el.textContent).not.toContain("Running now");
  });

  test("a genuinely running run surfaces in the strip by name", () => {
    const el = render("/insights", {
      data: [
        {
          id: "run_1",
          tenantId: "tnt_bench_a",
          definitionId: "wfd_a",
          definitionName: "Weekly digest",
          address: "addr",
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          routineId: null,
          routineName: null,
        },
      ],
      nextCursor: null,
    });
    expect(el.textContent).toContain("Running now");
    expect(el.textContent).toContain("1 in progress");
    expect(el.textContent).toContain("Weekly digest");
  });

  // Liveness is not a windowed property: a run that started long before the
  // 7-day window and is still running must not disappear from the strip or
  // read 0 in the "Running now" KPI just because its start time falls
  // outside `range`. Persist has not settled (`endedAt` absent), so the
  // fire is live — not remapped to completed by the abandoned-fire window.
  test("a run started 8 days ago that is still running stays in the strip and the KPI", () => {
    const eightDaysAgo = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const el = render("/insights", {
      data: [
        {
          id: "run_long_haul",
          tenantId: "tnt_bench_a",
          definitionId: "wfd_a",
          definitionName: "Long haul",
          address: "addr",
          status: "running",
          createdAt: eightDaysAgo,
          updatedAt: eightDaysAgo,
          routineId: null,
          routineName: null,
        },
      ],
      nextCursor: null,
    });
    expect(el.textContent).toContain("Running now");
    expect(el.textContent).toContain("1 in progress");
    expect(el.textContent).toContain("Long haul");
    expect(el.textContent).toContain("in flight");
  });

  test("the elapsed label ticks forward while a run is live, not frozen at first render", async () => {
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const el = render("/insights", {
      data: [
        {
          id: "run_ticking",
          tenantId: "tnt_bench_a",
          definitionId: "wfd_a",
          definitionName: "Weekly digest",
          address: "addr",
          status: "running",
          createdAt: startedAt,
          updatedAt: startedAt,
          routineId: null,
          routineName: null,
        },
      ],
      nextCursor: null,
    });
    const before = el.textContent;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    expect(el.textContent).not.toBe(before);
  });
});

describe("CL-6659 unreported local-model tokens", () => {
  test("turns with no token counts label the exclusion instead of Cost $0.00 / 0/0", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const range = {
      from: "2026-01-08T18:00:00.000Z",
      to: "2026-01-15T18:00:00.000Z",
    };
    act(() => {
      root?.render(
        <NavigationProvider navigate={() => {}}>
          <BenchContext.Provider value={benchState}>
            <InsightsPage
              path="/insights"
              summary={readyEmpty({
                turns: 2,
                tokens: { ...EMPTY_TOKEN_TOTALS },
                costUsd: null,
                byModel: [
                  {
                    model: "qwen3:latest",
                    turns: 2,
                    tokens: { ...EMPTY_TOKEN_TOTALS },
                    costUsd: null,
                  },
                ],
              })}
              activity={readyEmpty([
                {
                  day: "2026-01-15",
                  turns: 2,
                  tokens: 0,
                  byModel: [
                    { model: "qwen3:latest", tokens: 0, costUsd: null },
                  ],
                },
              ])}
              byTool={readyEmpty([])}
              runs={readyEmpty({ data: [], nextCursor: null })}
              routines={readyEmpty([])}
              workbenches={readyEmpty({
                items: [
                  {
                    tenantId: "tnt_bench_a",
                    name: "Support bench",
                    turns: 2,
                    tokens: { ...EMPTY_TOKEN_TOTALS },
                    costUsd: null,
                  },
                ],
              })}
              latency={{ kind: "loading" }}
              range={range}
              scope={null}
              resolveWorkbenchIdForTenant={() => null}
              scopeLabel="All workbenches"
            />
          </BenchContext.Provider>
        </NavigationProvider>,
      );
    });
    expect(container?.textContent).toContain("Token counts were not reported");
    expect(container?.textContent).toContain("qwen3:latest");
    expect(container?.textContent).not.toMatch(/Cost\s*\$0\.00/);
  });
});
