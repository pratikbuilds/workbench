// The workbench header's live who's-here stack (CL-5958), now driven off
// the workbench's own `/stream` connection (CL-6328) rather than a plain
// `presenceMembers` prop: nothing rendered until a `chat.presence.snapshot`
// arrives, one avatar per member from there, colored deterministically per
// principal. Mirrors chat-workspace.test.tsx's stub-fetch/mount harness.

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
  readyState = 1;
  listeners = new Map<string, (message: MessageEvent) => void>();

  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }

  addEventListener(
    eventType: string,
    listener: (message: MessageEvent) => void,
  ) {
    this.listeners.set(eventType, listener);
  }

  emit(eventType: string, data: unknown) {
    this.listeners.get(eventType)?.({
      data: JSON.stringify(data),
    } as MessageEvent);
  }

  close() {
    this.readyState = 2;
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

function stubFetch() {
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
    if (/\/chat\/workbenches\/[^/]+\/messages/.test(path))
      return json({ items: [] });
    if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path))
      return json({ items: [] });
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

const { ChatWorkspace, TEAM_AVATAR_STACK_LIMIT } =
  await import("../src/chat-workspace");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(props: Parameters<typeof ChatWorkspace>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  act(() => {
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
  };
}

function firstStream(): StubEventSource {
  const instance = StubEventSource.instances[0];
  if (instance === undefined) throw new Error("no stream connected");
  return instance;
}

describe("workbench header presence stack", () => {
  test("renders nothing before a presence snapshot arrives", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    expect(harness.container.querySelector(".chat-presence-stack")).toBeNull();
    harness.unmount();
  });

  test("renders one colored avatar per member in the stream's presence snapshot", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    act(() => {
      firstStream().emit("chat.presence.snapshot", {
        members: [
          { principalId: "prn_alice", lastActiveAt: "2026-01-01T00:00:00Z" },
          { principalId: "prn_bob", lastActiveAt: "2026-01-01T00:00:00Z" },
        ],
      });
    });
    await harness.settle();

    const avatars = harness.container.querySelectorAll(".chat-presence-avatar");
    expect(avatars).toHaveLength(2);
    expect(
      harness.container.querySelector(".chat-presence-stack"),
    ).not.toBeNull();
    expect(harness.container.querySelector(".chat-member-stack")).toBeNull();
    harness.unmount();
  });

  test("chat.presence deltas add and remove members without a snapshot", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    act(() => {
      firstStream().emit("chat.presence", {
        principalId: "prn_alice",
        state: "online",
        lastActiveAt: "2026-01-01T00:00:00Z",
      });
    });
    await harness.settle();
    expect(
      harness.container.querySelectorAll(".chat-presence-avatar"),
    ).toHaveLength(1);

    act(() => {
      firstStream().emit("chat.presence", {
        principalId: "prn_alice",
        state: "offline",
        lastActiveAt: "2026-01-01T00:01:00Z",
      });
    });
    await harness.settle();
    expect(
      harness.container.querySelectorAll(".chat-presence-avatar"),
    ).toHaveLength(0);
    harness.unmount();
  });

  test("collapses anything past the member-stack limit into a +N chip", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const liveCount = TEAM_AVATAR_STACK_LIMIT + 4;
    act(() => {
      firstStream().emit("chat.presence.snapshot", {
        members: Array.from({ length: liveCount }, (_, index) => ({
          principalId: `prn_${String(index)}`,
          lastActiveAt: "2026-01-01T00:00:00Z",
        })),
      });
    });
    await harness.settle();

    expect(
      harness.container.querySelectorAll(".chat-presence-avatar"),
    ).toHaveLength(TEAM_AVATAR_STACK_LIMIT);
    const overflow = harness.container.querySelector(
      ".chat-presence-stack-overflow",
    );
    expect(overflow).not.toBeNull();
    expect(overflow?.textContent).toBe("+4");
    harness.unmount();
  });
});
