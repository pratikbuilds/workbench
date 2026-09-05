import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createInsightsWindow,
  EMPTY_OVERALL_USAGE,
  type DayActivity,
  type OverallUsage,
} from "@corbits/insights/client";

import type { APIQuery } from "@corbits/api-query";
import { BenchProvider } from "../src/bench-context";
import {
  type InsightsRun,
  type InsightsScope,
  type LatencySummary,
  type RunTrace,
  type ToolCall,
  type WorkbenchUsage,
} from "../src/insights-api";
import { NavigationProvider } from "../src/navigation";
import {
  InsightsPage,
  InsightsRunDetail,
  InsightsRunsHistory,
} from "../src/pages/insights-page";
import type { ScheduledWorkflowDefinition } from "../src/routines-api";
import { TestQueryProvider } from "./test-query-provider";

const range = createInsightsWindow(7, new Date("2026-01-15T18:00:00.000Z"));

const emptyRuns: APIQuery<{ data: readonly never[]; nextCursor: null }> = {
  kind: "ready",
  data: { data: [], nextCursor: null },
};
const emptyRoutines: APIQuery<readonly ScheduledWorkflowDefinition[]> = {
  kind: "ready",
  data: [],
};
const emptyWorkbenches: APIQuery<{ items: readonly WorkbenchUsage[] }> = {
  kind: "ready",
  data: { items: [] },
};
const emptyStageStat = { p50Ms: null, p95Ms: null, samples: 0 };
const emptyLatency: APIQuery<LatencySummary> = {
  kind: "ready",
  data: {
    toReactorStart: emptyStageStat,
    toInferenceStart: emptyStageStat,
    toFirstToken: emptyStageStat,
    toReplyPosted: emptyStageStat,
    total: emptyStageStat,
  },
};

globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.reject(
    new Error("no network in insights page tests"),
  )) as typeof fetch;

function renderLanding(args: {
  readonly summary: APIQuery<OverallUsage>;
  readonly activity: APIQuery<readonly DayActivity[]>;
  readonly byTool: APIQuery<readonly ToolCall[]>;
}): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={() => undefined}>
        <BenchProvider>
          <InsightsPage
            path="/insights"
            summary={args.summary}
            activity={args.activity}
            byTool={args.byTool}
            runs={emptyRuns}
            routines={emptyRoutines}
            workbenches={emptyWorkbenches}
            latency={emptyLatency}
            range={range}
            scope={null}
            resolveWorkbenchIdForTenant={() => null}
            scopeLabel="All workbenches"
          />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

describe("InsightsPage usage honesty", () => {
  test("ready-empty usage hides usage KPI chrome, keeps Runs, not a load error", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: { kind: "ready", data: [] },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).not.toContain("load insights");
    expect(markup).not.toContain("$0.00");
    expect(markup).not.toContain("Tokens in / out");
    expect(markup).toContain("Runs");
    expect(markup).toContain("Insights");
  });

  test("zero-turn landing does not render a padded empty activity chart", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: { kind: "ready", data: [] },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).not.toContain("Axis to");
  });

  test("all-zero activity days do not render a chart even when the raw series is non-empty", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: {
        kind: "ready",
        data: [
          { day: "2026-01-09", turns: 0, tokens: 0, byModel: [] },
          { day: "2026-01-10", turns: 0, tokens: 0, byModel: [] },
          { day: "2026-01-11", turns: 0, tokens: 0, byModel: [] },
          { day: "2026-01-12", turns: 0, tokens: 0, byModel: [] },
          { day: "2026-01-13", turns: 0, tokens: 0, byModel: [] },
          { day: "2026-01-14", turns: 0, tokens: 0, byModel: [] },
          { day: "2026-01-15", turns: 0, tokens: 0, byModel: [] },
        ],
      },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).not.toContain("Axis to");
  });

  test("turns with a true zero cost still show $0.00", () => {
    const markup = renderLanding({
      summary: {
        kind: "ready",
        data: {
          turns: 4,
          tokens: {
            input: 20,
            cacheRead: 0,
            cacheWrite: 0,
            output: 10,
            thinking: 0,
            total: 30,
          },
          costUsd: 0,
          byModel: [],
        },
      },
      activity: {
        kind: "ready",
        data: [{ day: "2026-01-15", turns: 4, tokens: 30, byModel: [] }],
      },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).toContain("$0.00");
    expect(markup).toContain("Tokens in / out");
  });

  test("summary API error surfaces load failure instead of zeros", () => {
    const markup = renderLanding({
      summary: {
        kind: "error",
        message: "usage endpoint failed",
        retry: () => undefined,
      },
      activity: { kind: "ready", data: [] },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).toContain("load insights");
    expect(markup).not.toContain("usage endpoint failed");
    expect(markup).not.toContain("$0.00");
  });

  test("activity API error surfaces load failure", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: {
        kind: "error",
        message: "activity schema mismatch",
        retry: () => undefined,
      },
      byTool: { kind: "ready", data: [] },
    });
    expect(markup).toContain("load insights");
    expect(markup).not.toContain("activity schema mismatch");
  });

  test("byTool API error surfaces load failure", () => {
    const markup = renderLanding({
      summary: { kind: "ready", data: EMPTY_OVERALL_USAGE },
      activity: { kind: "ready", data: [] },
      byTool: {
        kind: "error",
        message: "tools route 500",
        retry: () => undefined,
      },
    });
    expect(markup).toContain("load insights");
    expect(markup).not.toContain("tools route 500");
  });
});

const purposeRun = {
  id: "run_1",
  tenantId: "tnt_1",
  definitionId: "wfd_1",
  definitionName: "Morning brief",
  address: "run@agents.example",
  status: "running",
  createdAt: "2026-01-15T12:00:00.000Z",
  updatedAt: "2026-01-15T12:00:00.000Z",
  routineId: null,
  routineName: null,
} as const;

function renderAtPath(path: string): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={() => undefined}>
        <BenchProvider>
          <InsightsPage
            path={path}
            summary={{ kind: "ready", data: EMPTY_OVERALL_USAGE }}
            activity={{ kind: "ready", data: [] }}
            byTool={{ kind: "ready", data: [] }}
            runs={{
              kind: "ready",
              data: { data: [purposeRun], nextCursor: null },
            }}
            routines={emptyRoutines}
            workbenches={emptyWorkbenches}
            latency={emptyLatency}
            range={range}
            scope={null}
            resolveWorkbenchIdForTenant={() => null}
            scopeLabel="All workbenches"
          />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

function renderLandingWithScope(args: {
  readonly scope: InsightsScope | null;
  readonly scopeLabel: string;
}): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={() => undefined}>
        <BenchProvider>
          <InsightsPage
            path="/insights"
            summary={{ kind: "ready", data: EMPTY_OVERALL_USAGE }}
            activity={{ kind: "ready", data: [] }}
            byTool={{ kind: "ready", data: [] }}
            runs={emptyRuns}
            routines={emptyRoutines}
            workbenches={emptyWorkbenches}
            latency={emptyLatency}
            range={range}
            scope={args.scope}
            resolveWorkbenchIdForTenant={() => null}
            scopeLabel={args.scopeLabel}
          />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

describe("InsightsPage scope switcher", () => {
  const scopeWithSiblings = {
    tenantId: "tnt_a",
    name: "Support",
    parent: { tenantId: "tnt_workspace", name: "Acme" },
    workbenches: [
      { tenantId: "tnt_a", name: "Support" },
      { tenantId: "tnt_b", name: "Sales" },
    ],
  };

  test("renders an All workbenches option plus one per sibling when the workbench has a parent", () => {
    const markup = renderLandingWithScope({
      scope: scopeWithSiblings,
      scopeLabel: "All workbenches",
    });
    expect(markup).toContain("All workbenches");
    expect(markup).toContain(">Support<");
    expect(markup).toContain(">Sales<");
  });

  // CL-5879: selecting a sibling now always navigates away to that
  // workbench's own `/insights/workbench/:workbenchId` view (see the
  // "activity by workbench" tests below) rather than switching this same
  // landing's scope inline — so "All workbenches" is the only option ever
  // marked active here.
  test("marks the All workbenches option active", () => {
    const markup = renderLandingWithScope({
      scope: scopeWithSiblings,
      scopeLabel: "All workbenches",
    });
    expect(markup).toContain(
      'aria-pressed="true" data-active="true" class="insights-scope-switcher-option">All workbenches</button>',
    );
    expect(markup).toContain(
      'aria-pressed="false" data-active="false" class="insights-scope-switcher-option">Support</button>',
    );
  });

  test("hides the switcher entirely for a workbench with no parent (nothing to switch to)", () => {
    const markup = renderLandingWithScope({
      scope: { tenantId: "tnt_a", name: "Solo", parent: null, workbenches: [] },
      scopeLabel: "All workbenches",
    });
    expect(markup).not.toContain("insights-scope-switcher");
  });

  test("hides the switcher while scope has not resolved yet", () => {
    const markup = renderLandingWithScope({
      scope: null,
      scopeLabel: "All workbenches",
    });
    expect(markup).not.toContain("insights-scope-switcher");
  });
});

function renderAtPathWithRuns(path: string, nextCursor: string | null): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={() => undefined}>
        <BenchProvider>
          <InsightsPage
            path={path}
            summary={{ kind: "ready", data: EMPTY_OVERALL_USAGE }}
            activity={{ kind: "ready", data: [] }}
            byTool={{ kind: "ready", data: [] }}
            runs={{
              kind: "ready",
              data: { data: [purposeRun], nextCursor },
            }}
            routines={emptyRoutines}
            workbenches={emptyWorkbenches}
            latency={emptyLatency}
            range={range}
            scope={null}
            resolveWorkbenchIdForTenant={() => null}
            scopeLabel="All workbenches"
          />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

describe("InsightsPage landing run-cap disclosure", () => {
  // The feed is fetched at a fixed limit=100 (see insightsTopLevelRunsPath).
  // A non-null nextCursor means the window truly holds more runs than were
  // fetched, so the KPIs/sparkline/outcome chart built from that truncated
  // set must say so rather than presenting it as the complete series —
  // InsightsRunsHistory already discloses its own cap; the landing must too.
  test("a non-null nextCursor discloses the 100-run cap on the landing view", () => {
    const markup = renderAtPathWithRuns("/insights", "cursor_2");
    expect(markup).toContain("100 most recent runs");
  });

  test("a null nextCursor (fewer than 100 runs) shows no cap disclosure", () => {
    const markup = renderAtPathWithRuns("/insights", null);
    expect(markup).not.toContain("100 most recent runs");
  });
});

describe("InsightsPage breadcrumbs", () => {
  test("runs history puts an Insights / Run history trail in the top bar", () => {
    const markup = renderAtPath("/insights/runs");
    expect(markup).toContain('data-testid="stage-top-bar"');
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain('href="/insights"');
    expect(markup).toContain('aria-current="page">Run history</span>');
    expect(markup).not.toContain("insights-crumb");
  });

  test("run detail puts a Runs / {run} trail in the top bar", () => {
    const markup = renderAtPath("/insights/runs/run_1");
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain('href="/insights/runs"');
    expect(markup).toContain('aria-current="page">Morning brief</span>');
    expect(markup).not.toContain("insights-crumb");
  });
});

describe("InsightsPage run-detail stat strip", () => {
  test("shows the Owner/Steps/Completed/Failed/Duration set, honestly dashed without a trace", () => {
    const markup = renderAtPath("/insights/runs/run_1");
    expect(markup).toContain(">Owner<");
    expect(markup).toContain(">Steps<");
    expect(markup).toContain(">Completed<");
    expect(markup).toContain(">Failed<");
    expect(markup).toContain(">Duration<");
    expect(markup).not.toContain(">Status<");
    expect(markup).not.toContain(">Bench<");
  });

  test("while the trace is loading, the KPIs render a shimmer, not a dash", () => {
    const markup = renderToStaticMarkup(
      <InsightsRunDetail run={purposeRun} trace={{ kind: "loading" }} />,
    );
    expect(markup).toContain('data-slot="skeleton"');
    // Owner is genuinely absent from WorkflowRunResponse today (not a
    // loading state), so it keeps its dash even while the trace loads.
    expect(markup).toContain(">—<");
  });

  test("once the trace is ready-but-empty, the KPIs fall back to a genuine dash", () => {
    const markup = renderToStaticMarkup(
      <InsightsRunDetail
        run={purposeRun}
        trace={{
          kind: "ready",
          data: { runId: "run_1", spans: null, absent: "no trace reader" },
        }}
      />,
    );
    expect(markup).not.toContain(">…<");
  });
});

describe("InsightsPage trace timeline honesty", () => {
  const measuredSpan = {
    id: "turn_1",
    label: "Turn 1",
    kind: "turn",
    start: 0,
    end: 5000,
    durationMs: 5000,
    tokens: null,
    phase: "ok",
    error: null,
    timingSource: "measured",
  } as const;

  const ordinalSpanWithNoDuration = {
    id: "part_1",
    label: "echo",
    kind: "tool",
    start: 1200,
    end: 1200,
    durationMs: null,
    tokens: null,
    phase: "ok",
    error: null,
    timingSource: "ordinal",
  } as const;

  function traceQuery(spans: RunTrace["spans"]): APIQuery<RunTrace> {
    return {
      kind: "ready",
      data: { runId: "run_1", spans } as RunTrace,
    };
  }

  test("a tool span positioned only by event order never gets a fabricated duration", () => {
    const markup = renderToStaticMarkup(
      <InsightsRunDetail
        run={purposeRun}
        trace={traceQuery([measuredSpan, ordinalSpanWithNoDuration])}
      />,
    );
    // The ordinal span's own duration cell reads as an honest dash, never a
    // computed 0ms/instant duration derived from its equal start/end.
    expect(markup).toContain(">—<");
    expect(markup).not.toContain("0ms");
  });

  test("a turn span with real measured timing still renders its actual duration", () => {
    const markup = renderToStaticMarkup(
      <InsightsRunDetail run={purposeRun} trace={traceQuery([measuredSpan])} />,
    );
    expect(markup).toContain("5.0s");
  });
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

function insightsRun(
  partial: Partial<InsightsRun> & Pick<InsightsRun, "id" | "status">,
): InsightsRun {
  return {
    tenantId: "t1",
    definitionId: "wfd_a",
    definitionName: "Research brief",
    address: "addr",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    routineId: partial.routineId ?? null,
    routineName: partial.routineName ?? null,
    ...partial,
  };
}

describe("InsightsRunsHistory definition grouping", () => {
  test("renders one table per definition, newest run first within each", () => {
    const runs = [
      insightsRun({
        id: "a1",
        status: "deployed",
        definitionId: "wfd_a",
        definitionName: "Research brief",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      insightsRun({
        id: "b1",
        status: "running",
        definitionId: "wfd_b",
        definitionName: "Weekly digest",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      insightsRun({
        id: "a2",
        status: "error",
        definitionId: "wfd_a",
        definitionName: "Research brief",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    const el = mount(
      <InsightsRunsHistory
        runs={runs}
        loading={false}
        nextCursor={null}
        onOpenRun={() => undefined}
      />,
    );

    const groups = el.querySelectorAll("[data-definition-group]");
    expect(groups.length).toBe(2);
    expect(groups[0]?.getAttribute("data-definition-group")).toBe("wfd_a");
    const firstGroupRows = groups[0]?.querySelectorAll("tbody tr") ?? [];
    expect(firstGroupRows.length).toBe(2);
    expect(firstGroupRows[0]?.textContent).toContain("Failed");
    expect(el.textContent).not.toContain("Showing the 100 most recent runs.");
  });

  test("no runs renders an honest empty state, not empty tables", () => {
    const el = mount(
      <InsightsRunsHistory
        runs={[]}
        loading={false}
        nextCursor={null}
        onOpenRun={() => undefined}
      />,
    );
    expect(el.querySelector("[data-definition-group]")).toBeNull();
    expect(el.textContent).toContain("No runs yet");
  });

  test("a non-null nextCursor tells the reader more runs exist beyond the 100 shown", () => {
    const el = mount(
      <InsightsRunsHistory
        runs={[insightsRun({ id: "a1", status: "deployed" })]}
        loading={false}
        nextCursor="cursor_2"
        onOpenRun={() => undefined}
      />,
    );
    expect(el.textContent).toContain("Showing the 100 most recent runs.");
  });

  test("a routine fire's group header renders the routine's human name, not its definition name", () => {
    const el = mount(
      <InsightsRunsHistory
        runs={[
          insightsRun({
            id: "fire1",
            status: "running",
            definitionId: "wfd_workbench_digest",
            definitionName: "workbench-digest",
            routineId: "rtn_pulse_check",
            routineName: "Pulse check",
          }),
        ]}
        loading={false}
        nextCursor={null}
        onOpenRun={() => undefined}
      />,
    );
    expect(el.textContent).toContain("Pulse check");
    expect(el.textContent).not.toContain("workbench-digest");
  });
});

// CL-6224: the global (all-workbenches) landing's KPI band and
// activity-by-workbench chart, fed by `/insights/workbenches`.
describe("InsightsPage global landing — KPIs and activity by workbench", () => {
  const usageWithSpend: OverallUsage = {
    turns: 42,
    tokens: {
      input: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 500,
      thinking: 0,
      total: 1500,
    },
    costUsd: 12.5,
    byModel: [],
  };

  const workbenches: readonly WorkbenchUsage[] = [
    {
      tenantId: "tnt_a",
      name: "Support",
      turns: 30,
      tokens: {
        input: 900,
        cacheRead: 0,
        cacheWrite: 0,
        output: 400,
        thinking: 0,
        total: 1300,
      },
      costUsd: 10,
    },
    {
      tenantId: "tnt_b",
      name: "Sales",
      turns: 12,
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 100,
        thinking: 0,
        total: 200,
      },
      costUsd: 2.5,
    },
    {
      tenantId: "tnt_c",
      name: "Quiet workbench",
      turns: 0,
      tokens: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
        total: 0,
      },
      costUsd: 0,
    },
  ];

  function mountGlobalLanding(navigate: (path: string) => void) {
    return mount(
      <TestQueryProvider>
        <NavigationProvider navigate={navigate}>
          <BenchProvider>
            <InsightsPage
              path="/insights"
              summary={{ kind: "ready", data: usageWithSpend }}
              activity={{ kind: "ready", data: [] }}
              byTool={{ kind: "ready", data: [] }}
              runs={emptyRuns}
              routines={emptyRoutines}
              workbenches={{ kind: "ready", data: { items: workbenches } }}
              latency={emptyLatency}
              range={range}
              scope={null}
              resolveWorkbenchIdForTenant={(tenantId) =>
                tenantId === "tnt_b" ? "ch_b" : null
              }
              scopeLabel="All workbenches"
            />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
  }

  test("renders the KPI band from stubbed usage/workbenches data", () => {
    const el = mountGlobalLanding(() => undefined);
    expect(el.textContent).toContain("$12.50");
    expect(el.textContent).toContain("Tokens in / out");
    expect(el.textContent).toContain("1,000 / 500");
    expect(el.textContent).toContain("Active workbenches");
    // 2 of 3 workbenches recorded turns > 0 in this fixture.
    expect(el.textContent).toContain("2 / 3");
  });

  test("ranks workbenches by turns and links each bar to its own scoped view", () => {
    const el = mountGlobalLanding(() => undefined);
    expect(el.textContent).toContain("Activity by workbench");
    const rows = [
      ...el.querySelectorAll(
        "table[aria-label='Activity by workbench'] tbody tr",
      ),
    ];
    expect(
      rows.map(
        (r) => r.textContent?.match(/Support|Sales|Quiet workbench/)?.[0],
      ),
    ).toEqual(["Support", "Sales", "Quiet workbench"]);
  });

  test("clicking a workbench bar resolves its workbench and navigates to /insights/workbench/:workbenchId", () => {
    const navigated: string[] = [];
    const el = mountGlobalLanding((path) => navigated.push(path));
    const salesRow = [...el.querySelectorAll("tbody tr")].find((row) =>
      row.textContent?.includes("Sales"),
    );
    expect(salesRow).toBeDefined();
    act(() => {
      salesRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toEqual(["/insights/workbench/ch_b"]);
  });

  test("a workbench with no resolvable workbench never gets a broken link", () => {
    const navigated: string[] = [];
    const el = mount(
      <TestQueryProvider>
        <NavigationProvider navigate={(path) => navigated.push(path)}>
          <BenchProvider>
            <InsightsPage
              path="/insights"
              summary={{ kind: "ready", data: usageWithSpend }}
              activity={{ kind: "ready", data: [] }}
              byTool={{ kind: "ready", data: [] }}
              runs={emptyRuns}
              routines={emptyRoutines}
              workbenches={{ kind: "ready", data: { items: workbenches } }}
              latency={emptyLatency}
              range={range}
              scope={null}
              resolveWorkbenchIdForTenant={() => null}
              scopeLabel="All workbenches"
            />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
    const salesRow = [...el.querySelectorAll("tbody tr")].find((row) =>
      row.textContent?.includes("Sales"),
    );
    act(() => {
      salesRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toEqual([]);
  });

  test("an all-zero workbenches window shows the honest empty note, not a fabricated chart", () => {
    const el = mount(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <InsightsPage
              path="/insights"
              summary={{ kind: "ready", data: EMPTY_OVERALL_USAGE }}
              activity={{ kind: "ready", data: [] }}
              byTool={{ kind: "ready", data: [] }}
              runs={emptyRuns}
              routines={emptyRoutines}
              workbenches={{ kind: "ready", data: { items: [] } }}
              latency={emptyLatency}
              range={range}
              scope={null}
              resolveWorkbenchIdForTenant={() => null}
              scopeLabel="All workbenches"
            />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
    expect(el.textContent).toContain("No usage recorded yet in this window.");
    expect(el.textContent).toContain("Activity by workbench");
    expect(el.textContent).toContain("No workbench activity yet");
  });
});

describe("InsightsPage global landing — turn latency tiles (CL-6257)", () => {
  function mountWithLatency(latency: APIQuery<LatencySummary>) {
    return mount(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <InsightsPage
              path="/insights"
              summary={{ kind: "ready", data: EMPTY_OVERALL_USAGE }}
              activity={{ kind: "ready", data: [] }}
              byTool={{ kind: "ready", data: [] }}
              runs={emptyRuns}
              routines={emptyRoutines}
              workbenches={emptyWorkbenches}
              latency={latency}
              range={range}
              scope={null}
              resolveWorkbenchIdForTenant={() => null}
              scopeLabel="All workbenches"
            />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
  }

  test("no latency samples in range: tiles stay hidden, not zeroed", () => {
    const el = mountWithLatency(emptyLatency);
    expect(el.textContent).not.toContain("Turn latency");
  });

  test("renders p50/p95 stage tiles once samples exist", () => {
    const el = mountWithLatency({
      kind: "ready",
      data: {
        toReactorStart: { p50Ms: null, p95Ms: null, samples: 0 },
        toInferenceStart: { p50Ms: 200, p95Ms: 400, samples: 5 },
        toFirstToken: { p50Ms: 1_200, p95Ms: 3_400, samples: 5 },
        toReplyPosted: { p50Ms: 2_000, p95Ms: 4_000, samples: 5 },
        total: { p50Ms: 3_400, p95Ms: 8_000, samples: 5 },
      },
    });
    expect(el.textContent).toContain("Turn latency (p50 / p95)");
    expect(el.textContent).toContain("3.4s / 8.0s");
    expect(el.textContent).toContain("To first token (p50 / p95)");
    expect(el.textContent).toContain("1.2s / 3.4s");
    expect(el.textContent).toContain("wait until first token");
    expect(el.textContent).toContain("first token → reply posted");
    expect(el.textContent).not.toContain("inference start");
    expect(el.textContent).not.toContain("reactor");
    // No cold starts this window — that stage tile does not render at all.
    expect(el.textContent).not.toContain("Cold start");
  });

  test("a cold-start sample surfaces its own reactor-start tile", () => {
    const el = mountWithLatency({
      kind: "ready",
      data: {
        toReactorStart: { p50Ms: 30_000, p95Ms: 45_000, samples: 1 },
        toInferenceStart: { p50Ms: 500, p95Ms: 500, samples: 1 },
        toFirstToken: { p50Ms: 2_000, p95Ms: 2_000, samples: 1 },
        toReplyPosted: { p50Ms: 1_000, p95Ms: 1_000, samples: 1 },
        total: { p50Ms: 33_500, p95Ms: 33_500, samples: 1 },
      },
    });
    expect(el.textContent).toContain("Cold start (p50 / p95)");
    expect(el.textContent).toContain("30.0s / 45.0s");
    expect(el.textContent).toContain("wait before the model starts");
    expect(el.textContent).not.toContain("reactor");
    expect(el.textContent).not.toContain("inference start");
  });
});
