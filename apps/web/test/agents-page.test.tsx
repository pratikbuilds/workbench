// Agents roster (CL-6354, CL-6469): a flat table of every definition a
// bench owns — rows, never cards — with Status/Model/Runs·7d columns and a
// bulk-select bar. `AgentsPage` is the presentational half (same split
// `LibraryPage`/`LibraryRoute` use in `pages.test.tsx`); no live hub here,
// just the render given real-shaped props.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentsPage,
  AgentModelCellView,
  agentModelSettledContent,
  agentRosterStatus,
  agentRunsSettledContent,
  archiveDefinitions,
  archiveResultToast,
  runsInLast7Days,
} from "../src/pages/agents-page";
import type { AgentDefinitionWithDisplayName } from "../src/agents-directory";
import type { AgentInstance } from "../src/agents-api";

// `name` is the immutable kebab identifier (the URL slug); `displayName` is
// what `withDisplayNames` (CL-6413) derives from the definition's
// description (or, absent one, a humanized reading of `name`). The roster
// name slot is displayName only (CL-6748) — the slug stays the URL, not a
// second line under the name.
const triage: AgentDefinitionWithDisplayName = {
  id: "wfd_1",
  tenantId: "tnt_1",
  name: "triage-bot",
  displayName: "Triage bot",
  description: "Sorts inbound issues.",
  currentVersion: "v1",
  status: "deployed",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function instance(
  overrides: Partial<AgentInstance> & { readonly definitionId: string },
): AgentInstance {
  return {
    id: "run_1",
    definitionName: "triage-bot",
    tenantId: "tnt_1",
    address: "run_1@bench",
    status: "running",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-08-20T00:00:00.000Z").getTime();

const noop = () => undefined;

describe("agentRosterStatus", () => {
  test("a stopped definition always reads Archived, regardless of its instances", () => {
    expect(
      agentRosterStatus({ ...triage, status: "stopped" }, [
        instance({ definitionId: "wfd_1", status: "running" }),
      ]),
    ).toBe("archived");
  });

  test("a deployed definition with a running instance reads Running", () => {
    expect(
      agentRosterStatus(triage, [
        instance({ definitionId: "wfd_1", status: "running" }),
      ]),
    ).toBe("running");
  });

  test("a deployed definition with only an erroring instance reads Blocked", () => {
    expect(
      agentRosterStatus(triage, [
        instance({ definitionId: "wfd_1", status: "error" }),
      ]),
    ).toBe("blocked");
  });

  test("a deployed definition with no live instances reads Idle", () => {
    expect(agentRosterStatus(triage, [])).toBe("idle");
  });
});

describe("runsInLast7Days", () => {
  test("counts only this definition's instances created within the trailing week", () => {
    const instances = [
      instance({
        definitionId: "wfd_1",
        createdAt: "2026-08-19T00:00:00.000Z",
      }),
      instance({
        definitionId: "wfd_1",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      instance({
        definitionId: "wfd_other",
        createdAt: "2026-08-19T00:00:00.000Z",
      }),
    ];
    expect(runsInLast7Days("wfd_1", instances, NOW)).toBe(1);
  });
});

describe("agentModelSettledContent (CL-6848)", () => {
  test("a fetch failure is an error, never the same label as an unset model", () => {
    expect(
      agentModelSettledContent(
        {
          status: "error",
          message:
            "Something went wrong loading this agent's model. Try again.",
        },
        [],
      ),
    ).toEqual({
      kind: "error",
      message: "Something went wrong loading this agent's model. Try again.",
    });
    expect(
      agentModelSettledContent(
        {
          status: "ready",
          data: { name: "triage-bot" },
        },
        [],
      ),
    ).toEqual({ kind: "model", label: "Default" });
  });

  test("an unset model stays Default even when the catalog has a tenant default", () => {
    expect(
      agentModelSettledContent(
        {
          status: "ready",
          data: { name: "triage-bot" },
        },
        [{ canonicalName: "claude-sonnet-4", displayName: "Claude Sonnet 4" }],
      ),
    ).toEqual({ kind: "model", label: "Default" });
  });

  test("an unset model stays Default when the catalog winner changes (CL-6782)", () => {
    const unset = {
      status: "ready" as const,
      data: { name: "triage-bot" },
    };
    expect(
      agentModelSettledContent(unset, [
        { canonicalName: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
      ]),
    ).toEqual({ kind: "model", label: "Default" });
    expect(
      agentModelSettledContent(unset, [
        { canonicalName: "claude-haiku-5", displayName: "Claude Haiku 5" },
        { canonicalName: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
      ]),
    ).toEqual({ kind: "model", label: "Default" });
  });

  test("a stored model is unchanged when the catalog default becomes a different winner (CL-6782)", () => {
    const stored = {
      status: "ready" as const,
      data: { name: "triage-bot", model: "claude-sonnet-4" },
    };
    expect(
      agentModelSettledContent(stored, [
        { canonicalName: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
        { canonicalName: "claude-haiku-5", displayName: "Claude Haiku 5" },
      ]),
    ).toEqual({ kind: "model", label: "Claude Sonnet 4" });
    expect(
      agentModelSettledContent(stored, [
        { canonicalName: "claude-haiku-5", displayName: "Claude Haiku 5" },
        { canonicalName: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
      ]),
    ).toEqual({ kind: "model", label: "Claude Sonnet 4" });
  });

  test("a ready model maps to the catalog displayName, not the raw id", () => {
    expect(
      agentModelSettledContent(
        {
          status: "ready",
          data: { name: "triage-bot", model: "claude-sonnet-4" },
        },
        [{ canonicalName: "claude-sonnet-4", displayName: "Claude Sonnet 4" }],
      ),
    ).toEqual({ kind: "model", label: "Claude Sonnet 4" });
  });

  test("a canonical with no catalog displayName is shown as-is, never an invented name", () => {
    expect(
      agentModelSettledContent(
        {
          status: "ready",
          data: { name: "triage-bot", model: "claude-sonnet-4" },
        },
        [],
      ),
    ).toEqual({ kind: "model", label: "claude-sonnet-4" });
  });
});

describe("AgentModelCellView (CL-6848)", () => {
  test("a capabilities fetch error is visually distinct from an unset model", () => {
    const errorMarkup = renderToStaticMarkup(
      <AgentModelCellView
        state={{
          status: "error",
          message:
            "Something went wrong loading this agent's model. Try again.",
        }}
        catalog={[]}
      />,
    );
    const unsetMarkup = renderToStaticMarkup(
      <AgentModelCellView
        state={{
          status: "ready",
          data: { name: "triage-bot" },
        }}
        catalog={[]}
      />,
    );
    expect(errorMarkup).toContain("text-destructive");
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain("loading this agent&#x27;s model");
    expect(errorMarkup).not.toContain("text-muted-foreground");
    expect(unsetMarkup).toContain("Default");
    expect(unsetMarkup).toContain("text-muted-foreground");
    expect(unsetMarkup).not.toContain("text-destructive");
    // The muted em-dash is the absent-value glyph elsewhere on the page —
    // a fetch failure must not reuse it.
    expect(errorMarkup).not.toContain(">—<");
  });

  test("a ready model renders the catalog displayName, not a monospaced id", () => {
    const markup = renderToStaticMarkup(
      <AgentModelCellView
        state={{
          status: "ready",
          data: { name: "triage-bot", model: "claude-sonnet-4" },
        }}
        catalog={[
          { canonicalName: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
        ]}
      />,
    );
    expect(markup).toContain("Claude Sonnet 4");
    expect(markup).not.toContain("claude-sonnet-4");
    expect(markup).not.toContain("font-mono");
  });
});

describe("agentRunsSettledContent (CL-6842)", () => {
  test("a runs fetch failure is not the same as an honest empty history", () => {
    expect(
      agentRunsSettledContent("wfd_1", [], NOW, "Couldn't load run history"),
    ).toEqual({
      kind: "error",
      message: "Couldn't load run history",
    });
    expect(agentRunsSettledContent("wfd_1", [], NOW, null)).toEqual({
      kind: "count",
      value: 0,
    });
  });

  test("a successful fetch still reports the trailing-week count", () => {
    expect(
      agentRunsSettledContent(
        "wfd_1",
        [
          instance({
            definitionId: "wfd_1",
            createdAt: "2026-08-19T00:00:00.000Z",
          }),
        ],
        NOW,
        null,
      ),
    ).toEqual({ kind: "count", value: 1 });
  });
});

describe("archiveDefinitions", () => {
  test("one id failing does not roll back or hide the ids that succeeded", async () => {
    const result = await archiveDefinitions(
      ["wfd_1", "wfd_2", "wfd_3"],
      (id) =>
        id === "wfd_2"
          ? Promise.reject(new Error("504"))
          : Promise.resolve(undefined),
    );
    expect(result.succeededIds).toEqual(["wfd_1", "wfd_3"]);
    expect(result.failedIds).toEqual(["wfd_2"]);
  });

  test("every id succeeding reports no failures", async () => {
    const result = await archiveDefinitions(["wfd_1", "wfd_2"], () =>
      Promise.resolve(undefined),
    );
    expect(result.succeededIds).toEqual(["wfd_1", "wfd_2"]);
    expect(result.failedIds).toEqual([]);
  });

  test("every id failing reports no successes", async () => {
    const result = await archiveDefinitions(["wfd_1", "wfd_2"], () =>
      Promise.reject(new Error("504")),
    );
    expect(result.succeededIds).toEqual([]);
    expect(result.failedIds).toEqual(["wfd_1", "wfd_2"]);
  });
});

describe("archiveResultToast", () => {
  test("reports an honest partial count rather than a blanket success or failure", () => {
    expect(
      archiveResultToast({
        succeededIds: ["a", "b", "c", "d"],
        failedIds: ["e"],
      }),
    ).toBe("Archived 4 of 5 — the rest failed");
  });

  test("reports full success", () => {
    expect(archiveResultToast({ succeededIds: ["a"], failedIds: [] })).toBe(
      "Archived 1 agent",
    );
    expect(
      archiveResultToast({ succeededIds: ["a", "b"], failedIds: [] }),
    ).toBe("Archived 2 agents");
  });

  test("reports full failure", () => {
    expect(archiveResultToast({ succeededIds: [], failedIds: ["a"] })).toBe(
      "Couldn't archive that agent",
    );
    expect(
      archiveResultToast({ succeededIds: [], failedIds: ["a", "b"] }),
    ).toBe("Couldn't archive those agents");
  });
});

describe("AgentsPage", () => {
  test("teaches what will appear once a bench has no agents yet", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain("No agents yet");
  });

  test("renders one row per definition with its display name and Live status, not the slug", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[instance({ definitionId: "wfd_1", status: "running" })]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain("Triage bot");
    expect(markup).not.toContain("triage-bot");
    expect(markup).toContain("Sorts inbound issues.");
    expect(markup).toContain("Live");
    expect(markup).not.toContain("Running");
    // Live carries the live dot (react-ui's StatusDot, `live` prop) —
    // the spec's liveness marker for an actively-running agent.
    expect(markup).toContain('aria-label="Live"');
    // Badge must not shout via CSS uppercase (same as CL-6747 skills).
    expect(markup).toContain("normal-case");
  });

  test("renders a humanized display name for a definition with no description, not its slug", () => {
    const undescribed: AgentDefinitionWithDisplayName = {
      ...triage,
      id: "wfd_undescribed",
      name: "research-analyst",
      displayName: "Research Analyst",
      description: null,
    };
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[undescribed]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain("Research Analyst");
    expect(markup).not.toContain("research-analyst");
  });

  test("selecting a definition links each workbench instance to its own settings Agents tab", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={
          new Map([
            [
              "wfd_1",
              [
                { id: "wb_1", title: "Growth" },
                { id: "wb_2", title: "Support" },
              ],
            ],
          ])
        }
        instances={[]}
        now={NOW}
        selectedId="wfd_1"
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain('href="/w/wb_1/settings/agents"');
    expect(markup).toContain('href="/w/wb_2/settings/agents"');
    expect(markup).toContain(">Growth<");
    expect(markup).toContain(">Support<");
  });

  // CL-6875: the roster's quick-peek panel must hop to the agent's own page
  // at `/agents/<slug>` — panels preview enough to decide whether to open
  // the full page (DESIGN.md), never substitute for one.
  test("selected definition's panel offers a hop to /agents/<slug>", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId="wfd_1"
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain('href="/agents/triage-bot"');
    expect(markup).toContain("Open");
    expect(markup).toContain("Deployed");
    expect(markup).not.toContain(">deployed<");
    expect(markup).not.toContain(">DEPLOYED<");
    expect(markup).toContain("normal-case");
  });

  test("offers New agent as the top-bar create action, per the top-nav page-action contract", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain('aria-label="Create an agent"');
    expect(markup).toContain("New agent");
  });

  test("no create affordance without a resolved bench", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId={null}
        definitions={[]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).not.toContain('aria-label="Create an agent"');
  });

  test("carries a selection checkbox per row and a header select-all, but no bulk bar with nothing selected", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain('aria-label="Select all agents"');
    expect(markup).toContain('aria-label="Select Triage bot"');
    // BulkActionBar renders nothing at count 0 — none of its labels should
    // leak into the page while nothing is selected.
    expect(markup).not.toContain("Duplicate");
    expect(markup).not.toContain("Move");
    expect(markup).not.toContain("Delete");
    expect(markup).not.toContain("data-bulk-action");
  });

  test("CL-6836: skillsError is an alert, never silent 'no skills'", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
        skillsError="500: down"
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not load agent skills");
    expect(markup).toContain("500: down");
  });

  test("CL-6836: without skillsError, the skills failure alert is absent", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).not.toContain("Could not load agent skills");
  });

  test("an honest empty run history shows 0, not a load-failure marker (CL-6842)", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain("Idle");
    expect(markup).toContain(">0<");
    expect(markup).not.toContain("Couldn't load run history");
  });

  test("a runs fetch failure is distinguishable from zero instances (CL-6842)", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        instancesError="Something went wrong loading run history. Try again."
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain("text-destructive");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      "Something went wrong loading run history. Try again.",
    );
    // Must not claim an Idle status or a literal zero off fabricated empty
    // instances — that is the dishonest path `runsQuery.data ?? []` produced.
    expect(markup).not.toContain("Idle");
    expect(markup).not.toContain(">0<");
  });
});
