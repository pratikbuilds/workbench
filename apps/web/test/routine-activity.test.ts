// CL-6595: the shell's "Running" section and Mission Control's active-run
// count both read `listRoutineActivity`, which must source the `feed=fires`
// listing — the one top-level-runs view that keeps a routine's fire (see
// `@corbits/folded-runs`'s `scope-routes.ts`). The plain `listTopLevelRuns`
// feed excludes every folded run, and a routine fire IS a folded run, so a
// routine genuinely running would never appear here at all -- Mission
// Control would read "0 active" while the Routines page's own "Running
// now" pill (driven by the same run's `workflow_run.status`) disagreed.

import { afterEach, describe, expect, test } from "bun:test";

import { FIRE_RUNNING_WINDOW_MS } from "@corbits/workflows/client";

import { listRoutineActivity } from "../src/shell/routine-activity";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

let lastRequestedPath: string | null = null;

function stubTopLevelRunsFetch(runs: readonly unknown[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    lastRequestedPath = typeof input === "string" ? input : input.toString();
    return Promise.resolve(
      new Response(JSON.stringify({ data: runs, nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

const runningFire = {
  id: "run_1",
  definitionId: "wfd_1",
  definitionName: "Weekly digest",
  tenantId: "tnt_1",
  address: "run_1@tnt1.example",
  status: "running",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  routineId: "rtn_1",
  routineName: "Weekly digest",
};

const completedFire = {
  ...runningFire,
  id: "run_2",
  status: "stopped",
  routineId: "rtn_1",
};

const nonRoutineFire = {
  id: "run_3",
  definitionId: "wfd_2",
  definitionName: "Directly triggered deployment",
  tenantId: "tnt_1",
  address: "run_3@tnt1.example",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  routineId: null,
  routineName: null,
};

describe("listRoutineActivity", () => {
  test("reads the fires feed, not the plain top-level-runs feed", async () => {
    stubTopLevelRunsFetch([runningFire]);
    await listRoutineActivity("tnt_1");
    expect(lastRequestedPath).toContain("feed=fires");
  });

  test("maps a running routine fire into a routine activity item", async () => {
    stubTopLevelRunsFetch([runningFire]);

    const items = await listRoutineActivity("tnt_1");

    expect(items).toEqual([
      {
        id: "run_1",
        name: "Weekly digest",
        status: "running",
        startedAt: runningFire.createdAt,
      },
    ]);
  });

  // The bug this ticket reports: a run that genuinely finished must not
  // keep counting toward "active" just because it once fired. Mission
  // Control's active-run count filters on `status === "running"`, so this
  // item leaving that status here is what makes the two surfaces agree.
  test("a completed routine fire no longer reads as running", async () => {
    stubTopLevelRunsFetch([completedFire]);

    const [item] = await listRoutineActivity("tnt_1");

    expect(item?.status).not.toBe("running");
  });

  test("endedAt drops a just-finished running fire from running immediately", async () => {
    stubTopLevelRunsFetch([
      {
        ...runningFire,
        endedAt: new Date().toISOString(),
      },
    ]);

    const [item] = await listRoutineActivity("tnt_1");

    expect(item?.status).not.toBe("running");
  });

  // A live fire still in a tool loop can outlast the abandoned-fire
  // window. Persist has not settled, so the row stays running.
  test("a live running fire past the window still reads as running", async () => {
    stubTopLevelRunsFetch([
      {
        ...runningFire,
        createdAt: new Date(
          Date.now() - FIRE_RUNNING_WINDOW_MS - 1,
        ).toISOString(),
      },
    ]);

    const [item] = await listRoutineActivity("tnt_1");

    expect(item?.status).toBe("running");
  });

  // A directly-triggered deployment run is also a `feed=fires` row (it is
  // not a folded run at all), but it has no routine parent -- it must not
  // be counted as routine activity.
  test("drops a fires-feed row with no routine parent", async () => {
    stubTopLevelRunsFetch([nonRoutineFire]);
    expect(await listRoutineActivity("tnt_1")).toEqual([]);
  });

  test("an empty run list is an empty routine list", async () => {
    stubTopLevelRunsFetch([]);
    expect(await listRoutineActivity("tnt_1")).toEqual([]);
  });
});
