// The workbench header's static member stack: every agent participant on
// the workbench plus every human on the roster, square avatars, collapsing
// anything past TEAM_AVATAR_STACK_LIMIT into a "+N" chip. Live presence is
// a separate round stack (see presence-stack.test.tsx).
// Mirrors presence-stack.test.tsx's stub-fetch/mount harness.

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

function stubFetch(workbenchWire: {
  participants: { address: string; handle: string }[];
  agents?: { address: string; handle: string; displayName: string }[];
}) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/workbenches\/[^/]+\/agents$/.test(path)) {
      return json({
        items: (workbenchWire.agents ?? []).map((agent, index) => ({
          address: agent.address,
          handle: agent.handle,
          definitionId: `wfd_${String(index)}`,
          definitionAssetId: `ast_wfd_${String(index)}`,
          displayName: agent.displayName,
        })),
      });
    }
    if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
      return json({
        items: [
          {
            id: "ch_1",
            title: "Launch Planning",
            kind: "workbench",
            pinned: false,
            participants: workbenchWire.participants,
          },
        ],
      });
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

/** A human participant whose bare address (no `@`, so `isAgentAddress`
 * reads it as human) IS its own principal id — this is what lets the
 * presence roster's bare `principalId` resolve back to a display name
 * (`typingLabel`), the same lookup `chat.typing` already relies on. */
function humanParticipant(principalId: string, handle: string) {
  return { address: principalId, handle };
}

describe("workbench header member avatar stack", () => {
  test("renders every agent participant and every roster human in the square member stack", async () => {
    stubFetch({
      participants: [
        { address: "myra@agents.example", handle: "Myra" },
        humanParticipant("prn_alice", "Alice"),
      ],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    act(() => {
      firstStream().emit("chat.presence.snapshot", {
        members: [
          { principalId: "prn_alice", lastActiveAt: "2026-01-01T00:00:00Z" },
        ],
      });
    });
    await harness.settle();

    const memberStack = harness.container.querySelector(".chat-member-stack");
    expect(memberStack).not.toBeNull();
    expect(harness.container.querySelector(".chat-team-stack")).toBeNull();
    const agentAvatars = harness.container.querySelectorAll(
      '.member-avatar[data-agent="true"]',
    );
    expect(agentAvatars).toHaveLength(1);
    const agentAvatar = agentAvatars[0] as HTMLElement;
    expect(agentAvatar.title).toBe("Myra");
    const memberHumans = harness.container.querySelectorAll(
      ".member-avatar:not([data-agent])",
    );
    expect(agentAvatar.querySelector('[data-corbit="true"]')).not.toBeNull();
    expect(memberHumans).toHaveLength(1);
    expect((memberHumans[0] as HTMLElement).title).toBe("Alice");
    const liveStack = harness.container.querySelector(".chat-presence-stack");
    expect(liveStack).not.toBeNull();
    const liveAvatars = harness.container.querySelectorAll(
      ".chat-presence-avatar",
    );
    expect(liveAvatars).toHaveLength(1);
    expect((liveAvatars[0] as HTMLElement).title).toBe("Alice");
    expect(
      harness.container.querySelector(".chat-member-stack-overflow"),
    ).toBeNull();
    harness.unmount();
  });

  test("renders distinct Corbit avatars for agent participants", async () => {
    stubFetch({
      participants: [
        { address: "run_myra@dana.localhost", handle: "myra" },
        { address: "run_scout@dana.localhost", handle: "scout" },
      ],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const agentAvatars = Array.from(
      harness.container.querySelectorAll('.member-avatar[data-agent="true"]'),
    ) as HTMLElement[];
    expect(agentAvatars).toHaveLength(2);
    expect(agentAvatars.map((avatar) => avatar.title)).toEqual([
      "Myra",
      "Scout",
    ]);
    expect(
      agentAvatars.every(
        (avatar) => avatar.querySelector('[data-corbit="true"]') !== null,
      ),
    ).toBe(true);
    harness.unmount();
  });

  test("shows the resolved agent display name, never the raw handle slug (CL-6424)", async () => {
    stubFetch({
      participants: [{ address: "myra@agents.example", handle: "myra" }],
      agents: [
        {
          address: "myra@agents.example",
          handle: "myra",
          displayName: "Myra the Helper",
        },
      ],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const agentAvatars = harness.container.querySelectorAll(
      '.member-avatar[data-agent="true"]',
    );
    expect(agentAvatars).toHaveLength(1);
    expect((agentAvatars[0] as HTMLElement).title).toBe("Myra the Helper");
    harness.unmount();
  });

  test("collapses anything past the limit into a +N chip", async () => {
    const humanNames = ["Alice", "Bob", "Carla", "Dana", "Eve", "Finn"];
    const humanParticipants = humanNames.map((name, index) =>
      humanParticipant(`prn_${index}`, name),
    );
    stubFetch({
      participants: [
        { address: "myra@agents.example", handle: "Myra" },
        ...humanParticipants,
      ],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    act(() => {
      firstStream().emit("chat.presence.snapshot", {
        members: humanNames.map((_, index) => ({
          principalId: `prn_${index}`,
          lastActiveAt: "2026-01-01T00:00:00Z",
        })),
      });
    });
    await harness.settle();

    // 1 agent + 6 humans = 7 total, limit is 6, so one overflows.
    const overflow = harness.container.querySelector(
      ".chat-member-stack-overflow",
    );
    expect(overflow).not.toBeNull();
    expect(overflow?.textContent).toBe("+1");
    harness.unmount();
  });

  test("own presence avatar uses currentUser.name, never Member (CL-6655)", async () => {
    // The signed-in reader is live in presence but not yet on the workbench
    // participants list (or has no handle there) — without currentUser.name
    // the stack title falls back to "Member".
    stubFetch({
      participants: [{ address: "myra@agents.example", handle: "Myra" }],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_self", name: "sawyer" },
    });
    await harness.settle();
    act(() => {
      firstStream().emit("chat.presence.snapshot", {
        members: [
          { principalId: "prn_self", lastActiveAt: "2026-01-01T00:00:00Z" },
        ],
      });
    });
    await harness.settle();

    const presenceAvatars = harness.container.querySelectorAll(
      ".chat-presence-avatar",
    );
    expect(presenceAvatars).toHaveLength(1);
    expect((presenceAvatars[0] as HTMLElement).title).toBe("sawyer");
    expect((presenceAvatars[0] as HTMLElement).title).not.toBe("Member");
    expect(presenceAvatars[0]?.textContent).toBe("S");
    harness.unmount();
  });

  test("own member avatar uses currentUser.name, never the raw handle", async () => {
    stubFetch({
      participants: [
        { address: "myra@agents.example", handle: "Myra" },
        humanParticipant("prn_self", "ada-handle"),
      ],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_self", name: "sawyer" },
    });
    await harness.settle();

    const memberHumans = harness.container.querySelectorAll(
      ".member-avatar:not([data-agent])",
    );
    expect(memberHumans).toHaveLength(1);
    expect((memberHumans[0] as HTMLElement).title).toBe("sawyer");
    expect((memberHumans[0] as HTMLElement).title).not.toBe("ada-handle");
    expect(memberHumans[0]?.textContent).toBe("S");
    harness.unmount();
  });
});
