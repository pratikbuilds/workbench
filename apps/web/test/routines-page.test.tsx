// Screen-level proof for the global Routines page: scheduled workflow
// definitions across every bench the account belongs to — including
// paused (`stopped`) ones. Schedule reads as a sentence, Pause is a
// switch, there is no create path.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  GlobalRoutinesList,
  scheduleSentence,
} from "../src/pages/routines-page";
import type { GlobalRoutineRow } from "../src/pages/routines-page";
import { NavigationProvider } from "../src/navigation";
import type { ScheduledWorkflowDefinition } from "../src/routines-api";

const noop = () => undefined;

const definition: ScheduledWorkflowDefinition = {
  definitionId: "wfd_1",
  assetId: "ast_1",
  name: "Morning brief",
  tenantId: "tnt_1",
  status: "deployed",
  cron: "0 9 * * *",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function row(overrides: Partial<GlobalRoutineRow> = {}): GlobalRoutineRow {
  return {
    definition,
    tenantId: "tnt_1",
    tenantName: "Acme Team",
    ...overrides,
  };
}

const listProps = {
  onToggleEnabled: (_row: GlobalRoutineRow, _enabled: boolean) => {},
  onRunNow: (_row: GlobalRoutineRow) => Promise.resolve(),
};

function renderList(rows: readonly GlobalRoutineRow[]): string {
  return renderToStaticMarkup(
    <NavigationProvider navigate={noop}>
      <GlobalRoutinesList rows={rows} {...listProps} />
    </NavigationProvider>,
  );
}

describe("scheduleSentence", () => {
  test("humanizes the cadence and never prints the raw expression", () => {
    const sentence = scheduleSentence("0 9 * * *");
    expect(sentence).not.toBe("0 9 * * *");
    expect(sentence).not.toMatch(/\d+ \d+ \* \* \*/);
    expect(sentence.length).toBeGreaterThan(3);
  });

  test("a weekday cron still reads as a sentence", () => {
    const sentence = scheduleSentence("0 9 * * 1-5");
    expect(sentence).toContain("Monday through Friday");
    expect(sentence).not.toContain("1-5");
  });
});

describe("GlobalRoutinesList", () => {
  test("says there are no scheduled workflows yet when the list is empty", () => {
    expect(renderList([])).toContain("No scheduled workflows yet");
  });

  test("a row carries the name, tenant, schedule sentence, on/off switch, and run now", () => {
    const markup = renderList([row()]);
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Acme Team");
    expect(markup).not.toContain("0 9 * * *");
    expect(markup).toContain('role="switch"');
    expect(markup).toContain("On Morning brief");
    expect(markup).toContain("Run now");
  });

  test("the routine's name links to its own page by definition id", () => {
    const markup = renderList([row()]);
    expect(markup).toContain('href="/routines/wfd_1"');
    expect(markup).not.toContain('href="/routines/morning-brief"');
  });

  test("a stopped definition still appears, with Off on the switch", () => {
    const markup = renderList([
      row({
        definition: { ...definition, status: "stopped", name: "Paused digest" },
      }),
    ]);
    expect(markup).toContain("Paused digest");
    expect(markup).toContain("Off Paused digest");
    expect(markup).toContain("Run now");
  });

  test("there is no Plus or create affordance", () => {
    const markup = renderList([row()]);
    expect(markup).not.toContain("New routine");
    expect(markup).not.toContain("Create");
    expect(markup).not.toContain("Plus");
  });

  test("the On switch is named On, not Pause, while the routine is enabled", () => {
    const markup = renderList([row()]);
    expect(markup).toContain('aria-label="On Morning brief"');
    expect(markup).not.toContain('aria-label="Pause Morning brief"');
  });

  test("the On switch is named Off when the routine is disabled", () => {
    const markup = renderList([
      row({ definition: { ...definition, status: "stopped" } }),
    ]);
    expect(markup).toContain('aria-label="Off Morning brief"');
    expect(markup).not.toContain('aria-label="Resume Morning brief"');
  });

  test("Run now calls onRunNow with the row", async () => {
    const calls: GlobalRoutineRow[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(GlobalRoutinesList, {
            rows: [row()],
            ...listProps,
            onRunNow: (r: GlobalRoutineRow) => {
              calls.push(r);
              return Promise.resolve();
            },
          }),
        }),
      );
    });
    try {
      const runButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Run now",
      );
      expect(runButton).not.toBeUndefined();
      act(() => {
        runButton?.click();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.definition.definitionId).toBe("wfd_1");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("the On switch calls onToggleEnabled with the flipped value", () => {
    const calls: [GlobalRoutineRow, boolean][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(GlobalRoutinesList, {
            rows: [row()],
            ...listProps,
            onToggleEnabled: (r: GlobalRoutineRow, enabled: boolean) => {
              calls.push([r, enabled]);
            },
          }),
        }),
      );
    });
    try {
      const toggle = container.querySelector('button[role="switch"]');
      expect(toggle).not.toBeNull();
      act(() => {
        (toggle as HTMLButtonElement).click();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("RoutinesRoute — membership-based aggregation", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function scheduledRecord(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      definitionId: "wfd_1",
      assetId: "ast_1",
      name: "My digest",
      tenantId: "tnt_1",
      status: "deployed",
      cron: "0 9 * * *",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  const memberships = [
    {
      principalId: "prn_me",
      tenantId: "tnt_1",
      tenantName: "Acme Team",
      tenantSlug: "acme",
      kind: "user",
      status: "active",
      roles: [],
    },
    {
      principalId: "prn_me_2",
      tenantId: "tnt_2",
      tenantName: "Beta Team",
      tenantSlug: "beta",
      kind: "user",
      status: "active",
      roles: [],
    },
  ];

  const itemsByTenant: Record<string, Record<string, unknown>[]> = {
    tnt_1: [
      scheduledRecord({
        definitionId: "wfd_mine",
        name: "My digest",
        tenantId: "tnt_1",
      }),
      scheduledRecord({
        definitionId: "wfd_paused",
        name: "Paused digest",
        tenantId: "tnt_1",
        status: "stopped",
      }),
    ],
    tnt_2: [
      scheduledRecord({
        definitionId: "wfd_theirs",
        name: "Their digest",
        tenantId: "tnt_2",
      }),
    ],
  };

  function mockFetch(): typeof fetch {
    return (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/me/principals")) {
        return jsonResponse({ data: memberships, nextCursor: null });
      }
      if (url.includes("/api/workbench-tenancies/kinds")) {
        return jsonResponse({ workbenchTenantIds: [] });
      }
      const scheduledMatch = url.match(
        /\/api\/tenants\/([^/]+)\/workflows\/scheduled$/,
      );
      if (scheduledMatch) {
        return jsonResponse({
          items: itemsByTenant[scheduledMatch[1] as string] ?? [],
        });
      }
      if (url.includes("/chat/workbenches") && url.includes("kind=workbench")) {
        return jsonResponse({ items: [] });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch;
  }

  async function renderRoute(): Promise<{
    container: HTMLDivElement;
    root: Root;
  }> {
    const { BenchProvider } = await import("../src/bench-context");
    const { RoutinesRoute } = await import("../src/pages/routines-page");
    const { TestQueryProvider } = await import("./test-query-provider");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>{createElement(RoutinesRoute)}</BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    return { container, root };
  }

  test("lists scheduled definitions from every bench, including stopped ones", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mockFetch();
    const { container, root } = await renderRoute();
    try {
      expect(container.textContent).toContain("My digest");
      expect(container.textContent).toContain("Their digest");
      expect(container.textContent).toContain("Paused digest");
      expect(container.textContent).toContain("Acme Team");
      expect(container.textContent).toContain("Beta Team");
      expect(container.querySelector('button[role="switch"]')).not.toBeNull();
      expect(container.textContent).not.toContain("New routine");
      expect(container.textContent).not.toContain("0 9 * * *");
    } finally {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
      window.localStorage.clear();
    }
  });

  test("each row links to its definition by id — the address a rename cannot break", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mockFetch();
    const { container, root } = await renderRoute();
    try {
      const hrefs = [...container.querySelectorAll("a")].map((a) =>
        a.getAttribute("href"),
      );
      expect(hrefs).toContain("/routines/wfd_mine");
      expect(hrefs).toContain("/routines/wfd_theirs");
      expect(hrefs).toContain("/routines/wfd_paused");
      expect(hrefs).not.toContain("/routines/my-digest");
    } finally {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
      window.localStorage.clear();
    }
  });
});
