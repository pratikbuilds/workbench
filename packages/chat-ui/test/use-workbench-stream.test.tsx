// Real-timer wiring for `useWorkbenchStream`, mounted against a DOM (see
// dom-setup.ts) with a controllable `EventSource` stand-in so the hook's
// actual reconnect/poll effects run rather than being reasoned about in the
// abstract. `backoffDelayMs` itself is covered as a pure function in
// test/refresh-and-send.test.ts; this suite proves the wiring around it:
// the stream stays down without ever forcing the caller to render that
// fact, keeps the timeline advancing via polling the whole time, and
// reconnects eagerly on tab refocus / network return.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  parseStreamEventJson,
  useWorkbenchStream,
} from "../src/use-workbench-stream";

const realEventSource = globalThis.EventSource;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: StubEventSource[] = [];

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = StubEventSource.CONNECTING;
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
    this.readyState = StubEventSource.CLOSED;
  }

  open() {
    this.readyState = StubEventSource.OPEN;
    this.onopen?.();
  }

  fail() {
    this.readyState = StubEventSource.CLOSED;
    this.onerror?.();
  }
}

afterEach(() => {
  globalThis.EventSource = realEventSource;
  StubEventSource.instances = [];
});

function mount(
  intervals: {
    pollMs: number;
    baseDelayMs: number;
    maxDelayMs: number;
  },
  onParseError?: (eventType: string) => void,
) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const events: [string, unknown][] = [];
  let pollCount = 0;

  function Host() {
    useWorkbenchStream(
      "/api/tenants/tnt_1/chat/workbenches/c1/stream",
      (eventType, data) => events.push([eventType, data]),
      () => {
        pollCount += 1;
      },
      intervals,
      onParseError,
    );
    return null;
  }

  act(() => {
    root.render(createElement(Host));
  });

  return {
    latest: (): StubEventSource => {
      const instance =
        StubEventSource.instances[StubEventSource.instances.length - 1];
      if (instance === undefined) throw new Error("no EventSource was opened");
      return instance;
    },
    pollCount: () => pollCount,
    events: () => events,
    settle: (ms: number) => act(() => sleep(ms)),
    unmount: () => act(() => root.unmount()),
  };
}

describe("useWorkbenchStream (reconnect + poll wiring)", () => {
  test("a dropped connection keeps the timeline advancing via polling until it reopens", async () => {
    const harness = mount({ pollMs: 20, baseDelayMs: 500, maxDelayMs: 500 });
    harness.latest().fail();
    // startPolling fires an immediate poll, then again every pollMs.
    expect(harness.pollCount()).toBe(1);

    await harness.settle(50);
    expect(harness.pollCount()).toBeGreaterThanOrEqual(2);

    const pollingSnapshot = harness.pollCount();
    harness.latest().open();
    // Reopen triggers exactly one more silent refresh...
    expect(harness.pollCount()).toBe(pollingSnapshot + 1);

    // ...and polling stops: waiting past pollMs again shows no further calls.
    await harness.settle(50);
    expect(harness.pollCount()).toBe(pollingSnapshot + 1);
    harness.unmount();
  });

  test("a tab refocus forces an immediate reconnect attempt instead of waiting out the backoff", async () => {
    const harness = mount({
      pollMs: 1000,
      baseDelayMs: 5000,
      maxDelayMs: 5000,
    });
    harness.latest().fail();
    const failedCount = StubEventSource.instances.length;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(StubEventSource.instances.length).toBe(failedCount + 1);
    harness.unmount();
  });

  test("the network coming back forces an immediate reconnect attempt", async () => {
    const harness = mount({
      pollMs: 1000,
      baseDelayMs: 5000,
      maxDelayMs: 5000,
    });
    harness.latest().fail();
    const failedCount = StubEventSource.instances.length;

    window.dispatchEvent(new Event("online"));

    expect(StubEventSource.instances.length).toBe(failedCount + 1);
    harness.unmount();
  });

  test("a reconnect kick while already live is a no-op — it never interrupts a healthy stream", async () => {
    const harness = mount({
      pollMs: 1000,
      baseDelayMs: 5000,
      maxDelayMs: 5000,
    });
    harness.latest().open();
    const liveCount = StubEventSource.instances.length;

    window.dispatchEvent(new Event("online"));

    expect(StubEventSource.instances.length).toBe(liveCount);
    harness.unmount();
  });

  test("chat.reaction and chat.pin events are forwarded to the caller — live, not just via poll", async () => {
    const harness = mount({
      pollMs: 1000,
      baseDelayMs: 5000,
      maxDelayMs: 5000,
    });
    harness.latest().open();

    harness
      .latest()
      .emit("chat.reaction", { messageId: "m1", emoji: "👍", added: true });
    harness.latest().emit("chat.pin", { messageId: "m1", pinned: true });

    expect(harness.events()).toEqual([
      ["chat.reaction", { messageId: "m1", emoji: "👍", added: true }],
      ["chat.pin", { messageId: "m1", pinned: true }],
    ]);
    harness.unmount();
  });

  test("invalid JSON on chat.message is not forwarded and polls immediately (CL-6837)", async () => {
    const parseErrors: string[] = [];
    const harness = mount(
      {
        pollMs: 1000,
        baseDelayMs: 5000,
        maxDelayMs: 5000,
      },
      (eventType) => parseErrors.push(eventType),
    );
    harness.latest().open();
    const pollsAfterOpen = harness.pollCount();

    harness.latest().emitRaw("chat.message", "not-json{");

    expect(harness.events()).toEqual([]);
    expect(harness.pollCount()).toBe(pollsAfterOpen + 1);
    expect(parseErrors).toEqual(["chat.message"]);
    harness.unmount();
  });

  test("valid JSON on chat.message still forwards and does not poll (CL-6837)", async () => {
    const harness = mount({
      pollMs: 1000,
      baseDelayMs: 5000,
      maxDelayMs: 5000,
    });
    harness.latest().open();
    const pollsAfterOpen = harness.pollCount();

    harness.latest().emit("chat.message", { id: "m1", parts: [] });

    expect(harness.events()).toEqual([
      ["chat.message", { id: "m1", parts: [] }],
    ]);
    expect(harness.pollCount()).toBe(pollsAfterOpen);
    harness.unmount();
  });
});

describe("parseStreamEventJson (CL-6837)", () => {
  test("parses a JSON object through arktype", () => {
    expect(parseStreamEventJson('{"id":"m1"}')).toEqual({
      ok: true,
      data: { id: "m1" },
    });
  });

  test("undefined payload is a successful empty event", () => {
    expect(parseStreamEventJson(undefined)).toEqual({
      ok: true,
      data: undefined,
    });
  });

  test("invalid JSON is a parse miss, not a thrown error", () => {
    expect(parseStreamEventJson("not-json{")).toEqual({ ok: false });
  });

  test("a non-string payload is a parse miss", () => {
    expect(parseStreamEventJson({ id: "already-parsed" })).toEqual({
      ok: false,
    });
  });
});
