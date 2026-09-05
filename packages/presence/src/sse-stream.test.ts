import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import { bindPresenceStream } from "./sse-stream";
import type {
  PresenceDocSnapshotListener,
  PresenceDocUpdateListener,
  PresenceRoomKey,
  PresenceRoomListener,
} from "./room-registry";

const KEY: PresenceRoomKey = { tenantId: "tnt_a", surface: "channel:chn_1" };

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
    typeof bindPresenceStream
  >[0]["stream"];
}

function fakeRegistry() {
  let unsubPresence = 0;
  let unsubDoc = 0;
  let unsubSnapshots = 0;
  return {
    subscribe(_key: PresenceRoomKey, listener: PresenceRoomListener) {
      listener([]);
      return () => {
        unsubPresence += 1;
      };
    },
    subscribeDocUpdates(
      _key: PresenceRoomKey,
      _listener: PresenceDocUpdateListener,
    ) {
      return () => {
        unsubDoc += 1;
      };
    },
    subscribeSnapshots(
      _key: PresenceRoomKey,
      _listener: PresenceDocSnapshotListener,
    ) {
      return () => {
        unsubSnapshots += 1;
      };
    },
    unsubCounts() {
      return { unsubPresence, unsubDoc, unsubSnapshots };
    },
  };
}

describe("bindPresenceStream", () => {
  afterEach(() => {
    (
      errorSink.reportError as unknown as { mockRestore?: () => void }
    ).mockRestore?.();
  });

  test("forwards a presence snapshot onto the stream as an SSE write", async () => {
    const writes: unknown[] = [];
    const stream = fakeStream((message) => {
      writes.push(message);
      return Promise.resolve();
    });
    bindPresenceStream({
      stream,
      registry: fakeRegistry(),
      key: KEY,
    });
    await flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ event: "presence.state" });
  });

  test("a stalled write aborts the writer instead of awaiting a hung close()", async () => {
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
    const registry = fakeRegistry();

    const { closed } = bindPresenceStream({
      stream,
      registry,
      key: KEY,
      writeTimeoutMs: 20,
    });

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
      expect.objectContaining({ message: "presence SSE write stalled" }),
    );
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "presence.stream.write",
      tenantId: "tnt_a",
      extra: { surface: "channel:chn_1" },
    });
    expect(registry.unsubCounts()).toEqual({
      unsubPresence: 1,
      unsubDoc: 1,
      unsubSnapshots: 1,
    });
  });

  test("a client abort mid-write does not reportError after onAbort teardown", async () => {
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

    const { teardown } = bindPresenceStream({
      stream,
      registry: fakeRegistry(),
      key: KEY,
      writeTimeoutMs: 20,
    });
    await Promise.resolve();

    stream.aborted = true;
    teardown();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(report).not.toHaveBeenCalled();
    expect(abortCount).toBe(1);
  });

  test("an errored writer after a swallowed write reports and tears down", async () => {
    const stream = Object.assign(
      fakeStream(() => Promise.resolve()),
      { writer: { desiredSize: null } },
    );
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const registry = fakeRegistry();

    bindPresenceStream({ stream, registry, key: KEY });
    await flush();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "presence SSE write failed" }),
    );
    expect(registry.unsubCounts().unsubPresence).toBe(1);
  });
});
