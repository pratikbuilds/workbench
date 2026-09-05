// Unit tests for the SSE subscriber registry and its stream bridge —
// split out of `routes.test.ts` alongside `./workbench-events.ts`. The
// live-revocation behavior itself (an `authorize` callback going false
// mid-stream) is covered end to end over real HTTP in
// `workbench-share-routes.test.ts`; these tests only pin the bridge's
// own unit-level contract with a stub `authorize`.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import {
  bridgeWorkbenchStream,
  createWorkbenchSubscriberRegistry,
  createPlatformWorkbenchFanout,
} from "../src/workbench-events";
import { createWorkbenchPresenceRegistry } from "../src/workbench-presence";
import type { ChatWorkbenchEvent, WorkbenchEvents } from "../src/platform-port";

const alwaysAuthorized = () => Promise.resolve(true);

// Every `deliverEvent`/`writeSSE` in the bridge runs through a chained
// promise queue now (the fix for out-of-order writes), which adds a
// handful of microtask hops between a publish and its write landing on
// the stream. Draining generously here is cheaper than pinning an exact
// hop count that breaks the moment the queue's internals change shape.
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function fakeStream(
  writeSSE: (message: unknown) => Promise<void>,
  close: () => Promise<void> = () => Promise.resolve(),
) {
  return { writeSSE, close } as unknown as Parameters<
    typeof bridgeWorkbenchStream
  >[0]["stream"];
}

function noopPlatformEvents(): WorkbenchEvents {
  return {
    subscribeToWorkbench() {
      return () => undefined;
    },
  };
}

describe("createWorkbenchSubscriberRegistry", () => {
  test("publishing delivers to every subscriber of that workbench", () => {
    const registry = createWorkbenchSubscriberRegistry();
    const received: ChatWorkbenchEvent[] = [];
    registry.subscribe("chan_1", (event) => received.push(event));

    registry.publish("chan_1", { type: "chat.typing", data: {} });

    expect(received).toHaveLength(1);
  });

  test("a workbench with no subscribers is a no-op publish", () => {
    const registry = createWorkbenchSubscriberRegistry();
    expect(() =>
      registry.publish("chan_none", { type: "chat.typing", data: {} }),
    ).not.toThrow();
  });

  test("unsubscribing stops delivery", () => {
    const registry = createWorkbenchSubscriberRegistry();
    const received: ChatWorkbenchEvent[] = [];
    const unsubscribe = registry.subscribe("chan_1", (event) =>
      received.push(event),
    );
    unsubscribe();

    registry.publish("chan_1", { type: "chat.typing", data: {} });

    expect(received).toHaveLength(0);
  });
});

describe("createPlatformWorkbenchFanout", () => {
  test("N subscribers on one workbench share a single upstream subscription", () => {
    let subscribeCalls = 0;
    let upstreamUnsubscribeCalls = 0;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench() {
        subscribeCalls += 1;
        return () => {
          upstreamUnsubscribeCalls += 1;
        };
      },
    };
    const fanout = createPlatformWorkbenchFanout(platform);

    const unsubscribeA = fanout.subscribeToWorkbench("chan_1", () => undefined);
    const unsubscribeB = fanout.subscribeToWorkbench("chan_1", () => undefined);
    const unsubscribeC = fanout.subscribeToWorkbench("chan_1", () => undefined);

    expect(subscribeCalls).toBe(1);

    unsubscribeA();
    unsubscribeB();
    expect(upstreamUnsubscribeCalls).toBe(0);

    unsubscribeC();
    expect(upstreamUnsubscribeCalls).toBe(1);
  });

  test("a fanned-out event reaches every local subscriber of that workbench", () => {
    let deliver: ((event: ChatWorkbenchEvent) => void) | undefined;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench(_workbenchId, onEvent) {
        deliver = onEvent;
        return () => undefined;
      },
    };
    const fanout = createPlatformWorkbenchFanout(platform);
    const receivedA: ChatWorkbenchEvent[] = [];
    const receivedB: ChatWorkbenchEvent[] = [];
    fanout.subscribeToWorkbench("chan_1", (event) => receivedA.push(event));
    fanout.subscribeToWorkbench("chan_1", (event) => receivedB.push(event));

    deliver?.({ type: "chat.agent", data: {} });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });

  test("releasing and resubscribing to the same workbench re-subscribes upstream", () => {
    let subscribeCalls = 0;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench() {
        subscribeCalls += 1;
        return () => undefined;
      },
    };
    const fanout = createPlatformWorkbenchFanout(platform);

    fanout.subscribeToWorkbench("chan_1", () => undefined)();
    fanout.subscribeToWorkbench("chan_1", () => undefined);

    expect(subscribeCalls).toBe(2);
  });

  test("different workbenches each get their own upstream subscription", () => {
    let subscribeCalls = 0;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench() {
        subscribeCalls += 1;
        return () => undefined;
      },
    };
    const fanout = createPlatformWorkbenchFanout(platform);

    fanout.subscribeToWorkbench("chan_1", () => undefined);
    fanout.subscribeToWorkbench("chan_2", () => undefined);

    expect(subscribeCalls).toBe(2);
  });
});

describe("bridgeWorkbenchStream", () => {
  afterEach(() => {
    // Some tests below stub `@corbits/error-sink`'s `reportError`; always
    // restore it so a mock from one test can't leak into the next.
    (
      errorSink.reportError as unknown as { mockRestore?: () => void }
    ).mockRestore?.();
  });

  test("forwards a registry publish onto the stream as an SSE write", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const writes: unknown[] = [];
    const stream = fakeStream((message) => {
      writes.push(message);
      return Promise.resolve();
    });

    bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
    });
    registry.publish("chan_1", { type: "chat.typing", data: { a: 1 } });
    await flush();

    expect(writes).toHaveLength(1);
  });

  test("a write that throws removes that subscriber and closes the stream (Hono's own writeSSE never rejects; this covers a stream implementation that does)", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    let writeCount = 0;
    let closeCount = 0;
    const stream = fakeStream(
      () => {
        writeCount += 1;
        return Promise.reject(new Error("client disconnected"));
      },
      () => {
        closeCount += 1;
        return Promise.resolve();
      },
    );

    bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    // The first publish attempted a write that failed, unsubscribed the
    // local subscriber, and closed the stream so the client's
    // `EventSource` actually sees the connection end and reconnects
    // (CL-7197) — a zombie subscriber would keep attempting (and
    // failing) writes forever, and a stream left open would look live
    // while being dead.
    expect(writeCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  test("a writeSSE that resolves while the underlying writer is errored (Hono swallows writer failures) removes that subscriber and closes the stream", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    let writeCount = 0;
    let closeCount = 0;
    const stream = Object.assign(
      fakeStream(
        () => {
          writeCount += 1;
          return Promise.resolve();
        },
        () => {
          closeCount += 1;
          return Promise.resolve();
        },
      ),
      { writer: { desiredSize: null } },
    );
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");

    bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    // Hono's StreamingApi.write catches the writer's rejection and
    // resolves anyway, so the throw-path test above never fires on a
    // real stream. The errored writer (`desiredSize === null`) is the
    // signal that the write actually failed (CL-7246).
    expect(writeCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "workbench SSE write failed" }),
    );
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "chat.workbenchStream.write",
      roomId: "chan_1",
    });
  });

  test("a writeSSE that never resolves is treated as stalled, reported, and closes the stream", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    let writeCount = 0;
    let closeCount = 0;
    const stream = fakeStream(
      () => {
        writeCount += 1;
        return new Promise(() => undefined);
      },
      () => {
        closeCount += 1;
        return Promise.resolve();
      },
    );
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");

    bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
      writeTimeoutMs: 20,
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    expect(writeCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "workbench SSE write stalled" }),
    );
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "chat.workbenchStream.write",
      roomId: "chan_1",
    });
  });

  test("a stalled write aborts the writer instead of awaiting a hung close()", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    let abortCount = 0;
    let closeCount = 0;
    const stream = Object.assign(
      fakeStream(
        () => new Promise(() => undefined),
        () => {
          closeCount += 1;
          return new Promise(() => undefined);
        },
      ),
      {
        writer: {
          desiredSize: 1,
          abort: () => {
            abortCount += 1;
          },
        },
      },
    );
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");

    const { closed } = bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
      writeTimeoutMs: 20,
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });

    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("hung on close()")), 200),
      ),
    ]);

    expect(abortCount).toBe(1);
    expect(closeCount).toBe(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "workbench SSE write stalled" }),
    );
  });

  test("a client abort mid-write does not reportError after onAbort teardown", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    let abortCount = 0;
    const stream = Object.assign(
      fakeStream(() => new Promise(() => undefined)),
      { aborted: false },
    );
    Reflect.set(stream, "writer", {
      desiredSize: 1,
      abort: () => {
        abortCount += 1;
      },
    });
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");

    const { teardown } = bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
      writeTimeoutMs: 20,
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    stream.aborted = true;
    teardown();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(report).not.toHaveBeenCalled();
    expect(abortCount).toBe(1);
  });

  test("a platform subscribe that throws still opens the stream, registry-only, and reports the failure", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const writes: unknown[] = [];
    const stream = fakeStream((message) => {
      writes.push(message);
      return Promise.resolve();
    });
    const throwingPlatform: WorkbenchEvents = {
      subscribeToWorkbench() {
        throw new Error("folded run not resolved yet");
      },
    };
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");

    expect(() =>
      bridgeWorkbenchStream({
        registry,
        platform: throwingPlatform,
        workbenchId: "chan_1",
        stream,
        authorize: alwaysAuthorized,
      }),
    ).not.toThrow();

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    expect(writes).toHaveLength(1);
    // The bare `catch {}` this degrades through must not swallow the
    // failure silently — it reports through `reportError` with context
    // a person can act on.
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "chat.workbenchStream.platformSubscribe",
      roomId: "chan_1",
    });
  });

  test("authorize going false unsubscribes both sources and closes the stream, without writing the event", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const writes: unknown[] = [];
    let closeCount = 0;
    const stream = fakeStream(
      (message) => {
        writes.push(message);
        return Promise.resolve();
      },
      () => {
        closeCount += 1;
        return Promise.resolve();
      },
    );
    let platformUnsubscribed = false;
    const platform: WorkbenchEvents = {
      subscribeToWorkbench() {
        return () => {
          platformUnsubscribed = true;
        };
      },
    };

    bridgeWorkbenchStream({
      registry,
      platform,
      workbenchId: "chan_1",
      stream,
      authorize: () => Promise.resolve(false),
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    expect(writes).toHaveLength(0);
    expect(closeCount).toBe(1);
    expect(platformUnsubscribed).toBe(true);

    // A further publish after revocation must not write, or close again.
    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    expect(writes).toHaveLength(0);
    expect(closeCount).toBe(1);
  });

  test("authorize going false closes a real Hono-shaped stream instead of aborting the writer", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    let abortCount = 0;
    let closeCount = 0;
    const stream = Object.assign(
      fakeStream(
        () => Promise.resolve(),
        () => {
          closeCount += 1;
          return Promise.resolve();
        },
      ),
      {
        abort: () => {
          abortCount += 1;
        },
        writer: {
          desiredSize: 1,
          abort: () => {
            abortCount += 1;
          },
        },
      },
    );

    bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: () => Promise.resolve(false),
    });

    registry.publish("chan_1", { type: "chat.typing", data: {} });
    await flush();

    expect(closeCount).toBe(1);
    expect(abortCount).toBe(0);
  });

  test("an authorize call that rejects is caught, reported, and closes the stream", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    let closeCount = 0;
    const stream = fakeStream(
      () => Promise.resolve(),
      () => {
        closeCount += 1;
        return Promise.resolve();
      },
    );
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream,
        authorize: () => Promise.reject(new Error("db blip")),
      });

      registry.publish("chan_1", { type: "chat.typing", data: {} });
      await flush();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(closeCount).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "chat.workbenchStream.authorize",
      roomId: "chan_1",
    });
    expect(unhandledRejections).toHaveLength(0);
  });

  test("deliveries are serialized: a slow authorize on the first event cannot let a later event write first", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const writes: string[] = [];
    const stream = fakeStream((message) => {
      const { data } = message as { data: string };
      writes.push(data);
      return Promise.resolve();
    });
    let authorizeCalls = 0;
    const authorize = (): Promise<boolean> => {
      authorizeCalls += 1;
      // The first call (event A's) resolves slowly; every later call
      // resolves immediately. Without serialized delivery, B's write
      // could land before A's.
      if (authorizeCalls === 1) {
        return new Promise((resolve) => setTimeout(() => resolve(true), 20));
      }
      return Promise.resolve(true);
    };

    bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize,
    });

    registry.publish("chan_1", { type: "chat.typing", data: "A" });
    registry.publish("chan_1", { type: "chat.typing", data: "B" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(writes.map((data) => JSON.parse(data) as string)).toEqual([
      "A",
      "B",
    ]);
  });

  test("the presence snapshot is written before any event racing the setup window", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const presenceRegistry = createWorkbenchPresenceRegistry();
    const writes: { event?: string }[] = [];
    const stream = fakeStream((message) => {
      writes.push(message as { event?: string });
      return Promise.resolve();
    });
    // A platform whose `subscribeToWorkbench` delivers an event the
    // instant it's installed — the exact window in which the old
    // implementation's floating snapshot write could still be pending.
    const racingPlatform: WorkbenchEvents = {
      subscribeToWorkbench(_workbenchId, onEvent) {
        onEvent({ type: "chat.agent", data: {} });
        return () => undefined;
      },
    };

    bridgeWorkbenchStream({
      registry,
      platform: racingPlatform,
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
      presence: { registry: presenceRegistry, principalId: "prn_ada" },
    });

    await flush();

    expect(writes[0]?.event).toBe("chat.presence.snapshot");
  });

  test("the route no longer parks forever: `closed` resolves once teardown runs", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const stream = fakeStream(() => Promise.resolve());

    const { teardown, closed } = bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
    });

    let settled = false;
    void closed.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    teardown();
    await flush();

    expect(settled).toBe(true);
  });

  test("sends a periodic keepalive and stops once torn down", async () => {
    const registry = createWorkbenchSubscriberRegistry();
    const events: (string | undefined)[] = [];
    const stream = fakeStream((message) => {
      events.push((message as { event?: string }).event);
      return Promise.resolve();
    });

    const { teardown } = bridgeWorkbenchStream({
      registry,
      platform: noopPlatformEvents(),
      workbenchId: "chan_1",
      stream,
      authorize: alwaysAuthorized,
      keepaliveIntervalMs: 5,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const keepalivesBeforeTeardown = events.filter(
      (event) => event === "keepalive",
    ).length;
    expect(keepalivesBeforeTeardown).toBeGreaterThan(0);

    teardown();
    events.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(events).toHaveLength(0);
  });

  describe("presence", () => {
    test("connecting delivers a snapshot directly to this stream and broadcasts an online delta", async () => {
      const registry = createWorkbenchSubscriberRegistry();
      const presenceRegistry = createWorkbenchPresenceRegistry();
      presenceRegistry.connect("chan_1", "prn_bob");
      const writes: { event?: string; data?: string }[] = [];
      const stream = fakeStream((message) => {
        writes.push(message as { event?: string; data?: string });
        return Promise.resolve();
      });

      bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream,
        authorize: alwaysAuthorized,
        presence: { registry: presenceRegistry, principalId: "prn_ada" },
      });
      await flush();

      const snapshotWrite = writes.find(
        (write) => write.event === "chat.presence.snapshot",
      );
      expect(snapshotWrite).toBeDefined();
      const snapshot = JSON.parse(snapshotWrite?.data ?? "{}") as {
        members: { principalId: string }[];
      };
      // The connecting principal is already in the roster this stream
      // is handed — `connect` happens before the snapshot is read.
      expect(
        snapshot.members.map((member) => member.principalId).sort(),
      ).toEqual(["prn_ada", "prn_bob"]);

      const onlineWrite = writes.find(
        (write) => write.event === "chat.presence",
      );
      expect(onlineWrite).toBeDefined();
      expect(JSON.parse(onlineWrite?.data ?? "{}")).toMatchObject({
        principalId: "prn_ada",
        state: "online",
      });
    });

    test("tearing down a principal's only connection broadcasts an offline delta", async () => {
      const registry = createWorkbenchSubscriberRegistry();
      const presenceRegistry = createWorkbenchPresenceRegistry();
      const stream = fakeStream(() => Promise.resolve());
      // A separate observer, not the stream tearing down — that stream
      // has already unsubscribed itself by the time the offline delta
      // publishes, exactly like any other subscriber that just closed.
      const observed: ChatWorkbenchEvent[] = [];
      registry.subscribe("chan_1", (event) => observed.push(event));

      const { teardown } = bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream,
        authorize: alwaysAuthorized,
        presence: { registry: presenceRegistry, principalId: "prn_ada" },
      });
      await flush();
      observed.length = 0;

      teardown();
      await flush();

      expect(presenceRegistry.snapshot("chan_1")).toEqual([]);
      const offlineEvent = observed.find(
        (event) => event.type === "chat.presence",
      );
      expect(offlineEvent).toBeDefined();
      expect(offlineEvent?.data).toMatchObject({
        principalId: "prn_ada",
        state: "offline",
      });
    });

    test("tearing down one of two open connections for the same principal does not broadcast offline", async () => {
      const registry = createWorkbenchSubscriberRegistry();
      const presenceRegistry = createWorkbenchPresenceRegistry();
      const writesA: { event?: string; data?: string }[] = [];
      const writesB: { event?: string; data?: string }[] = [];
      const streamA = fakeStream((message) => {
        writesA.push(message as { event?: string; data?: string });
        return Promise.resolve();
      });
      const streamB = fakeStream((message) => {
        writesB.push(message as { event?: string; data?: string });
        return Promise.resolve();
      });

      const { teardown: teardownA } = bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream: streamA,
        authorize: alwaysAuthorized,
        presence: { registry: presenceRegistry, principalId: "prn_ada" },
      });
      bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream: streamB,
        authorize: alwaysAuthorized,
        presence: { registry: presenceRegistry, principalId: "prn_ada" },
      });
      await flush();
      writesB.length = 0;

      teardownA();
      await flush();

      // Still connected via the second stream — no offline delta.
      expect(
        presenceRegistry.snapshot("chan_1").map((member) => member.principalId),
      ).toEqual(["prn_ada"]);
      expect(writesB.some((write) => write.event === "chat.presence")).toBe(
        false,
      );
    });

    test("no presence option: the original no-presence behavior is unchanged", async () => {
      const registry = createWorkbenchSubscriberRegistry();
      const writes: unknown[] = [];
      const stream = fakeStream((message) => {
        writes.push(message);
        return Promise.resolve();
      });

      bridgeWorkbenchStream({
        registry,
        platform: noopPlatformEvents(),
        workbenchId: "chan_1",
        stream,
        authorize: alwaysAuthorized,
      });
      await flush();

      expect(writes).toHaveLength(0);
    });
  });
});
