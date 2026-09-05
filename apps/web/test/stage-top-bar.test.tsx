// The shared stage top bar: breadcrumb trail · dot · subtitle, right-aligned page
// actions, and breadcrumb trails in the title slot. It carries no sidebar
// control of any kind — the sidebar is always present and has no collapse
// affordance. This file covers StageTopBar's own markup plus the frame-level
// invariant that the sidebar mounts on every render of AppShell.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { AppShell } from "../src/shell/app-shell";
import { ProviderHealthProvider } from "../src/shell/provider-health-context";
import { ShellChromeProvider } from "../src/shell/shell-chrome-provider";
import { StageTopBar } from "../src/shell/stage-top-bar";
import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;

afterEach(() => {
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia;
});

describe("StageTopBar", () => {
  test("renders title, dot, subtitle, and actions", () => {
    const markup = renderToStaticMarkup(
      <StageTopBar
        crumbs={[{ label: "Inbox" }]}
        subtitle="2 need action · 5 open"
        actions={<button type="button">Mark all read</button>}
      />,
    );
    expect(markup).toContain("Inbox");
    expect(markup).toContain("stage-top-bar-dot");
    expect(markup).toContain("2 need action · 5 open");
    expect(markup).toContain("Mark all read");
  });

  test("omits the dot when there is no subtitle", () => {
    const markup = renderToStaticMarkup(
      <StageTopBar crumbs={[{ label: "Skills" }]} />,
    );
    expect(markup).not.toContain("stage-top-bar-dot");
    expect(markup).not.toContain("stage-top-bar-sub");
  });

  test("carries no sidebar toggle of its own", () => {
    const markup = renderToStaticMarkup(
      <StageTopBar crumbs={[{ label: "Library" }]} />,
    );
    expect(markup).not.toContain('aria-label="Toggle sidebar"');
    expect(markup).not.toContain('aria-label="Collapse sidebar"');
  });

  test("an interactive subtitle is not clipped by overflow hidden", () => {
    const css = readFileSync(
      new URL("../src/app.css", import.meta.url),
      "utf8",
    );
    const interactive = css
      .split("}")
      .find((candidate) =>
        candidate.includes(".stage-top-bar-sub:has(button)"),
      );
    expect(interactive).toBeDefined();
    expect(interactive).toContain("overflow: visible");
    expect(interactive).toContain("flex-shrink: 0");
  });
});

type StubQuery = {
  media: string;
  matches: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

function stubMatchMedia(matching: Record<string, boolean>): void {
  window.matchMedia = ((media: string): MediaQueryList => {
    const query: StubQuery = {
      media,
      matches: matching[media] ?? false,
      addEventListener: noop,
      removeEventListener: noop,
    };
    return query as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

const emptyMemberships = () =>
  new Response(JSON.stringify({ data: [], nextCursor: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

function ShellHarness({ path = "/inbox" }: { readonly path?: string }) {
  return (
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <ProviderHealthProvider>
            <ShellChromeProvider path={path} navigate={noop}>
              <AppShell path={path} user={user} onSignOut={noop}>
                <StageTopBar crumbs={[{ label: "Inbox" }]} />
              </AppShell>
            </ShellChromeProvider>
          </ProviderHealthProvider>
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>
  );
}

describe("shell frame", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(emptyMemberships())) as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("the sidebar is always present, with no collapse affordance", async () => {
    stubMatchMedia({});
    await act(async () => {
      root.render(<ShellHarness />);
    });

    expect(
      container.querySelector('[data-testid="shell-sidebar"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Collapse sidebar"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Expand sidebar"]'),
    ).toBeNull();
  });

  test("the sidebar stays across navigation", async () => {
    stubMatchMedia({});
    await act(async () => {
      root.render(<ShellHarness path="/inbox" />);
    });
    await act(async () => {
      root.render(<ShellHarness path="/routines" />);
    });
    expect(
      container.querySelector('[data-testid="shell-sidebar"]'),
    ).not.toBeNull();
  });
});
