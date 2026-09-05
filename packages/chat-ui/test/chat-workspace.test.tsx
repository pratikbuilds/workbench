// Composition tests for `ChatWorkspace`'s settings-surface wiring: it
// mounts against a registered DOM (see dom-setup.ts) because these prove
// real effect-driven sequencing — the two-step "workbenches resolve, then the
// settings surface renders" load a direct `/c/:id/settings` URL drives —
// which static markup rendering cannot exercise.
//
// Stubs `global.fetch` the same way test/api.test.ts does (never
// `mock.module`, which would replace `../src/api` for every test file in
// this run, not just this one) and a minimal `EventSource` stand-in so the
// workbench stream's connect attempt has something to call.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

class StubEventSource {
  static instances: StubEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  StubEventSource.instances = [];
});

const WORKBENCH_WIRE = {
  id: "ch_1",
  title: "Launch Planning",
  kind: "workbench",
  pinned: false,
  participants: [] as { address: string; handle: string }[],
};

type WorkbenchAgentFixture = {
  readonly address: string;
  readonly handle: string;
  readonly definitionId: string;
  readonly definitionAssetId: string;
  readonly displayName: string;
};

function stubFetch(
  sentMessages?: unknown[],
  workbench: typeof WORKBENCH_WIRE = WORKBENCH_WIRE,
  options: {
    readonly turnsFail?: boolean;
    readonly workbenchAgents?: readonly WorkbenchAgentFixture[];
  } = {},
) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
      return json({ items: [workbench] });
    }
    if (/\/chat\/workbenches\?kind=chat$/.test(path))
      return json({ items: [] });
    if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
      return json({ rootThreadId: "", items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
      if (init?.method === "POST") {
        sentMessages?.push(JSON.parse(String(init.body)));
        return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
      }
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/agents$/.test(path)) {
      return json({ items: options.workbenchAgents ?? [] });
    }
    // CL-6380 catch-up: empty list = nothing running. Returning this by
    // default keeps agent-participant mounts from treating an unstubbed
    // turns path as a resume failure (CL-6833).
    if (/\/chat\/workbenches\/[^/]+\/turns(?:\/|$|\?)/.test(path)) {
      if (options.turnsFail === true) {
        return new Response(JSON.stringify({ error: "turns unavailable" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
      return json({
        ...workbench,
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

const { ChatWorkspace } = await import("../src/chat-workspace");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function firstStream(): StubEventSource {
  const instance = StubEventSource.instances[0];
  if (instance === undefined) throw new Error("no EventSource was opened");
  return instance;
}

const textareaValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)?.set;
if (textareaValueSetter === undefined) {
  throw new Error("HTMLTextAreaElement.prototype.value has no native setter");
}
const setTextareaValue = textareaValueSetter;

// `root.render` only starts the query client's fetches; their promises
// settle on later microtasks that a synchronous `act(() => {...})` never
// waits for, so the state updates those fetches drive would otherwise land
// outside any `act` call. Awaiting an async `act` here flushes that
// microtask queue before `mount` (and every `test(...)` that awaits it)
// hands control back to the caller.
async function mount(props: Parameters<typeof ChatWorkspace>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ChatWorkspace, props),
      ),
    );
  });
  return {
    container,
    settle: () => act(() => sleep(30)),
    unmount: () => root.unmount(),
    rerender: (nextProps: Parameters<typeof ChatWorkspace>[0]) =>
      act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(ChatWorkspace, nextProps),
          ),
        );
      }),
  };
}

describe("ChatWorkspace settings surface", () => {
  test("a direct /c/:id/settings URL renders the settings surface once workbenches resolve", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      settingsOpen: true,
    });
    await harness.settle();

    expect(
      harness.container.querySelector(".workbench-settings-stage"),
    ).not.toBeNull();
    expect(harness.container.textContent).toContain("Launch Planning");
    harness.unmount();
  });

  test("settingsOpen for a workbench id that 404s closes settings and shows not-found, never room chrome", async () => {
    // Authoritative miss is the messages/workbench fetch 404 — not mere
    // absence from a ready list (that alone is the create→navigate stale-
    // cache race CL-6796 must not treat as gone).
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;
    const settingsOpenChanges: boolean[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_missing",
      settingsOpen: true,
      onSettingsOpenChange: (open: boolean) => settingsOpenChanges.push(open),
      onGoToMissionControl: () => undefined,
      onNewWorkbench: () => undefined,
    });
    await harness.settle();

    expect(
      harness.container.querySelector(".workbench-settings-stage"),
    ).toBeNull();
    expect(settingsOpenChanges).toEqual([false]);
    expect(harness.container.textContent).toContain(
      "This workbench isn't here anymore",
    );
    expect(
      harness.container.querySelector(".chat-workbench-header"),
    ).toBeNull();
    expect(harness.container.textContent).not.toContain("Invite agent");
    expect(harness.container.textContent).not.toContain(
      "Untitled conversation",
    );
    harness.unmount();
  });

  test("a controlled settingsSection renders that tab active, not General", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      settingsOpen: true,
      settingsSection: "members",
    });
    await harness.settle();

    const activeItem = harness.container.querySelector(
      '.workbench-settings-nav-item[aria-current="page"]',
    );
    expect(activeItem?.textContent).toBe("Members");
    harness.unmount();
  });

  test("clicking a different tab reports the new section, not just local UI state", async () => {
    stubFetch();
    const sectionChanges: string[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      settingsOpen: true,
      settingsSection: "general",
      onSettingsSectionChange: (section: string) =>
        sectionChanges.push(section),
    });
    await harness.settle();

    const items = Array.from(
      harness.container.querySelectorAll(".workbench-settings-nav-item"),
    );
    const membersItem = items.find((el) => el.textContent === "Members") as
      HTMLButtonElement | undefined;
    expect(membersItem).not.toBeUndefined();
    act(() => membersItem?.click());
    await harness.settle();

    expect(sectionChanges).toEqual(["members"]);
    harness.unmount();
  });

  test("the gear button opens settings on the General section", async () => {
    stubFetch();
    const opens: (string | undefined)[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      settingsOpen: false,
      onSettingsOpenChange: (_open: boolean, section?: string) =>
        opens.push(section),
    });
    await harness.settle();

    const gearButton = harness.container.querySelector(
      'button[aria-label="Settings"]',
    ) as HTMLButtonElement;
    act(() => gearButton.click());
    await harness.settle();

    expect(opens).toEqual(["general"]);
    harness.unmount();
  });
});

describe("connection state is never rendered as chrome", () => {
  test("a dropped stream shows no reconnecting banner or status text", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    firstStream().fail();
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-stream-indicator"),
    ).toBeNull();
    expect(harness.container.textContent).not.toContain("Reconnecting");
    harness.unmount();
  });

  test("sending a message succeeds over HTTP while the stream is down", async () => {
    const sentMessages: unknown[] = [];
    stubFetch(sentMessages);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    // Drop the stream before sending — the send path must not depend on it.
    firstStream().fail();
    await harness.settle();

    const textarea = harness.container.querySelector(
      ".chat-composer-input",
    ) as HTMLTextAreaElement;
    act(() => {
      textareaValueSetter.call(textarea, "hello while down");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sendButton = harness.container.querySelector(
      'button[aria-label="Send"]',
    ) as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      parts: [{ kind: "text", text: "hello while down" }],
    });
    harness.unmount();
  });
});

// Two-level thread model + fork affordance (CL-5908, CL-5948): a workbench
// with one depth-1 thread already open, plus the sub-thread a fork creates.
const ROOT_THREAD = {
  id: "thr_root",
  kind: "root",
  parentMessageId: null,
  parentThreadId: null,
  runRef: null,
  title: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const DEPTH1_THREAD = {
  id: "thr_1",
  kind: "reply",
  parentMessageId: "msg_1",
  parentThreadId: "thr_root",
  runRef: null,
  title: null,
  createdAt: "2026-01-01T00:01:00.000Z",
};
const DEPTH2_THREAD = {
  id: "thr_2",
  kind: "reply",
  parentMessageId: "msg_2",
  parentThreadId: "thr_1",
  runRef: null,
  title: null,
  createdAt: "2026-01-01T00:02:00.000Z",
};

// One mailbox, every message stamped with the thread it belongs to — the
// shape `GET /messages` returns since CL-6313. The client filters this
// into the root feed and each open thread; it never fetches per thread.
const THREADED_MESSAGES = [
  {
    id: "msg_1",
    createdAt: "2026-01-01T00:00:30.000Z",
    parts: [{ kind: "text", text: "root note" }],
    sender: { name: null, address: "prn_alice@acme.example" },
    threadId: ROOT_THREAD.id,
  },
  {
    id: "msg_2",
    createdAt: "2026-01-01T00:01:30.000Z",
    parts: [{ kind: "text", text: "inside the thread" }],
    sender: { name: null, address: "prn_alice@acme.example" },
    threadId: DEPTH1_THREAD.id,
  },
];

function stubThreadedFetch({
  sentMessages = [],
  forkCalls = [],
}: {
  sentMessages?: unknown[];
  forkCalls?: string[];
} = {}) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  let forked = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
      return json({ items: [WORKBENCH_WIRE] });
    }
    if (/\/chat\/workbenches\?kind=chat$/.test(path))
      return json({ items: [] });
    if (/\/chat\/workbenches\/[^/]+\/threads\/fork$/.test(path)) {
      forkCalls.push(path);
      forked = true;
      const body = JSON.parse(String(init?.body)) as {
        parentMessageId: string;
      };
      return json({ ...DEPTH2_THREAD, parentMessageId: body.parentMessageId });
    }
    if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
      const items = (
        forked
          ? [ROOT_THREAD, DEPTH1_THREAD, DEPTH2_THREAD]
          : [ROOT_THREAD, DEPTH1_THREAD]
      ).map((thread) => ({
        ...thread,
        replyCount: THREADED_MESSAGES.filter((m) => m.threadId === thread.id)
          .length,
        lastActivityAt:
          THREADED_MESSAGES.filter((m) => m.threadId === thread.id).at(-1)
            ?.createdAt ?? null,
      }));
      return json({ rootThreadId: ROOT_THREAD.id, items });
    }
    if (/\/threads\/thr_root\/messages$/.test(path)) {
      return json({
        thread: ROOT_THREAD,
        items: [
          {
            id: "msg_1",
            createdAt: "2026-01-01T00:00:30.000Z",
            parts: [{ kind: "text", text: "root note" }],
            sender: { name: null, address: "prn_alice@acme.example" },
          },
        ],
      });
    }
    if (/\/threads\/thr_1\/messages$/.test(path)) {
      return json({
        thread: DEPTH1_THREAD,
        items: [
          {
            id: "msg_2",
            createdAt: "2026-01-01T00:01:30.000Z",
            parts: [{ kind: "text", text: "inside the thread" }],
            sender: { name: null, address: "prn_alice@acme.example" },
          },
        ],
      });
    }
    if (/\/threads\/thr_2\/messages$/.test(path)) {
      return json({ thread: DEPTH2_THREAD, items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
      if (init?.method === "POST") {
        sentMessages.push(JSON.parse(String(init.body)));
        return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
      }
      return json({ items: THREADED_MESSAGES });
    }
    if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
      return json({
        ...WORKBENCH_WIRE,
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

describe("Thread breadcrumb and fork (CL-5908, CL-5948)", () => {
  test("opening a depth-1 thread shows a two-segment breadcrumb: workbench / thread", async () => {
    stubThreadedFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const breadcrumb = harness.container.querySelector(
      ".chat-thread-breadcrumb",
    );
    expect(breadcrumb).not.toBeNull();
    expect(
      breadcrumb?.querySelectorAll(".chat-thread-breadcrumb-link"),
    ).toHaveLength(1);
    expect(breadcrumb?.textContent).toContain("Launch Planning");
    harness.unmount();
  });

  test("an opened thread shows the message it hangs off above its replies", async () => {
    stubThreadedFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    // The thread's own feed carries only "inside the thread"; its
    // parent ("root note", msg_1) is pulled from the workbench feed.
    const text = harness.container.textContent ?? "";
    const parentAt = text.indexOf("root note");
    const replyAt = text.indexOf("inside the thread");
    expect(parentAt).toBeGreaterThan(-1);
    expect(replyAt).toBeGreaterThan(-1);
    expect(parentAt).toBeLessThan(replyAt);
    harness.unmount();
  });

  test("editing an own prompt in an open reply thread resends into that thread without replacing history", async () => {
    const sentMessages: unknown[] = [];
    const forkCalls: string[] = [];
    stubThreadedFetch({ sentMessages, forkCalls });
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const originalRow = harness.container.querySelector("#chat-message-msg_2");
    expect(originalRow?.textContent).toContain("inside the thread");
    const editButton = originalRow?.querySelector(
      ".chat-hover-edit",
    ) as HTMLButtonElement;
    expect(editButton).not.toBeNull();
    await act(async () => {
      editButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const editedPrompt = "inside the thread, revised";
    typeInComposer(harness.container, editedPrompt);
    const sendButton = harness.container.querySelector(
      'button[aria-label="Send"]',
    ) as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      threadId: DEPTH1_THREAD.id,
      parts: [{ kind: "text", text: editedPrompt }],
    });
    expect(forkCalls).toEqual([]);
    expect(
      harness.container.querySelector("#chat-message-msg_2")?.textContent,
    ).toContain("inside the thread");
    harness.unmount();
  });

  test("forking a message inside a thread opens a sub-thread with a three-segment breadcrumb and an origin banner", async () => {
    stubThreadedFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    // Open the depth-1 thread first.
    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    // Inside the thread, every message's hover-toolbar reply action forks
    // instead of replying — the persistent "Reply in thread" row only
    // renders once a thread already has replies (see `MessageHoverToolbar`
    // and `ThreadAffordance` in `timeline.tsx`), so a fresh message's fork
    // affordance lives in the hover cluster, not a `.chat-thread-open` row.
    // Scope to the reply message's own toolbar — the thread view now
    // renders the parent message (msg_1) above it, which has its own
    // hover cluster.
    const forkButton = harness.container.querySelector(
      '#chat-message-msg_2 .chat-hover-toolbar[data-thread-affordance-mode="fork"] .chat-hover-reply',
    ) as HTMLButtonElement;
    expect(forkButton).not.toBeNull();
    await act(async () => {
      forkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const breadcrumb = harness.container.querySelector(
      ".chat-thread-breadcrumb",
    );
    expect(
      breadcrumb?.querySelectorAll(".chat-thread-breadcrumb-link"),
    ).toHaveLength(2);

    expect(
      harness.container.querySelector(".chat-thread-origin-banner"),
    ).not.toBeNull();
    harness.unmount();
  });

  test("the threads menu indents sub-threads under their depth-1 parent", async () => {
    stubThreadedFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });
    const forkButton = harness.container.querySelector(
      '#chat-message-msg_2 .chat-hover-toolbar[data-thread-affordance-mode="fork"] .chat-hover-reply',
    ) as HTMLButtonElement;
    await act(async () => {
      forkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const group = harness.container.querySelector(".chat-threads-menu-group");
    expect(group).not.toBeNull();
    expect(
      group?.querySelector(".chat-threads-menu-item-nested"),
    ).not.toBeNull();
    harness.unmount();
  });
});

describe("hover Edit copies an own prompt into the composer", () => {
  const OWN_PROMPT = "rewrite this prompt";

  function stubFetchWithOwnPrompt(
    sentMessages: unknown[],
    forkCalls: string[],
  ) {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads\/fork$/.test(path)) {
        forkCalls.push(path);
        return json({ id: "thr_should_not_fork" });
      }
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        if (init?.method === "POST") {
          sentMessages.push(JSON.parse(String(init.body)));
          return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
        }
        return json({
          items: [
            {
              id: "msg_own",
              createdAt: "2026-01-01T00:00:00.000Z",
              parts: [{ kind: "text", text: OWN_PROMPT }],
              sender: { name: null, address: "prn_alice@acme.example" },
            },
            {
              id: "msg_agent",
              createdAt: "2026-01-01T00:00:01.000Z",
              parts: [{ kind: "text", text: "agent reply" }],
              sender: {
                name: "Researcher",
                address: "researcher@agents.example",
              },
            },
          ],
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/turns(?:\/|$|\?)/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;
  }

  test("clicking Edit fills the composer; send posts a new message and does not fork", async () => {
    const sentMessages: unknown[] = [];
    const forkCalls: string[] = [];
    stubFetchWithOwnPrompt(sentMessages, forkCalls);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const ownGroup = harness.container.querySelector("#chat-message-msg_own");
    const agentGroup = harness.container.querySelector(
      "#chat-message-msg_agent",
    );
    expect(ownGroup?.getAttribute("data-own")).toBe("true");
    expect(agentGroup?.querySelector(".chat-hover-edit")).toBeNull();

    typeInComposer(harness.container, "unsent draft");
    const edit = ownGroup?.querySelector(
      ".chat-hover-edit",
    ) as HTMLButtonElement;
    expect(edit).not.toBeNull();
    await act(async () => {
      edit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    const composer = harness.container.querySelector(
      ".chat-composer-input",
    ) as HTMLTextAreaElement;
    expect(composer.value).toBe(OWN_PROMPT);
    expect(ownGroup?.textContent).toContain(OWN_PROMPT);

    const sendButton = harness.container.querySelector(
      'button[aria-label="Send"]',
    ) as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    expect(forkCalls).toEqual([]);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      parts: [{ kind: "text", text: OWN_PROMPT }],
    });
    expect(
      harness.container.querySelector("#chat-message-msg_own"),
    ).not.toBeNull();
    expect(
      harness.container.querySelector("#chat-message-msg_own")?.textContent,
    ).toContain(OWN_PROMPT);
    harness.unmount();
  });
});

const WORKBENCH_WITH_AGENT_WIRE = {
  ...WORKBENCH_WIRE,
  participants: [
    { address: "researcher@agents.example", handle: "researcher" },
  ],
};

function pressEnter(textarea: HTMLTextAreaElement) {
  act(() => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

function typeInComposer(container: HTMLElement, text: string) {
  const textarea = container.querySelector(
    ".chat-composer-input",
  ) as HTMLTextAreaElement;
  act(() => {
    setTextareaValue.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

describe("composer slash commands — each wired command's real action", () => {
  test("/invite opens the invite-agent dialog", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/invite");
    pressEnter(textarea);
    await harness.settle();

    expect(document.body.textContent).toContain("Invite an agent");
    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("/agents opens workbench settings straight to the Agents section", async () => {
    stubFetch();
    const settingsOpenChanges: boolean[] = [];
    const sectionsOpened: (string | undefined)[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      settingsOpen: false,
      onSettingsOpenChange: (open: boolean, section?: string) => {
        settingsOpenChanges.push(open);
        sectionsOpened.push(section);
      },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/agents");
    pressEnter(textarea);
    await harness.settle();

    expect(settingsOpenChanges).toEqual([true]);
    expect(sectionsOpened).toEqual(["agents"]);
    harness.unmount();
  });

  test("/routine opens the New Routine panel pre-bound to the active workbench", async () => {
    stubFetch();
    const opened: string[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      onCreateRoutineInSpace: (workbenchId: string) => {
        opened.push(workbenchId);
      },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/routine");
    pressEnter(textarea);
    await harness.settle();

    expect(opened).toEqual(["ch_1"]);
    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("/routine with zero agent participants passes no preselection (CL-7356)", async () => {
    stubFetch(undefined, WORKBENCH_WIRE, { workbenchAgents: [] });
    const opened: (string | undefined)[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      onCreateRoutineInSpace: (
        workbenchId: string,
        preselectedAssetId?: string,
      ) => {
        opened.push(workbenchId, preselectedAssetId);
      },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/routine");
    pressEnter(textarea);
    await harness.settle();

    expect(opened).toEqual(["ch_1", undefined]);
    harness.unmount();
  });

  test("/routine with two agent participants passes no preselection (CL-7356)", async () => {
    stubFetch(undefined, WORKBENCH_WIRE, {
      workbenchAgents: [
        {
          address: "agent:asset_echo/ins_1",
          handle: "echo",
          definitionId: "def_echo",
          definitionAssetId: "asset_echo",
          displayName: "Echo",
        },
        {
          address: "agent:asset_digest/ins_2",
          handle: "digest",
          definitionId: "def_digest",
          definitionAssetId: "asset_digest",
          displayName: "Digest",
        },
      ],
    });
    const opened: (string | undefined)[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      onCreateRoutineInSpace: (
        workbenchId: string,
        preselectedAssetId?: string,
      ) => {
        opened.push(workbenchId, preselectedAssetId);
      },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/routine");
    pressEnter(textarea);
    await harness.settle();

    expect(opened).toEqual(["ch_1", undefined]);
    harness.unmount();
  });

  test("/routine with exactly one agent participant preselects its definition asset id (CL-7356)", async () => {
    stubFetch(undefined, WORKBENCH_WIRE, {
      workbenchAgents: [
        {
          address: "agent:asset_echo/ins_1",
          handle: "echo",
          definitionId: "def_echo",
          definitionAssetId: "asset_echo",
          displayName: "Echo",
        },
      ],
    });
    const opened: (string | undefined)[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      onCreateRoutineInSpace: (
        workbenchId: string,
        preselectedAssetId?: string,
      ) => {
        opened.push(workbenchId, preselectedAssetId);
      },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/routine");
    pressEnter(textarea);
    await harness.settle();

    expect(opened).toEqual(["ch_1", "asset_echo"]);
    harness.unmount();
  });

  test("/routine with no host-supplied hop wired falls back to an unavailable toast", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/routine");
    pressEnter(textarea);
    await harness.settle();

    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("there is no per-workbench header Routines button (CL-6362: Routines is global-only, reached from the shell rail)", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const byLabel = harness.container.querySelector('[aria-label="Routines"]');
    const byText = [...harness.container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Routines",
    );
    expect(byLabel).toBeNull();
    expect(byText).toBeUndefined();
    harness.unmount();
  });

  test("the 'New routine' header button is hidden when the host has not wired the hop", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const button = [...harness.container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "New routine",
    );
    expect(button).toBeUndefined();
    harness.unmount();
  });

  test("there is no per-workbench header Insights button (CL-6362: Insights is global-only, reached from the shell rail)", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const button = [...harness.container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Insights",
    );
    expect(button).toBeUndefined();
    harness.unmount();
  });

  test("/summarize addresses the workbench's actual first agent participant and sends", async () => {
    const sentMessages: unknown[] = [];
    stubFetch(sentMessages, WORKBENCH_WITH_AGENT_WIRE);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/summarize");
    pressEnter(textarea);
    await act(() => sleep(30));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      parts: [{ kind: "text", text: "@researcher summarize this thread" }],
    });
    harness.unmount();
  });

  test("/summarize with no agent in the workbench never sends a mention it can't back", async () => {
    const sentMessages: unknown[] = [];
    stubFetch(sentMessages, WORKBENCH_WIRE);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/summarize");
    pressEnter(textarea);
    await act(() => sleep(30));

    expect(sentMessages).toHaveLength(0);
    harness.unmount();
  });

  test("/help shows an ephemeral hint listing commands and never sends a message", async () => {
    const sentMessages: unknown[] = [];
    stubFetch(sentMessages);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/help");
    pressEnter(textarea);
    await harness.settle();

    expect(harness.container.querySelector(".chat-slash-help")).not.toBeNull();
    expect(harness.container.textContent).toContain("Not sent as a message");
    expect(sentMessages).toHaveLength(0);
    harness.unmount();
  });

  test("/thread, /status, and /pin never appear in the popover — no real action behind them today", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    typeInComposer(harness.container, "/");
    await harness.settle();

    const popoverText = harness.container.querySelector(
      ".chat-mention-popover",
    )?.textContent;
    expect(popoverText).not.toBeUndefined();
    expect(popoverText).not.toContain("/thread");
    expect(popoverText).not.toContain("/status");
    expect(popoverText).not.toContain("/pin");
    expect(popoverText).not.toContain("/run");
    expect(popoverText).toContain("/invite");
    expect(popoverText).toContain("/summarize");
    expect(popoverText).toContain("/agents");
    expect(popoverText).toContain("/help");
    harness.unmount();
  });

  test("an unmatched command's popover offers no items, and typing / at a workbench with no agent still opens it", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "/zzz");
    await harness.settle();

    expect(harness.container.textContent).toContain("No matching commands");
    expect(textarea.value).toBe("/zzz");
    harness.unmount();
  });
});

describe("a stale thread reference self-heals instead of dead-ending", () => {
  // CL-6069: a workbench's remembered root-thread id can outlive the
  // server-side run it named (e.g. across a hub restart), so
  // `GET .../threads/:id/messages` 404s. The client must fall back to
  // the workbench's live feed rather than rendering a dead-end
  // "Couldn't load messages" / "Try again" that keeps re-requesting
  // the same gone thread.
  function stubFetchWithStaleThread(recoveredText: string) {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "thr_stale", items: [] });
      }
      if (
        /\/chat\/workbenches\/[^/]+\/threads\/thr_stale\/messages$/.test(path)
      ) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        return json({
          items: [
            {
              id: "msg_recovered",
              createdAt: "2026-01-01T00:00:00.000Z",
              sender: { name: null, address: "user@x.localhost" },
              parts: [{ kind: "text", text: recoveredText }],
            },
          ],
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;
  }

  test("a 404 on the workbench's remembered root thread falls back to the workbench's live feed", async () => {
    stubFetchWithStaleThread("recovered after a stale thread 404");
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    expect(harness.container.textContent).not.toContain("Couldn't load");
    expect(harness.container.textContent).not.toContain("Try again");
    expect(harness.container.textContent).toContain(
      "recovered after a stale thread 404",
    );
    harness.unmount();
  });
});

describe("a workbench-level 404 offers a way out instead of retrying forever", () => {
  // CL-6077: the routed workbench itself is gone (deleted, or a stale id from
  // a Recents entry that outlived it), not a transient load failure — a
  // dead-end "Try again" button would just re-request the same gone
  // workbench forever. The workspace tells the host (so it can drop the
  // stale Recents entry) and offers recovery instead of retry.
  //
  // CL-6796: a non-workbench id (a tenant id pasted into `/w/:id`, say) must
  // never paint Invite / composer / "Untitled conversation" room chrome
  // before the not-found empty state — fail closed, one honest recovery.
  function stubFetchWithMissingWorkbench() {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;
  }

  test("reports the dead id to the host and renders recovery instead of Try again", async () => {
    stubFetchWithMissingWorkbench();
    const notFoundIds: string[] = [];
    let missionControlClicks = 0;
    let newWorkbenchClicks = 0;
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      onWorkbenchNotFound: (workbenchId: string) =>
        notFoundIds.push(workbenchId),
      onGoToMissionControl: () => {
        missionControlClicks += 1;
      },
      onNewWorkbench: () => {
        newWorkbenchClicks += 1;
      },
    });
    await harness.settle();

    // A background refresh (SSE reconnect/poll) can independently retry and
    // re-report the same dead id — purging is idempotent either way, so
    // this only asserts every report named the right workbench, not a count.
    expect(notFoundIds.length).toBeGreaterThan(0);
    expect(new Set(notFoundIds)).toEqual(new Set(["ch_1"]));
    expect(harness.container.textContent).not.toContain("Try again");
    expect(harness.container.textContent).toContain(
      "This workbench isn't here anymore",
    );
    expect(harness.container.textContent).toContain("Mission Control");
    expect(harness.container.textContent).toContain("New workbench");
    // CL-6796: not-found is the whole stage — never room chrome underneath.
    expect(
      harness.container.querySelector(".chat-workbench-header"),
    ).toBeNull();
    expect(harness.container.textContent).not.toContain("Invite agent");
    expect(harness.container.textContent).not.toContain(
      "Untitled conversation",
    );
    expect(harness.container.querySelector("textarea")).toBeNull();

    const missionControlButton = Array.from(
      harness.container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Mission Control"));
    expect(missionControlButton).toBeDefined();
    act(() => {
      missionControlButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(missionControlClicks).toBe(1);

    const newWorkbenchButton = Array.from(
      harness.container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("New workbench"));
    expect(newWorkbenchButton).toBeDefined();
    act(() => {
      newWorkbenchButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(newWorkbenchClicks).toBe(1);

    harness.unmount();
  });

  test("a non-workbench id never mounts Invite, composer, or Untitled chrome before not-found", async () => {
    // CL-6796: opening a tenant id as `/w/:id` — messages 404 is the
    // authoritative miss, so the room must fail closed to the empty state
    // without ever painting conversation chrome.
    stubFetchWithMissingWorkbench();
    const notFoundIds: string[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "tnt_not_a_workbench",
      onWorkbenchNotFound: (workbenchId: string) =>
        notFoundIds.push(workbenchId),
      onGoToMissionControl: () => undefined,
      onNewWorkbench: () => undefined,
    });
    await harness.settle();

    expect(notFoundIds).toContain("tnt_not_a_workbench");
    expect(harness.container.textContent).toContain(
      "This workbench isn't here anymore",
    );
    expect(
      harness.container.querySelector(".chat-workbench-header"),
    ).toBeNull();
    expect(harness.container.textContent).not.toContain("Invite agent");
    expect(harness.container.textContent).not.toContain(
      "Untitled conversation",
    );
    expect(harness.container.querySelector("textarea")).toBeNull();
    expect(harness.container.textContent).toContain("Mission Control");
    expect(harness.container.textContent).toContain("New workbench");

    harness.unmount();
  });

  test("a ready list lacking the routed id does not flash not-found while messages are still loading", async () => {
    // CL-6796 critique: create→navigate leaves the React Query workbench
    // list ready but stale — the new id is absent until refetch. That alone
    // must not paint the not-found empty state; loading is fine until the
    // messages fetch proves presence or 404s.
    let resolveMessages: ((response: Response) => void) | undefined;
    const messagesGate = new Promise<Response>((resolve) => {
      resolveMessages = resolve;
    });
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        // Stale ready cache: existing workbench only — not the routed id.
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        return messagesGate;
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          id: "ch_fresh",
          title: "Fresh room",
          kind: "workbench",
          pinned: false,
          participants: [],
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;

    const notFoundIds: string[] = [];
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_fresh",
      onWorkbenchNotFound: (workbenchId: string) =>
        notFoundIds.push(workbenchId),
      onGoToMissionControl: () => undefined,
      onNewWorkbench: () => undefined,
    });
    await harness.settle();

    expect(harness.container.textContent).not.toContain(
      "This workbench isn't here anymore",
    );
    expect(notFoundIds).toEqual([]);
    expect(harness.container.textContent).not.toContain("Invite agent");
    expect(harness.container.querySelector("textarea")).toBeNull();

    await act(async () => {
      resolveMessages?.(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await sleep(30);
    });

    expect(harness.container.textContent).not.toContain(
      "This workbench isn't here anymore",
    );
    expect(notFoundIds).toEqual([]);

    harness.unmount();
  });
});

describe("a 401 on the messages load offers Sign in instead of a dead-end retry", () => {
  function stubFetchWithUnauthorizedMessages() {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;
  }

  test("renders Sign in (not Try again) and calls onSignIn on click", async () => {
    stubFetchWithUnauthorizedMessages();
    let signInClicks = 0;
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      onSignIn: () => {
        signInClicks += 1;
      },
    });
    await harness.settle();

    expect(harness.container.textContent).not.toContain("Try again");
    expect(harness.container.textContent).toContain("Sign in");

    const signInButton = Array.from(
      harness.container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Sign in");
    expect(signInButton).toBeDefined();
    act(() => {
      signInButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(signInClicks).toBe(1);

    harness.unmount();
  });
});

describe("chat error copy never leaks a raw API path", () => {
  test("a genuine load failure renders plain-language copy, never a raw /api/ path or bare status code", async () => {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;

    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    expect(harness.container.textContent).toContain("Couldn't load messages");
    expect(harness.container.textContent).not.toContain("/api/");
    expect(harness.container.textContent).not.toContain("500");
    harness.unmount();
  });
});

// CL-6103: the composer used to give no feedback that a send had even
// started, and a failed send surfaced as a tiny red line pinned to the
// composer's own corner — nowhere near the message it was about. These
// tests drive a real submit through `ChatWorkspace` and check the DOM
// states a reader actually sees: the pending bubble appears before the
// network call resolves, a success clears it, a failure shows its own
// inline Retry/Discard, and Discard hands the text back to the composer.
describe("optimistic send (CL-6103)", () => {
  function stubFetchWithSendOutcome(shouldFail: () => boolean) {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        if (init?.method === "POST") {
          if (shouldFail()) {
            return json({ error: { code: "bad_request" } }, 500);
          }
          return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
        }
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;
  }

  function clickSend(container: HTMLElement) {
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Send"]',
    );
    if (button === null) throw new Error("send button not found");
    act(() => button.click());
  }

  test("the send button is muted while empty and turns primary once there's a draft", async () => {
    stubFetchWithSendOutcome(() => false);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const sendButton = () =>
      harness.container.querySelector<HTMLButtonElement>(
        '[aria-label^="Send"]',
      );
    expect(sendButton()?.getAttribute("data-send-state")).toBe("empty");
    expect(sendButton()?.hasAttribute("disabled")).toBe(true);

    typeInComposer(harness.container, "hi");
    await harness.settle();

    expect(sendButton()?.getAttribute("data-send-state")).toBe("ready");
    expect(sendButton()?.hasAttribute("disabled")).toBe(false);
    harness.unmount();
  });

  test("submitting shows a pending bubble synchronously, clears the composer, and drops it on success", async () => {
    stubFetchWithSendOutcome(() => false);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "hi");

    // The pending bubble and the composer's own clear both happen inside
    // this one `act`, before the POST's promise has any chance to settle
    // — proving they're synchronous with the submit, not a side effect of
    // the network round-trip landing.
    act(() => {
      clickSend(harness.container);
    });

    expect(textarea.value).toBe("");
    const pendingBubble = harness.container.querySelector(
      '.chat-bubble[data-pending="sending"]',
    );
    expect(pendingBubble).not.toBeNull();
    expect(pendingBubble?.textContent).toContain("hi");

    await harness.settle();

    expect(
      harness.container.querySelector(".chat-bubble[data-pending]"),
    ).toBeNull();
    harness.unmount();
  });

  test("a failed send shows the error inline on the bubble itself, with working Retry and Discard", async () => {
    let fail = true;
    stubFetchWithSendOutcome(() => fail);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "hi");
    act(() => {
      clickSend(harness.container);
    });
    await harness.settle();

    // Never a detached corner line — the failure lives on the bubble.
    expect(harness.container.textContent).not.toContain("Couldn't send");
    const failedBubble = harness.container.querySelector(
      '.chat-bubble[data-pending="failed"]',
    );
    expect(failedBubble).not.toBeNull();
    expect(failedBubble?.textContent).toContain("Not sent");

    const retryButton = [...harness.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retryButton).not.toBeUndefined();

    fail = false;
    act(() => retryButton?.click());
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-bubble[data-pending]"),
    ).toBeNull();
    expect(textarea.value).toBe("");
    harness.unmount();
  });

  test("Discard removes the failed pending bubble and returns its text to the composer", async () => {
    stubFetchWithSendOutcome(() => true);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const textarea = typeInComposer(harness.container, "hi there");
    act(() => {
      clickSend(harness.container);
    });
    await harness.settle();

    expect(
      harness.container.querySelector('.chat-bubble[data-pending="failed"]'),
    ).not.toBeNull();

    const discardButton = [
      ...harness.container.querySelectorAll("button"),
    ].find((button) => button.textContent === "Discard");
    expect(discardButton).not.toBeUndefined();
    act(() => discardButton?.click());
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-bubble[data-pending]"),
    ).toBeNull();
    expect(textarea.value).toBe("hi there");
    harness.unmount();
  });
});

// CL-6251: `loadMessages` calls overlap constantly (every stream event fires
// a background refresh on top of whatever a send already triggered) with no
// guarantee they resolve in the order they were issued. Before the fix,
// "last response to resolve wins" let a stale, slower-resolving refresh
// clobber a newer one that already landed — flickering a just-sent message
// back out of the timeline. This drives two overlapping background
// refreshes with their GET responses deliberately reordered and asserts the
// later-issued request's result is the one that sticks.
describe("refresh ordering around a send (CL-6251, CL-6313)", () => {
  test("a refresh already in flight when a send lands never reverts the timeline", async () => {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    let messagesGetCount = 0;
    // Set once the two competing background refreshes are about to be
    // triggered — every GET before this index is an incidental load the
    // race doesn't care about (see the mock below).
    let raceStartIndex = Number.POSITIVE_INFINITY;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        if (init?.method === "POST") {
          return json({
            id: "msg_new_2",
            createdAt: "2026-01-01T00:00:01.000Z",
          });
        }
        const callIndex = messagesGetCount;
        messagesGetCount += 1;
        // Every load before the race starts (the initial mount load, plus
        // however many redundant foreground loads the workbench-resolution
        // effects happen to run) reports empty — nothing about those is
        // under test here.
        if (callIndex < raceStartIndex) {
          return json({ items: [] });
        }
        const firstMessage = {
          id: "msg_new_1",
          createdAt: "2026-01-01T00:00:00.000Z",
          parts: [{ kind: "text", text: "first" }],
          sender: { name: null, address: "prn_alice@acme.example" },
        };
        const secondMessage = {
          id: "msg_new_2",
          createdAt: "2026-01-01T00:00:01.000Z",
          parts: [{ kind: "text", text: "second" }],
          sender: { name: null, address: "prn_alice@acme.example" },
        };
        // The first call once the race starts is the stream-drop's own
        // refresh, deliberately kept slow: it reports only the first
        // message, correct as of its own request time, before the send
        // below had landed. It is still in flight when the send lands, so
        // resolving it into the cache afterwards would blink the sent
        // message back out. Every call after it reports both messages,
        // correct as of ITS request time.
        if (callIndex === raceStartIndex) {
          await sleep(400);
          return json({ items: [firstMessage] });
        }
        await sleep(5);
        return json({ items: [firstMessage, secondMessage] });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;

    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();
    // The initial load resolves through `listThreads` first, then
    // `listMessages` — slower than the flat single-fetch mocks other
    // tests use, so it needs longer than one `settle()` to leave the
    // loading skeleton before the composer mounts.
    await act(() => sleep(100));

    // Drop the stream: `onerror` starts polling, which fires the
    // deliberately-slow refresh. Wait past the coalescing window so it is
    // genuinely in flight before the send goes out.
    raceStartIndex = messagesGetCount;
    act(() => firstStream().fail());
    await act(() => sleep(300));

    const sendButton = harness.container.querySelector<HTMLButtonElement>(
      '[aria-label^="Send"]',
    );
    if (sendButton === null) throw new Error("send button not found");
    typeInComposer(harness.container, "second");
    act(() => sendButton.click());

    // Long enough for the slow refresh to resolve after the send, and for
    // the send's own refresh to land behind it.
    await act(() => sleep(700));

    expect(
      harness.container.querySelector("#chat-message-msg_new_2"),
    ).not.toBeNull();
    expect(harness.container.textContent).toContain("second");
    harness.unmount();
  });
});

describe("Workbench header polish (CL-6106)", () => {
  test("the threads dropdown is hidden entirely when the workbench has no threads yet", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    expect(harness.container.querySelector(".chat-threads-menu")).toBeNull();
    harness.unmount();
  });

  test("the threads dropdown appears once the workbench has a thread", async () => {
    stubThreadedFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const trigger = harness.container.querySelector(
      ".chat-threads-menu-trigger",
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("1 thread");
    harness.unmount();
  });

  test("agent participant chips live in the square member stack, naming the agent by display name (CL-6424 supersedes the raw-handle tooltip)", async () => {
    stubFetch(undefined, WORKBENCH_WITH_AGENT_WIRE);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const chip = harness.container.querySelector(
      '.member-avatar[data-agent="true"]',
    );
    expect(chip).not.toBeNull();
    expect((chip as HTMLElement).title).toBe("Researcher");
    expect(chip?.querySelector('[data-corbit="true"]')).not.toBeNull();
    harness.unmount();
  });

  test("the settings control is icon-only, at the far right, with a tooltip", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const button = harness.container.querySelector(
      'button[aria-label="Settings"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent?.trim()).toBe("");
    expect(button.title).toBe("Settings");

    const actions = harness.container.querySelector(".chat-workbench-actions");
    expect(actions?.lastElementChild?.contains(button)).toBe(true);
    harness.unmount();
  });

  test("headerSlot lifts identity and actions out of the in-stage header", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      headerSlot: (chrome) =>
        createElement(
          "div",
          { "data-testid": "host-stage-bar" },
          chrome.crumbs.map((crumb) => crumb.label).join(" / "),
          chrome.actions,
        ),
    });
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-workbench-header"),
    ).toBeNull();
    const hostBar = harness.container.querySelector(
      '[data-testid="host-stage-bar"]',
    );
    expect(hostBar).not.toBeNull();
    expect(hostBar?.textContent).toContain("Launch Planning");
    expect(
      harness.container.querySelector('button[aria-label="Settings"]'),
    ).not.toBeNull();
    harness.unmount();
  });

  test("headerSlot thread view has one aria-current=page and a clickable close-thread", async () => {
    stubThreadedFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      headerSlot: (chrome) =>
        createElement(
          "div",
          { "data-testid": "host-stage-bar" },
          createElement(
            "span",
            { "aria-current": "page" },
            chrome.crumbs.at(-1)?.label,
          ),
          chrome.subtitle !== undefined
            ? createElement(
                "div",
                { className: "stage-top-bar-sub" },
                chrome.subtitle,
              )
            : null,
          chrome.actions,
        ),
    });
    await harness.settle();

    const openButton = harness.container.querySelector(
      ".chat-thread-open",
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    expect(
      harness.container.querySelectorAll('[aria-current="page"]'),
    ).toHaveLength(1);
    expect(
      harness.container
        .querySelector(".chat-thread-breadcrumb-current")
        ?.getAttribute("aria-current"),
    ).toBeNull();

    const closeThread = harness.container.querySelector(
      ".chat-thread-breadcrumb-link",
    ) as HTMLButtonElement;
    expect(closeThread).not.toBeNull();
    await act(async () => {
      closeThread.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });
    expect(
      harness.container.querySelector(".chat-thread-breadcrumb"),
    ).toBeNull();
    harness.unmount();
  });

  test("headerSlot still titles the stage while the tenant is loading", async () => {
    const harness = await mount({
      tenant: { kind: "loading" },
      headerSlot: (chrome) =>
        createElement(
          "div",
          { "data-testid": "host-stage-bar" },
          chrome.crumbs[0]?.label,
        ),
    });
    await harness.settle();

    expect(
      harness.container.querySelector('[data-testid="host-stage-bar"]')
        ?.textContent,
    ).toBe("Workbenches");
    harness.unmount();
  });
});

describe("CL-6833: running-turn resume failure is visible, never silent idle", () => {
  test("a failed catch-up fetch shows the resume-failed banner with Retry", async () => {
    stubFetch(undefined, WORKBENCH_WITH_AGENT_WIRE, { turnsFail: true });
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    const banner = harness.container.querySelector(
      ".chat-resume-failed-banner",
    );
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(harness.container.textContent).toContain(
      "Couldn't resume the running reply",
    );
    expect(
      [...harness.container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Retry",
      ),
    ).toBe(true);
    harness.unmount();
  });

  test("a successful empty catch-up leaves the room without a resume banner", async () => {
    stubFetch(undefined, WORKBENCH_WITH_AGENT_WIRE);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-resume-failed-banner"),
    ).toBeNull();
    harness.unmount();
  });

  test("Retry re-asks the turns endpoint after a resume failure", async () => {
    let turnsCalls = 0;
    stubFetch(undefined, WORKBENCH_WITH_AGENT_WIRE, { turnsFail: true });
    const failingFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = typeof input === "string" ? input : String(input);
      if (/\/chat\/workbenches\/[^/]+\/turns(?:\/|$|\?)/.test(path)) {
        turnsCalls += 1;
        if (turnsCalls >= 2) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return failingFetch(input, init);
    }) as typeof fetch;

    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    expect(
      harness.container.querySelector(".chat-resume-failed-banner"),
    ).not.toBeNull();

    const retry = [...harness.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    ) as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await sleep(30);
    });
    await harness.settle();

    expect(turnsCalls).toBeGreaterThanOrEqual(2);
    expect(
      harness.container.querySelector(".chat-resume-failed-banner"),
    ).toBeNull();
    harness.unmount();
  });
});

describe("Invite control visibility (CL-6781)", () => {
  test("hides Invite agent when the invitable listing succeeds empty", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    expect(harness.container.textContent).not.toContain("Invite agent");
    harness.unmount();
  });

  test("shows Invite agent once at least one definition is invitable", async () => {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        if (init?.method === "POST") {
          return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
        }
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({
          items: [{ id: "wfd_echo", name: "echo", description: "Echo" }],
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;

    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    expect(harness.container.textContent).toContain("Invite agent");
    harness.unmount();
  });
});

describe("switching workbenches never carries a stale root-thread id across", () => {
  // CL-6067/6069 regression, still guarded after CL-6313 made it
  // structurally impossible: the timeline no longer fetches by thread id
  // at all, and each workbench's feed has its own query key, so there is
  // no closed-over id left to carry across a switch. What must hold is
  // the same thing it always was — the new workbench renders its own
  // messages promptly, and no request ever names another workbench.
  const WORKBENCH_A = { ...WORKBENCH_WIRE, id: "ch_a", title: "Workbench A" };
  const WORKBENCH_B = { ...WORKBENCH_WIRE, id: "ch_b", title: "Workbench B" };

  function stubFetchTwoWorkbenches(wrongRequests: string[]) {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const notFound = () =>
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_A, WORKBENCH_B] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/ch_a\/threads$/.test(path)) {
        return json({ rootThreadId: "thr_a", items: [] });
      }
      if (/\/chat\/workbenches\/ch_b\/threads$/.test(path)) {
        return json({ rootThreadId: "thr_b", items: [] });
      }
      if (/\/chat\/workbenches\/ch_a\/messages/.test(path)) {
        return json({
          items: [
            {
              id: "msg_a",
              createdAt: "2026-01-01T00:00:00.000Z",
              sender: { name: null, address: "user@x.localhost" },
              parts: [{ kind: "text", text: "A message" }],
              threadId: "thr_a",
            },
          ],
        });
      }
      if (/\/chat\/workbenches\/ch_b\/messages/.test(path)) {
        return json({
          items: [
            {
              id: "msg_b",
              createdAt: "2026-01-01T00:00:00.000Z",
              sender: { name: null, address: "user@x.localhost" },
              parts: [{ kind: "text", text: "B message" }],
              threadId: "thr_b",
            },
          ],
        });
      }
      // A read for any other workbench is the bug this test guards
      // against — record it and 404, exactly like the real hub would.
      if (/\/chat\/workbenches\/[^/]+\/(messages|threads)/.test(path)) {
        wrongRequests.push(path);
        return notFound();
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path))
        return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_A,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;
  }

  test("switching to another workbench loads that workbench's own thread, not the previous one's", async () => {
    const wrongRequests: string[] = [];
    stubFetchTwoWorkbenches(wrongRequests);
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_a",
    });
    await harness.settle();
    await harness.settle();
    expect(harness.container.textContent).toContain("A message");

    await harness.rerender({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_b",
    });
    await harness.settle();
    await harness.settle();

    expect(wrongRequests).toEqual([]);
    expect(harness.container.textContent).not.toContain("Couldn't load");
    expect(harness.container.textContent).toContain("B message");
    harness.unmount();
  });
});
