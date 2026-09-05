// CL-6476: a mounted connect card must flip to connected when an
// out-of-band `chat.settings` lands on the workbench stream — never only
// on remount. `settleConnectedService` already publishes that event;
// ChatWorkspace must parse it and ask the host to fan `subscribeConnectState`.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as errorSink from "@corbits/error-sink";

import type {
  ConnectGithubActions,
  ConnectGithubQuery,
  ConnectServiceActions,
  ConnectServiceQuery,
} from "../src/index";

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

const GITHUB_MESSAGE = {
  id: "m_settings_gh",
  createdAt: "2026-01-01T00:00:00.000Z",
  parts: [
    {
      kind: "block" as const,
      block: {
        type: "connect-github",
        data: { requiredForTemplate: "github", state: "disconnected" },
      },
    },
  ],
  sender: { name: "Myra", address: "myra@agents.example" },
};

const SERVICE_MESSAGE = {
  id: "m_settings_svc",
  createdAt: "2026-01-01T00:00:00.000Z",
  parts: [
    {
      kind: "block" as const,
      block: {
        type: "connect-service",
        data: {
          connectorId: "gmail",
          displayName: "Gmail",
          reason: "Connect Gmail so I can send this for you.",
        },
      },
    },
  ],
  sender: { name: "Myra", address: "myra@agents.example" },
};

function stubFetch(messages: readonly unknown[]) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
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
    if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
      return json({ rootThreadId: "", items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
      return json({ items: messages });
    }
    if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/agents$/.test(path)) {
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
    settle: () => act(() => sleep(30)),
    unmount: () => root.unmount(),
  };
}

function firstStream(): StubEventSource {
  const instance = StubEventSource.instances[0];
  if (instance === undefined) throw new Error("no stream connected");
  return instance;
}

const SETTINGS_EVENT = {
  updatedBy: "prn_1",
  settings: { "template/pendingConnections": [] as string[] },
};

function liveGithubActions() {
  let connected = false;
  const listeners = new Set<(state: ConnectGithubQuery) => void>();
  let notifyCount = 0;
  const connectedState: ConnectGithubQuery = {
    kind: "connected",
    orgName: "octocat",
    repos: [{ id: "1", name: "acme/widgets" }],
    selectedRepoIds: [],
  };
  const actions = {
    getConnectState: () =>
      Promise.resolve<ConnectGithubQuery>(
        connected ? connectedState : { kind: "disconnected" },
      ),
    subscribeConnectState: (
      _messageId: string,
      onUpdate: (state: ConnectGithubQuery) => void,
    ) => {
      listeners.add(onUpdate);
      return () => {
        listeners.delete(onUpdate);
      };
    },
    requestConnect: () => undefined,
    submitAccessToken: () => Promise.resolve({ ok: true as const }),
    startReviewing: () => Promise.resolve({ startedTriggerCount: 0 }),
    skip: () => Promise.resolve(),
    notifySettingsChanged: async () => {
      notifyCount += 1;
      const state = await actions.getConnectState();
      for (const listener of listeners) listener(state);
    },
  } satisfies ConnectGithubActions;
  return {
    actions,
    settle: () => {
      connected = true;
    },
    notifyCount: () => notifyCount,
  };
}

function liveServiceActions() {
  let connected = false;
  const listeners = new Set<(query: ConnectServiceQuery) => void>();
  let notifyCount = 0;
  const actions = {
    getConnectState: () =>
      Promise.resolve<ConnectServiceQuery>(
        connected
          ? { kind: "connected" }
          : { kind: "disconnected", affordance: "oauth" },
      ),
    subscribeConnectState: (
      _connectorId: string,
      listener: (query: ConnectServiceQuery) => void,
    ) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: () => Promise.resolve({ ok: true as const }),
    submitKey: () => Promise.resolve({ ok: true as const }),
    notifySettingsChanged: async () => {
      notifyCount += 1;
      const state = await actions.getConnectState();
      for (const listener of listeners) listener(state);
    },
  } satisfies ConnectServiceActions;
  return {
    actions,
    settle: () => {
      connected = true;
    },
    notifyCount: () => notifyCount,
  };
}

describe("mounted connect cards flip on chat.settings (CL-6476)", () => {
  test("a GitHub card stays mounted and reads connected after a valid settings event", async () => {
    stubFetch([GITHUB_MESSAGE]);
    const github = liveGithubActions();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      connectGithubActions: github.actions,
    });
    await harness.settle();

    expect(harness.container.textContent).toContain("Connect GitHub");
    const card = harness.container.querySelector(".chat-block");
    expect(card).not.toBeNull();

    github.settle();
    act(() => {
      firstStream().emit("chat.settings", SETTINGS_EVENT);
    });
    await harness.settle();

    expect(github.notifyCount()).toBe(1);
    expect(harness.container.textContent).toContain(
      "Connected to GitHub as octocat",
    );
    expect(harness.container.querySelector(".chat-block")).toBe(card);
    harness.unmount();
  });

  test("a generic connect card stays mounted and reads connected after a valid settings event", async () => {
    stubFetch([SERVICE_MESSAGE]);
    const service = liveServiceActions();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      connectServiceActions: service.actions,
    });
    await harness.settle();

    expect(harness.container.textContent).toContain("Connect Gmail");
    const card = harness.container.querySelector(".chat-block");
    expect(card).not.toBeNull();

    service.settle();
    act(() => {
      firstStream().emit("chat.settings", SETTINGS_EVENT);
    });
    await harness.settle();

    expect(service.notifyCount()).toBe(1);
    expect(harness.container.textContent).toContain("Gmail connected");
    expect(harness.container.querySelector(".chat-block")).toBe(card);
    harness.unmount();
  });

  test("an arktype miss on chat.settings does not notify or dump the payload", async () => {
    stubFetch([GITHUB_MESSAGE]);
    const github = liveGithubActions();
    const reported: unknown[] = [];
    const report = spyOn(errorSink, "reportError").mockImplementation(
      (error) => {
        reported.push(error);
        return "ref_test";
      },
    );
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      connectGithubActions: github.actions,
    });
    await harness.settle();

    act(() => {
      firstStream().emit("chat.settings", { not: "a settings object" });
    });
    await harness.settle();

    expect(github.notifyCount()).toBe(0);
    expect(harness.container.textContent).toContain("Connect GitHub");
    expect(reported).toEqual([]);
    report.mockRestore();
    harness.unmount();
  });
});
