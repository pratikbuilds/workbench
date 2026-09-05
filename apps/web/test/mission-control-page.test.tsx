import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { Workbench } from "@corbits/chat-ui";
import { FIRE_RUNNING_WINDOW_MS } from "@corbits/workflows/client";

import { BenchContext, type BenchState } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import {
  computeInFlightRows,
  computeJumpBackRows,
  MissionControlRoute,
} from "../src/pages/mission-control-page";
import type { RoutineActivityItem } from "../src/shell/routine-activity";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function routine(overrides: Partial<RoutineActivityItem>): RoutineActivityItem {
  return {
    id: "rtn_1",
    name: "Weekly digest",
    status: "running",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function workbench(overrides: Partial<Workbench>): Workbench {
  return {
    id: "wb_1",
    title: "Launch plan",
    kind: "workbench",
    pinned: false,
    participants: [],
    lastActivityAt: "2026-08-19T09:00:00.000Z",
    ...overrides,
  };
}

describe("computeInFlightRows", () => {
  test("keeps only running routines", () => {
    const rows = computeInFlightRows([
      routine({ id: "r1", status: "running" }),
      routine({ id: "r2", status: "deployed" }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["routine:r1"]);
  });

  test("sorts newest first", () => {
    const rows = computeInFlightRows([
      routine({
        id: "old",
        status: "running",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      routine({
        id: "new",
        status: "running",
        startedAt: new Date().toISOString(),
      }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["routine:new", "routine:old"]);
  });

  test("a running routine still inside the fire window stays in-flight", () => {
    const rows = computeInFlightRows([
      routine({
        id: "fresh",
        status: "running",
        startedAt: new Date().toISOString(),
      }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["routine:fresh"]);
    expect(rows[0]?.statusLabel).toBe("Running now");
  });

  // Warm-keep (CL-6681 / CL-6778): Mission Control's active-run count and
  // in-flight table must not keep a finished fire as "Running" forever just
  // because the delivery agent is still deployed.
  test("endedAt drops a just-finished running routine from in-flight immediately", () => {
    const rows = computeInFlightRows([
      routine({
        id: "just-finished",
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test("a live running routine past the fire window stays in-flight", () => {
    const rows = computeInFlightRows([
      routine({
        id: "stale",
        status: "running",
        startedAt: new Date(
          Date.now() - FIRE_RUNNING_WINDOW_MS - 1,
        ).toISOString(),
      }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["routine:stale"]);
  });
});

describe("computeJumpBackRows", () => {
  test("drops a workbench with no recorded activity instead of inventing a time", () => {
    // `lastActivityAt` is optional, and under `exactOptionalPropertyTypes`
    // "no recorded activity" means the key is absent, not set to undefined.
    const silent: Workbench = {
      id: "silent",
      title: "Launch plan",
      kind: "workbench",
      pinned: false,
      participants: [],
    };
    const rows = computeJumpBackRows([silent], [], [], () => undefined);
    expect(rows).toEqual([]);
  });

  test("merges workbenches, chats, and agents, newest first, capped at the limit", () => {
    const rows = computeJumpBackRows(
      [workbench({ id: "wb1", lastActivityAt: "2026-08-19T09:00:00.000Z" })],
      [
        workbench({
          id: "chat1",
          kind: "chat",
          lastActivityAt: "2026-08-19T11:00:00.000Z",
        }),
      ],
      [
        {
          id: "agent1",
          name: "Research Analyst",
          createdAt: "2026-08-19T10:00:00.000Z",
        },
      ],
      () => undefined,
      2,
    );
    expect(rows.map((row) => row.key)).toEqual(["bench:chat1", "agent:agent1"]);
    expect(rows[0]?.context).toBe("chat");
  });
});

const benchState: BenchState = {
  memberships: { kind: "ready", data: { data: [], nextCursor: null } },
  selectedTenantId: "tnt_bench_a",
  selectedPrincipalId: "prn_bench_a",
  selectTenant: () => {},
  onBenchCreated: () => {},
};

function stubEmptyBenchFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/approvals")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/insights/activity")) {
      return Promise.resolve(
        new Response(JSON.stringify({ days: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/agent-definitions/visible")) {
      return Promise.resolve(
        new Response(JSON.stringify({ definitions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ items: [], data: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

function stubBenchFetchWithActivity(
  days: {
    day: string;
    turns: number;
    tokens: number;
    byModel: { model: string; tokens: number; costUsd: number | null }[];
  }[],
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/approvals")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/insights/activity")) {
      return Promise.resolve(
        new Response(JSON.stringify({ days }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/agent-definitions/visible")) {
      return Promise.resolve(
        new Response(JSON.stringify({ definitions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ items: [], data: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

describe("MissionControlRoute", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  test("renders honest empty states with nothing waiting and nothing running", async () => {
    stubEmptyBenchFetch();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchContext.Provider value={benchState}>
              <MissionControlRoute navigate={() => undefined} />
            </BenchContext.Provider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let count = 0; count < 5; count += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(container.textContent).toContain("Mission Control");
    expect(container.textContent).toContain("New workbench");
    expect(container.textContent).not.toContain("New bench");
    expect(container.textContent).toContain("Nothing waiting on you");
    expect(container.textContent).toContain("Nothing running right now");
    expect(container.textContent).toContain("Nothing recent yet.");
  });

  test("ready activity with no today row shows 0 / $0.00, not double em-dash (CL-6798)", async () => {
    stubEmptyBenchFetch();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchContext.Provider value={benchState}>
              <MissionControlRoute navigate={() => undefined} />
            </BenchContext.Provider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let count = 0; count < 5; count += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const text = container.textContent ?? "";
    // Ready + missing today is zero, not unknown — one empty treatment, not
    // value em-dash stacked on sub em-dash.
    expect(text).toContain("Runs today");
    expect(text).not.toMatch(/Runs today—/);
    expect(text).toMatch(/Runs today0/);
    expect(text).toContain("Spend today");
    expect(text).toContain("$0.00");
    expect(text).not.toContain("7-day activity");
    expect(text).toContain("so far today");
  });

  test("Spend today keeps em-dash when today's cost rate is unknown (CL-6798)", async () => {
    const todayKey = new Date().toISOString().slice(0, 10);
    stubBenchFetchWithActivity([
      {
        day: todayKey,
        turns: 3,
        tokens: 50,
        byModel: [{ model: "m", tokens: 50, costUsd: null }],
      },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchContext.Provider value={benchState}>
              <MissionControlRoute navigate={() => undefined} />
            </BenchContext.Provider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let count = 0; count < 5; count += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const text = container.textContent ?? "";
    expect(text).toMatch(/Runs today3/);
    expect(text).toContain("so far today");
    expect(text).not.toContain("7-day activity");
    // Cost unknown → em-dash for spend value; subcopy still names today.
    expect(text).toMatch(/Spend today—so far today/);
  });

  test("This week's run count includes today, so it is never less than runs today (CL-6667)", async () => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const yesterdayKey = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    stubBenchFetchWithActivity([
      { day: yesterdayKey, turns: 4, tokens: 100, byModel: [] },
      { day: todayKey, turns: 10, tokens: 200, byModel: [] },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchContext.Provider value={benchState}>
              <MissionControlRoute navigate={() => undefined} />
            </BenchContext.Provider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let count = 0; count < 5; count += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    // Today (10) + yesterday (4) = 14. A "This week" that silently excludes
    // today would show 4, which is less than "Runs today" (10) -- the
    // logical impossibility CL-6667 reported.
    expect(container.textContent).toContain("14 runs");
  });
});
