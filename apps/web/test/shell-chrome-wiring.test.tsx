// Regression test for the context-tree bug the coordinator caught in review:
// app.tsx's Shell mounts CommandPaletteProvider and AppShell as siblings, so
// a hook CommandPaletteProvider called (useCloseCanvas) only saw a real
// value if the provider supplying it wrapped BOTH siblings — providers that
// wrapped AppShell's own subtree handed CommandPaletteProvider nothing but
// the context's no-op default. That made the palette's "Close canvas"
// action a silent no-op against the real shell, even though its unit tests
// (command-palette-actions.test.ts) pass, because those tests mock the
// action context directly rather than mounting the provider tree.
//
// ShellChromeProvider owns canvas state above both siblings. This test
// mounts that real tree — no mocked context — and drives the action the
// same way CommandPaletteProvider's handleSelect does: through the real
// `runActionCommand`, sourcing `closeCanvas` from a sibling of AppShell via
// the exact hook CommandPaletteProvider uses. It does not re-test the
// palette's own UI (react-ui's CommandPalette, exercised elsewhere) — the
// bug was in the context tree, not the widget.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AppShell } from "../src/shell/app-shell";
import { BenchProvider } from "../src/bench-context";
import { runActionCommand } from "../src/command-palette-actions";
import { NavigationProvider } from "../src/navigation";
import {
  useCanvasColumnArtifact,
  useCanvasColumnProfile,
  useCanvasColumnRoutine,
  useCloseCanvas,
  useOpenArtifactInCanvas,
  useOpenProfileInCanvas,
  useOpenRoutineInCanvas,
} from "../src/shell/canvas-availability";
import { ProviderHealthProvider } from "../src/shell/provider-health-context";
import { ShellChromeProvider } from "../src/shell/shell-chrome-provider";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;

afterEach(() => {
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia;
});

function stubMatchMedia(matching: Record<string, boolean>): void {
  window.matchMedia = ((media: string) =>
    ({
      media,
      matches: matching[media] ?? false,
      addEventListener: noop,
      removeEventListener: noop,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const emptyMemberships = () =>
  new Response(JSON.stringify({ data: [], nextCursor: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

const sampleProfile = {
  kind: "member" as const,
  address: "ada@example.com",
  handle: "ada",
  displayName: "Ada",
  initials: "AD",
};

/** Stands in for CommandPaletteProvider's position in app.tsx's Shell — a
 * sibling of AppShell, not a descendant — without pulling in the full
 * palette widget. Sources its action context from the same hooks
 * CommandPaletteProvider does, and fires real actions through the real
 * `runActionCommand`. */
function PaletteActionsProbe() {
  const closeCanvas = useCloseCanvas();
  const openProfile = useOpenProfileInCanvas();

  const ctx = {
    path: "/inbox",
    navigate: noop,
    tenantId: null,
    cycleTheme: noop,
    closeCanvas,
  };

  return (
    <div>
      <button
        type="button"
        data-testid="probe-open-profile"
        onClick={() => openProfile(sampleProfile)}
      >
        Open profile
      </button>
      <button
        type="button"
        data-testid="probe-close-canvas"
        onClick={() => void runActionCommand("close-canvas", ctx)}
      >
        Close canvas
      </button>
    </div>
  );
}

function Harness() {
  return (
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <ProviderHealthProvider>
            <ShellChromeProvider path="/inbox" navigate={noop}>
              <PaletteActionsProbe />
              <AppShell path="/inbox" user={user} onSignOut={noop}>
                {"Inbox"}
              </AppShell>
            </ShellChromeProvider>
          </ProviderHealthProvider>
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>
  );
}

describe("palette actions reach the real shell state (CL-5936 sibling-context regression)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia({});
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

  function click(testId: string): void {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (button === null) throw new Error(`${testId} not rendered`);
    button.click();
  }

  test("close-canvas fired from a sibling of AppShell closes a canvas AppShell is showing", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    expect(container.querySelector(".shell-canvas-column")).not.toBeNull();

    await act(async () => {
      click("probe-open-profile");
    });
    expect(
      container.querySelector('.shell-canvas-column[data-open="true"]'),
    ).not.toBeNull();

    await act(async () => {
      click("probe-close-canvas");
    });
    expect(
      container.querySelector('.shell-canvas-column[data-open="true"]'),
    ).toBeNull();
  });
});

const sampleArtifact = {
  id: "art_1",
  title: "Notes",
  rendererKind: "doc" as const,
  content: "hello",
};

/** Reads canvas slots from ShellChromeProvider without mounting AppShell —
 * opening a routine would otherwise pull in RoutinePanel's fetches. Compact
 * layout hides the column but leaves slot state; these probes are the
 * resurrection check. */
function CanvasSlotsProbe() {
  const openProfile = useOpenProfileInCanvas();
  const openArtifact = useOpenArtifactInCanvas();
  const openRoutine = useOpenRoutineInCanvas();
  const profile = useCanvasColumnProfile();
  const artifact = useCanvasColumnArtifact();
  const routine = useCanvasColumnRoutine();

  return (
    <div>
      <button
        type="button"
        data-testid="probe-open-profile"
        onClick={() => openProfile(sampleProfile)}
      >
        Open profile
      </button>
      <button
        type="button"
        data-testid="probe-open-artifact"
        onClick={() => openArtifact(sampleArtifact)}
      >
        Open artifact
      </button>
      <button
        type="button"
        data-testid="probe-open-routine"
        onClick={() => openRoutine({ routineId: null })}
      >
        Open routine
      </button>
      <span data-testid="canvas-profile">
        {profile === null ? "null" : "set"}
      </span>
      <span data-testid="canvas-artifact">
        {artifact === null ? "null" : "set"}
      </span>
      <span data-testid="canvas-routine">
        {routine === null ? "null" : "set"}
      </span>
    </div>
  );
}

function RouteHarness({ path }: { readonly path: string }) {
  return (
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <ProviderHealthProvider>
            <ShellChromeProvider path={path} navigate={noop}>
              <CanvasSlotsProbe />
            </ShellChromeProvider>
          </ProviderHealthProvider>
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>
  );
}

describe("canvas dismisses when in-app nav leaves a rail surface (CL-6819)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia({});
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

  function click(testId: string): void {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (button === null) throw new Error(`${testId} not rendered`);
    button.click();
  }

  function slot(name: "routine" | "profile" | "artifact"): string {
    const el = container.querySelector(`[data-testid="canvas-${name}"]`);
    if (el === null) throw new Error(`canvas-${name} not rendered`);
    return el.textContent?.trim() ?? "";
  }

  async function renderAt(path: string): Promise<void> {
    await act(async () => {
      root.render(<RouteHarness path={path} />);
    });
  }

  test("leaving Routines for Files dismisses the pane", async () => {
    await renderAt("/routines");
    await act(async () => {
      click("probe-open-profile");
    });
    expect(slot("profile")).toBe("set");

    await renderAt("/files");
    expect(slot("profile")).toBe("null");
  });

  test("opening a routine detail under Routines does not dismiss the pane", async () => {
    await renderAt("/routines");
    await act(async () => {
      click("probe-open-profile");
    });
    expect(slot("profile")).toBe("set");

    await renderAt("/routines/rt_1");
    expect(slot("profile")).toBe("set");
  });

  test("query-only changes do not dismiss the pane", async () => {
    await renderAt("/routines?tab=list");
    await act(async () => {
      click("probe-open-profile");
    });
    expect(slot("profile")).toBe("set");

    await renderAt("/routines?tab=runs");
    expect(slot("profile")).toBe("set");
  });

  test("leaving a rail surface dismisses a profile pane", async () => {
    await renderAt("/routines");
    await act(async () => {
      click("probe-open-profile");
    });
    expect(slot("profile")).toBe("set");

    await renderAt("/insights");
    expect(slot("profile")).toBe("null");
  });

  test("leaving a rail surface dismisses an artifact pane", async () => {
    await renderAt("/files");
    await act(async () => {
      click("probe-open-artifact");
    });
    expect(slot("artifact")).toBe("set");

    await renderAt("/insights");
    expect(slot("artifact")).toBe("null");
  });

  test("route dismiss clears canvas state even when compact layout hides the column", async () => {
    stubMatchMedia({ "(max-width: 1099px)": true });
    await renderAt("/routines");
    await act(async () => {
      click("probe-open-profile");
    });
    expect(slot("profile")).toBe("set");

    await renderAt("/insights");
    expect(slot("profile")).toBe("null");
  });
});
