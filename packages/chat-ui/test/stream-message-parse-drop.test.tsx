// CL-6837: a chat.message the stream cannot parse must not sit silent
// until the next poll. Schema miss and JSON miss both toast and refresh
// the feed immediately.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as reactUi from "@corbits/react-ui";

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

  emitRaw(eventType: string, data: string) {
    this.listeners.get(eventType)?.({ data } as MessageEvent);
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

let feedRefetchCount = 0;

function stubFetch() {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  feedRefetchCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    if (
      method === "GET" &&
      /\/chat\/workbenches\/[^/]+\/(messages|threads|pins)(\?|$)/.test(path)
    ) {
      feedRefetchCount += 1;
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
      return json({ items: [WORKBENCH_WIRE] });
    }
    if (/\/chat\/workbenches\?kind=chat$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
      return json({ rootThreadId: "", items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
      return json({ items: [] });
    }
    if (
      /\/chat\/workbenches\/[^/]+\/presence$/.test(path) &&
      init?.method === "POST"
    ) {
      return json({});
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

const { ChatWorkspace } = await import("../src/chat-workspace");

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
    settle: (ms = 30) => act(() => sleep(ms)),
    unmount: () => root.unmount(),
  };
}

function firstStream(): StubEventSource {
  const instance = StubEventSource.instances[0];
  if (instance === undefined) throw new Error("no stream connected");
  return instance;
}

describe("dropped chat.message is not silent until poll (CL-6837)", () => {
  test("a schema miss toasts and refreshes the feed", async () => {
    stubFetch();
    const toast = spyOn(reactUi, "toast");
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    const feedRefetchCountAfterHydration = feedRefetchCount;

    act(() => {
      firstStream().emit("chat.message", { not: "a message" });
    });
    await harness.settle(300);

    expect(toast).toHaveBeenCalledWith(
      "Couldn't apply that message live — refreshing.",
    );
    expect(feedRefetchCount).toBeGreaterThan(feedRefetchCountAfterHydration);
    toast.mockRestore();
    harness.unmount();
  });

  test("invalid JSON toasts and refreshes the feed instead of forwarding garbage", async () => {
    stubFetch();
    const toast = spyOn(reactUi, "toast");
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    const feedRefetchCountAfterHydration = feedRefetchCount;

    act(() => {
      firstStream().emitRaw("chat.message", "not-json{");
    });
    await harness.settle(300);

    expect(toast).toHaveBeenCalledWith(
      "Couldn't apply that message live — refreshing.",
    );
    expect(feedRefetchCount).toBeGreaterThan(feedRefetchCountAfterHydration);
    expect(harness.container.textContent).not.toContain("not-json");
    toast.mockRestore();
    harness.unmount();
  });
});
