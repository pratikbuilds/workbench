// The canvas profile card's Message action: no silent no-op when there is
// no bench to message against, and the panel never closes ahead of the DM
// actually resolving — matching the toast-on-unable pattern the sibling
// Mention action already used (CL-6019).

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { spyOnReactUiToast } from "./react-ui-toast-mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const toastMock = spyOnReactUiToast();

let ensureProfileDmResult: Promise<
  { kind: "ready"; workbenchId: string } | { kind: "error"; message: string }
> = Promise.resolve({ kind: "ready", workbenchId: "chn_dm" });

mock.module("../src/profile-relations", () => ({
  ensureProfileDm: mock(() => ensureProfileDmResult),
  loadSharedWorkbenches: mock(() => Promise.resolve([])),
}));

const { BenchProvider } = await import("../src/bench-context");
const { NavigationProvider } = await import("../src/navigation");
const { CanvasColumn } = await import("../src/shell/canvas-column");
const { TestQueryProvider } = await import("./test-query-provider");

const noop = () => undefined;
const realFetch = globalThis.fetch;

const membership = {
  principalId: "prn_1",
  tenantId: "tnt_1",
  tenantName: "Test Bench",
  tenantSlug: "test-bench",
  kind: "user",
  status: "active",
  roles: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function routeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("/api/me/principals")) {
    return Promise.resolve(
      jsonResponse({ data: [membership], nextCursor: null }),
    );
  }
  if (url.includes("/api/workbench-tenancies/kinds")) {
    return Promise.resolve(jsonResponse({ workbenchTenantIds: [] }));
  }
  return Promise.reject(
    new Error(`unrouted fetch in canvas-column test: ${url}`),
  );
}

const profile = {
  kind: "member" as const,
  address: "user:ada",
  handle: "ada",
  displayName: "Ada Lovelace",
  initials: "AL",
};

describe("canvas profile card Message action", () => {
  let container: HTMLDivElement;
  let root: Root;
  let navigated: string[];
  let closed: boolean;

  beforeEach(() => {
    globalThis.fetch = routeFetch as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    navigated = [];
    closed = false;
    toastMock.mockClear();
    ensureProfileDmResult = Promise.resolve({
      kind: "ready",
      workbenchId: "chn_dm",
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  });

  async function renderPanel(): Promise<void> {
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={(to) => navigated.push(to)}>
            <BenchProvider>
              <CanvasColumn
                open
                profile={profile}
                artifact={null}
                routine={null}
                focus={false}
                onClose={() => {
                  closed = true;
                }}
                onToggleFocus={noop}
                onNavigate={(to) => navigated.push(to)}
              />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    // Let BenchProvider's membership fetch (and, once it resolves, the
    // workbench-tenancy-kinds follow-up) actually settle before interacting —
    // a button exists from the very first render regardless, so presence
    // alone can't gate this.
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function messageButton(): HTMLButtonElement {
    // "Message" and its pending state "Messaging…" share the "Messag" stem —
    // matching that (rather than "Message" itself) covers both without also
    // catching "Mention".
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.startsWith("Messag") === true,
    );
    if (button === undefined) throw new Error("Message button not found");
    return button;
  }

  test("stays open and shows a pending label while the DM is being resolved, then closes and navigates once it's ready", async () => {
    let resolveDm: (value: {
      kind: "ready";
      workbenchId: string;
    }) => void = () => undefined;
    ensureProfileDmResult = new Promise((resolve) => {
      resolveDm = resolve;
    });
    await renderPanel();

    await act(async () => {
      messageButton().click();
    });

    expect(closed).toBe(false);
    expect(messageButton().textContent).toBe("Messaging…");

    await act(async () => {
      resolveDm({ kind: "ready", workbenchId: "chn_dm" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigated).toContain("/w/chn_dm");
    expect(closed).toBe(true);
  });

  test("surfaces a toast and keeps the panel open instead of closing when the DM can't be created", async () => {
    ensureProfileDmResult = Promise.resolve({
      kind: "error",
      message: "No running agent found for @ada.",
    });
    await renderPanel();

    await act(async () => {
      messageButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toastMock).toHaveBeenCalledWith("No running agent found for @ada.");
    expect(closed).toBe(false);
    expect(navigated).toEqual([]);
  });

  test("with no bench resolved yet, Message toasts honestly instead of silently closing", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(
        new Error("no bench resolves in this test"),
      )) as typeof fetch;
    await renderPanel();

    await act(async () => {
      messageButton().click();
    });

    expect(toastMock).toHaveBeenCalledWith("Open a workbench to message @ada");
    expect(closed).toBe(false);
    expect(navigated).toEqual([]);
  });
});

describe("canvas artifact pane: co-editing (CL-5958 phase 2)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.fetch = routeFetch as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  });

  async function renderArtifact(props: {
    readonly artifact: {
      readonly id: string;
      readonly title: string;
      readonly rendererKind: "doc" | "sheet" | "pdf" | "unsupported";
      readonly content: string;
      readonly canEdit?: boolean;
    };
    readonly artifactDoc?: import("yjs").Doc;
    readonly presenceConnection?: "ok" | "degraded";
  }): Promise<void> {
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <CanvasColumn
                open
                profile={null}
                artifact={props.artifact}
                routine={null}
                focus={false}
                onClose={noop}
                onToggleFocus={noop}
                onNavigate={noop}
                {...(props.artifactDoc !== undefined
                  ? { artifactDoc: props.artifactDoc }
                  : {})}
                {...(props.presenceConnection !== undefined
                  ? { presenceConnection: props.presenceConnection }
                  : {})}
              />
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
  }

  test("a non-'doc' kind never renders the text editor, even with canEdit and a doc", async () => {
    const Y = await import("yjs");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "sheet content");
    await renderArtifact({
      artifact: {
        id: "art_1",
        title: "Numbers",
        rendererKind: "sheet",
        content: "a,b\n1,2",
        canEdit: true,
      },
      artifactDoc: doc,
    });

    expect(container.querySelector("textarea")).toBeNull();
  });

  test("a 'doc' artifact with canEdit and a synced doc renders an editable textarea bound to the Y.Text", async () => {
    const Y = await import("yjs");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "shared draft");
    await renderArtifact({
      artifact: {
        id: "art_2",
        title: "Notes",
        rendererKind: "doc",
        content: "stale fetch content",
        canEdit: true,
      },
      artifactDoc: doc,
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("shared draft");
    expect(textarea?.hasAttribute("readonly")).toBe(false);
  });

  test("a 'doc' artifact without canEdit renders the same textarea, but readonly and live-updating", async () => {
    const Y = await import("yjs");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "live from co-editors");
    await renderArtifact({
      artifact: {
        id: "art_3",
        title: "Notes",
        rendererKind: "doc",
        content: "stale fetch content",
        canEdit: false,
      },
      artifactDoc: doc,
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("live from co-editors");
    expect(textarea?.hasAttribute("readonly")).toBe(true);
  });

  test("typing in the editable textarea applies the diff to the shared Y.Text", async () => {
    const Y = await import("yjs");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello");
    await renderArtifact({
      artifact: {
        id: "art_4",
        title: "Notes",
        rendererKind: "doc",
        content: "hello",
        canEdit: true,
      },
      artifactDoc: doc,
    });

    const textarea = container.querySelector("textarea");
    if (textarea === null) throw new Error("textarea not found");

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeSetter?.call(textarea, "hello world");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(doc.getText("content").toString()).toBe("hello world");
  });

  test("a 'doc' artifact with no synced doc yet falls back to the static read-only renderer", async () => {
    await renderArtifact({
      artifact: {
        id: "art_5",
        title: "Notes",
        rendererKind: "doc",
        content: "fetched content",
        canEdit: true,
      },
    });

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("fetched content");
  });

  test("a degraded presence connection shows a quiet reconnecting caption", async () => {
    await renderArtifact({
      artifact: {
        id: "art_6",
        title: "Notes",
        rendererKind: "doc",
        content: "fetched content",
      },
      presenceConnection: "degraded",
    });

    expect(container.textContent).toContain("Reconnecting…");
  });

  test("a healthy presence connection shows no reconnecting caption", async () => {
    await renderArtifact({
      artifact: {
        id: "art_7",
        title: "Notes",
        rendererKind: "doc",
        content: "fetched content",
      },
      presenceConnection: "ok",
    });

    expect(container.textContent).not.toContain("Reconnecting…");
  });
});
