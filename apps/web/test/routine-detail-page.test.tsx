// `/routines/<definitionId>`: a scheduled definition's own page — name,
// cron sentence, pause, run now. The id is the definition id.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { NavigationProvider } from "../src/navigation";
import {
  resolveRoutineSegment,
  RoutineDetailPage,
} from "../src/pages/routine-detail-page";
import type { GlobalRoutineRow } from "../src/global-routines";
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

const pageProps = {
  onRunNow: () => Promise.resolve(),
  onToggleEnabled: (_enabled: boolean) => {},
};

function renderPage(overrides: Partial<GlobalRoutineRow> = {}): string {
  return renderToStaticMarkup(
    <NavigationProvider navigate={noop}>
      <RoutineDetailPage row={row(overrides)} {...pageProps} />
    </NavigationProvider>,
  );
}

describe("RoutineDetailPage", () => {
  test("titles itself with a trail back to the roster", () => {
    const markup = renderPage();
    expect(markup).toContain('href="/routines"');
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Acme Team");
  });

  test("the schedule reads as a sentence, never the raw cron", () => {
    const markup = renderPage();
    expect(markup).not.toContain("0 9 * * *");
    expect(markup).not.toContain("Cron expression");
  });

  test("an enabled routine offers Pause; a stopped one offers Resume", () => {
    expect(renderPage()).toContain("Pause");
    expect(
      renderPage({
        definition: { ...definition, status: "stopped" },
      }),
    ).toContain("Resume");
  });

  test("Run now and Pause both sit in the top bar's action slot", () => {
    const markup = renderPage();
    const actions = markup.slice(
      markup.indexOf('data-testid="stage-top-bar-actions"'),
    );
    expect(actions).toContain("Run now");
    expect(actions).toContain("Pause");
  });

  test("there is no Edit or create affordance", () => {
    const markup = renderPage();
    expect(markup).not.toContain("Edit");
    expect(markup).not.toContain("New routine");
  });
});

describe("RoutineDetailPage lifecycle actions", () => {
  function mount(
    props: Partial<typeof pageProps> = {},
    overrides: Partial<GlobalRoutineRow> = {},
  ): { container: HTMLDivElement; root: Root } {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(NavigationProvider, {
          navigate: noop,
          children: createElement(RoutineDetailPage, {
            row: row(overrides),
            ...pageProps,
            ...props,
          }),
        }),
      );
    });
    return { container, root };
  }

  function clickButton(container: HTMLElement, label: string): void {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(button).not.toBeUndefined();
    act(() => {
      button?.click();
    });
  }

  test("Pause asks for the routine to be disabled", () => {
    const calls: boolean[] = [];
    const { container, root } = mount({
      onToggleEnabled: (enabled: boolean) => calls.push(enabled),
    });
    try {
      clickButton(container, "Pause");
      expect(calls).toEqual([false]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("Resume asks for a paused routine to be enabled again", () => {
    const calls: boolean[] = [];
    const { container, root } = mount(
      { onToggleEnabled: (enabled: boolean) => calls.push(enabled) },
      { definition: { ...definition, status: "stopped" } },
    );
    try {
      clickButton(container, "Resume");
      expect(calls).toEqual([true]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("Run now triggers the run-now mutation", () => {
    let runs = 0;
    const { container, root } = mount({
      onRunNow: () => {
        runs += 1;
        return Promise.resolve();
      },
    });
    try {
      clickButton(container, "Run now");
      expect(runs).toBe(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("resolveRoutineSegment", () => {
  const mine = row();
  const theirs = row({
    definition: {
      ...definition,
      definitionId: "wfd_2",
      name: "Evening brief",
      tenantId: "tnt_2",
    },
    tenantId: "tnt_2",
    tenantName: "Beta Team",
  });

  test("an id renders the page directly", () => {
    expect(resolveRoutineSegment([mine, theirs], "wfd_1")).toEqual(mine);
  });

  test("a name is not an address", () => {
    expect(resolveRoutineSegment([mine], "morning-brief")).toBeUndefined();
  });

  test("an unknown id is gone", () => {
    expect(resolveRoutineSegment([mine], "wfd_nope")).toBeUndefined();
  });
});

describe("RoutineDetailRoute", () => {
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
      definitionId: "wfd_mine",
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
  ];

  function mockFetch(
    itemsByTenant: Record<string, Record<string, unknown>[]>,
  ): typeof fetch {
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

  async function renderRoute(
    segment: string,
    itemsByTenant: Record<string, Record<string, unknown>[]>,
  ): Promise<{ container: HTMLDivElement; root: Root }> {
    const { BenchProvider } = await import("../src/bench-context");
    const { RoutineDetailRoute } =
      await import("../src/pages/routine-detail-page");
    const { TestQueryProvider } = await import("./test-query-provider");

    globalThis.fetch = mockFetch(itemsByTenant);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              {createElement(RoutineDetailRoute, { segment })}
            </BenchProvider>
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

  const realFetch = globalThis.fetch;

  function cleanup(container: HTMLDivElement, root: Root): void {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  }

  test("an id renders the scheduled workflow itself", async () => {
    const { container, root } = await renderRoute("wfd_mine", {
      tnt_1: [scheduledRecord({ definitionId: "wfd_mine", name: "My digest" })],
    });
    try {
      expect(container.textContent).toContain("My digest");
      expect(container.textContent).toContain("Acme Team");
      expect(container.textContent).not.toContain("0 9 * * *");
    } finally {
      cleanup(container, root);
    }
  });

  test("an unknown id says no scheduled workflow matches", async () => {
    const { container, root } = await renderRoute("wfd_deleted", {
      tnt_1: [scheduledRecord({ definitionId: "wfd_mine", name: "My digest" })],
    });
    try {
      expect(container.textContent).toContain(
        "No scheduled workflow matches this address.",
      );
      expect(container.textContent).toContain("Back to Routines");
    } finally {
      cleanup(container, root);
    }
  });
});
