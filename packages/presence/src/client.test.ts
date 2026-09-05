import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  connectPresence,
  type PresenceError,
  type PresenceEventSourceLike,
  type PresenceFetch,
  type PresenceStreamEvent,
} from "./client";
import { decodeBase64, encodeBase64 } from "./base64";
import type { PresenceState } from "./room-registry";

class FakeEventSource implements PresenceEventSourceLike {
  private readonly listeners = new Map<
    string,
    Set<(event: PresenceStreamEvent) => void>
  >();
  closed = false;

  addEventListener(
    type: string,
    listener: (event: PresenceStreamEvent) => void,
  ): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

function fakeFetch(
  calls: { path: string; body: unknown }[],
  joinResponse: unknown = {},
): PresenceFetch {
  return (url, init) => {
    const body = JSON.parse(init.body) as unknown;
    calls.push({ path: url, body });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(joinResponse),
    });
  };
}

/** A `PresenceFetch` whose response per operation is scripted by
 * `statusFor`, defaulting to 200 for anything unlisted — for exercising
 * failure and rejoin paths `fakeFetch`'s always-succeeds shape can't. */
function scriptedFetch(
  calls: string[],
  statusFor: (path: string) => number | "reject",
): PresenceFetch {
  return (url) => {
    calls.push(url);
    const status = statusFor(url);
    if (status === "reject") return Promise.reject(new Error("network down"));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({}),
    });
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("connectPresence", () => {
  test("joins immediately and opens the room's SSE stream", () => {
    const calls: { path: string; body: unknown }[] = [];
    let openedUrl = "";
    const source = new FakeEventSource();

    const handle = connectPresence({
      roomUrl: "/api/tenants/tnt_1/presence/rooms/channel:chn_1",
      displayName: "Alice",
      fetchImpl: fakeFetch(calls),
      openEventSource: (url) => {
        openedUrl = url;
        return source;
      },
    });

    expect(openedUrl).toBe(
      "/api/tenants/tnt_1/presence/rooms/channel:chn_1/stream",
    );
    expect(calls[0]?.path).toBe(
      "/api/tenants/tnt_1/presence/rooms/channel:chn_1/join",
    );
    expect(calls[0]?.body).toEqual({ displayName: "Alice" });
    handle.disconnect();
  });

  test("subscribers receive every snapshot the stream emits", () => {
    const source = new FakeEventSource();
    const handle = connectPresence({
      roomUrl: "/rooms/channel:chn_1",
      fetchImpl: fakeFetch([]),
      openEventSource: () => source,
    });

    const received: (readonly PresenceState[])[] = [];
    handle.subscribe((members) => received.push(members));

    const members: PresenceState[] = [
      {
        principalId: "prn_alice",
        displayName: "Alice",
        color: "hsl(0 65% 45%)",
      },
    ];
    source.emit("presence.state", JSON.stringify(members));

    expect(received).toHaveLength(2); // initial empty snapshot, then the emitted one
    expect(received[1]).toEqual(members);
    handle.disconnect();
  });

  test("publishCursor and publishTyping post heartbeats with the patch", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const handle = connectPresence({
      roomUrl: "/rooms/channel:chn_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => new FakeEventSource(),
    });
    // Let the initial join's response settle before publishing: a patch
    // published before the room has confirmed the join rejoins instead
    // of heartbeating a membership the server doesn't have yet (CL-7202).
    await Promise.resolve();
    await Promise.resolve();
    calls.length = 0; // drop the initial join call

    handle.publishCursor({ x: 5, y: 6, surfaceVersion: 1 });
    handle.publishTyping(true);

    expect(calls).toEqual([
      {
        path: "/rooms/channel:chn_1/heartbeat",
        body: { cursor: { x: 5, y: 6, surfaceVersion: 1 } },
      },
      { path: "/rooms/channel:chn_1/heartbeat", body: { typing: true } },
    ]);
    handle.disconnect();
  });

  test("disconnect closes the stream and posts leave, and further publishes are no-ops", () => {
    const calls: { path: string; body: unknown }[] = [];
    const source = new FakeEventSource();
    const handle = connectPresence({
      roomUrl: "/rooms/channel:chn_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => source,
    });
    calls.length = 0;

    handle.disconnect();

    expect(source.closed).toBe(true);
    expect(calls).toEqual([{ path: "/rooms/channel:chn_1/leave", body: {} }]);

    calls.length = 0;
    handle.publishCursor({ x: 1, y: 1, surfaceVersion: 1 });
    expect(calls).toEqual([]);
  });
});

describe("connectPresence: doc sync", () => {
  test("without a `doc` option, no doc.update listener is attached and join is a plain awareness join", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch(calls, {
        docUpdate: encodeBase64(new Uint8Array()),
      }),
      openEventSource: () => new FakeEventSource(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/rooms/artifact:art_1/join");
    handle.disconnect();
  });

  test("the join response's docUpdate seeds the local doc", async () => {
    const seedDoc = new Y.Doc();
    seedDoc.getText("content").insert(0, "seeded from server");
    const joinResponse = {
      docUpdate: encodeBase64(Y.encodeStateAsUpdate(seedDoc)),
    };

    const doc = new Y.Doc();
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch([], joinResponse),
      openEventSource: () => new FakeEventSource(),
      doc,
    });

    // Let the join promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(doc.getText("content").toString()).toBe("seeded from server");
    handle.disconnect();
  });

  test("a doc.update SSE event applies into the local doc", async () => {
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "from a peer");
    const source = new FakeEventSource();
    const doc = new Y.Doc();

    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch([]),
      openEventSource: () => source,
      doc,
    });

    source.emit(
      "doc.update",
      JSON.stringify({ update: encodeBase64(Y.encodeStateAsUpdate(remote)) }),
    );

    expect(doc.getText("content").toString()).toBe("from a peer");
    handle.disconnect();
  });

  test("a local doc edit is posted to the room's /update endpoint", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const doc = new Y.Doc();
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => new FakeEventSource(),
      doc,
    });
    calls.length = 0; // drop the initial join call

    doc.getText("content").insert(0, "typed locally");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/rooms/artifact:art_1/update");
    const posted = new Y.Doc();
    Y.applyUpdate(
      posted,
      decodeBase64((calls[0]?.body as { update: string }).update),
    );
    expect(posted.getText("content").toString()).toBe("typed locally");
    handle.disconnect();
  });

  test("applying a remote doc.update does not echo back as a local /update post", () => {
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "remote text");
    const source = new FakeEventSource();
    const calls: { path: string; body: unknown }[] = [];
    const doc = new Y.Doc();

    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => source,
      doc,
    });
    calls.length = 0;

    source.emit(
      "doc.update",
      JSON.stringify({ update: encodeBase64(Y.encodeStateAsUpdate(remote)) }),
    );

    expect(calls.filter((c) => c.path.endsWith("/update"))).toHaveLength(0);
    handle.disconnect();
  });

  test("disconnect detaches the doc update listener: further local edits are not posted", () => {
    const calls: { path: string; body: unknown }[] = [];
    const doc = new Y.Doc();
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch(calls),
      openEventSource: () => new FakeEventSource(),
      doc,
    });
    handle.disconnect();
    calls.length = 0;

    doc.getText("content").insert(0, "after disconnect");

    expect(calls).toEqual([]);
  });

  test("a doc.saved SSE event calls onSaved with the version and timestamp", () => {
    const source = new FakeEventSource();
    const saved: { version: number; savedAt: number }[] = [];
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch([]),
      openEventSource: () => source,
      onSaved: (info) => saved.push(info),
    });

    source.emit("doc.saved", JSON.stringify({ version: 12, savedAt: 1700 }));

    expect(saved).toEqual([{ version: 12, savedAt: 1700 }]);
    handle.disconnect();
  });

  test("a malformed doc.saved payload is dropped rather than calling onSaved with garbage", () => {
    const source = new FakeEventSource();
    const saved: unknown[] = [];
    const handle = connectPresence({
      roomUrl: "/rooms/artifact:art_1",
      fetchImpl: fakeFetch([]),
      openEventSource: () => source,
      onSaved: (info) => saved.push(info),
    });

    source.emit("doc.saved", "not json");
    source.emit("doc.saved", JSON.stringify({ version: "12" }));

    expect(saved).toEqual([]);
    handle.disconnect();
  });
});

// CL-7202: the client used to blind-post every join/heartbeat/leave/update
// request (`.catch(() => undefined)`, no `response.ok` check anywhere, no
// way for a caller to hear about a failure), and never rejoined after a
// failed join or a heartbeat the server had already forgotten about (404
// `not_joined`) — all while the SSE stream stayed open regardless, so the
// UI kept reading as live.
describe("connectPresence: error reporting and rejoin (CL-7202)", () => {
  const ROOM_URL = "/rooms/channel:chn_1";

  test("a join request that never reaches the server is reported through onError, not swallowed", async () => {
    const calls: string[] = [];
    const errors: PresenceError[] = [];
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, () => "reject"),
      openEventSource: () => new FakeEventSource(),
    });
    handle.onError((error) => errors.push(error));

    await flushMicrotasks();

    expect(calls).toEqual([`${ROOM_URL}/join`]);
    expect(errors).toEqual([{ operation: "join" }]);
    handle.disconnect();
  });

  test("a non-ok join response is reported through onError with its status", async () => {
    const calls: string[] = [];
    const errors: PresenceError[] = [];
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, () => 500),
      openEventSource: () => new FakeEventSource(),
    });
    handle.onError((error) => errors.push(error));

    await flushMicrotasks();

    expect(errors).toEqual([{ operation: "join", status: 500 }]);
    handle.disconnect();
  });

  test("publishing before the room has confirmed the join rejoins instead of heartbeating a membership it doesn't have yet", async () => {
    let clock = 0;
    const calls: string[] = [];
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, () => 500),
      openEventSource: () => new FakeEventSource(),
      now: () => clock,
    });

    await flushMicrotasks();
    clock = 1_000; // past the first failure's backoff window
    handle.publishTyping(true);
    await flushMicrotasks();

    expect(calls).toEqual([`${ROOM_URL}/join`, `${ROOM_URL}/join`]);
    handle.disconnect();
  });

  test("a heartbeat 404 (self-eviction) triggers an automatic rejoin", async () => {
    const calls: string[] = [];
    let joinCount = 0;
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, (path) => {
        if (path.endsWith("/join")) {
          joinCount += 1;
          return 200;
        }
        if (path.endsWith("/heartbeat")) return 404;
        return 200;
      }),
      openEventSource: () => new FakeEventSource(),
    });
    const errors: PresenceError[] = [];
    handle.onError((error) => errors.push(error));

    await flushMicrotasks();
    expect(joinCount).toBe(1);

    handle.publishCursor({ x: 1, y: 2, surfaceVersion: 1 });
    await flushMicrotasks();

    expect(calls).toEqual([
      `${ROOM_URL}/join`,
      `${ROOM_URL}/heartbeat`,
      `${ROOM_URL}/join`,
    ]);
    expect(errors).toEqual([{ operation: "heartbeat", status: 404 }]);
    expect(joinCount).toBe(2);
    handle.disconnect();
  });

  test("a heartbeat succeeds normally once join has succeeded, without rejoining", async () => {
    const calls: string[] = [];
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, () => 200),
      openEventSource: () => new FakeEventSource(),
    });

    await flushMicrotasks();
    handle.publishTyping(true);
    await flushMicrotasks();

    expect(calls).toEqual([`${ROOM_URL}/join`, `${ROOM_URL}/heartbeat`]);
    handle.disconnect();
  });

  test("a failed doc update is reported through onError", async () => {
    const calls: string[] = [];
    const doc = new Y.Doc();
    const errors: PresenceError[] = [];
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, (path) =>
        path.endsWith("/update") ? 413 : 200,
      ),
      openEventSource: () => new FakeEventSource(),
      doc,
    });
    handle.onError((error) => errors.push(error));

    await flushMicrotasks();
    doc.getText("content").insert(0, "hello");
    await flushMicrotasks();

    expect(errors).toEqual([{ operation: "update", status: 413 }]);
    handle.disconnect();
  });

  test("onError's unsubscribe stops further delivery", async () => {
    const calls: string[] = [];
    const errors: PresenceError[] = [];
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, () => 500),
      openEventSource: () => new FakeEventSource(),
    });
    const unsubscribe = handle.onError((error) => errors.push(error));
    await flushMicrotasks();
    unsubscribe();

    handle.publishTyping(true);
    await flushMicrotasks();

    expect(errors).toEqual([{ operation: "join", status: 500 }]);
    handle.disconnect();
  });

  test("a successful join is reported through onRecovered", async () => {
    let recovered = 0;
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: fakeFetch([]),
      openEventSource: () => new FakeEventSource(),
    });
    handle.onRecovered(() => {
      recovered += 1;
    });

    await flushMicrotasks();

    expect(recovered).toBe(1);
    handle.disconnect();
  });

  test("a failed join is not reported through onRecovered", async () => {
    let recovered = 0;
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch([], () => 500),
      openEventSource: () => new FakeEventSource(),
    });
    handle.onRecovered(() => {
      recovered += 1;
    });

    await flushMicrotasks();

    expect(recovered).toBe(0);
    handle.disconnect();
  });

  test("a successful heartbeat after a failed one is reported through onRecovered", async () => {
    let heartbeatStatus = 500;
    let recovered = 0;
    const fetchImpl: PresenceFetch = (url) => {
      const status = url.endsWith("/heartbeat") ? heartbeatStatus : 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve({}),
      });
    };
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl,
      openEventSource: () => new FakeEventSource(),
    });
    handle.onRecovered(() => {
      recovered += 1;
    });
    await flushMicrotasks();
    expect(recovered).toBe(1);

    handle.publishTyping(true);
    await flushMicrotasks();
    expect(recovered).toBe(1);

    heartbeatStatus = 200;
    handle.publishTyping(false);
    await flushMicrotasks();
    expect(recovered).toBe(2);
    handle.disconnect();
  });

  test("onRecovered's unsubscribe stops further delivery", async () => {
    let recovered = 0;
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: fakeFetch([]),
      openEventSource: () => new FakeEventSource(),
    });
    const unsubscribe = handle.onRecovered(() => {
      recovered += 1;
    });
    await flushMicrotasks();
    expect(recovered).toBe(1);
    unsubscribe();

    handle.publishTyping(true);
    await flushMicrotasks();
    expect(recovered).toBe(1);
    handle.disconnect();
  });

  test("a client stuck unable to join backs off instead of re-posting on every publish call", async () => {
    let clock = 0;
    const calls: string[] = [];
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, () => 500),
      openEventSource: () => new FakeEventSource(),
      now: () => clock,
    });

    await flushMicrotasks();
    expect(calls).toEqual([`${ROOM_URL}/join`]); // the initial attempt

    // A caller publishing cursor moves in a tight loop while unjoined
    // must not turn into a `/join` per call.
    handle.publishCursor({ x: 1, y: 1, surfaceVersion: 1 });
    handle.publishCursor({ x: 2, y: 2, surfaceVersion: 1 });
    handle.publishCursor({ x: 3, y: 3, surfaceVersion: 1 });
    await flushMicrotasks();
    expect(calls).toEqual([`${ROOM_URL}/join`]);

    // Still inside the backoff window after the first failure.
    clock = 999;
    handle.publishCursor({ x: 4, y: 4, surfaceVersion: 1 });
    await flushMicrotasks();
    expect(calls).toEqual([`${ROOM_URL}/join`]);

    // Past the backoff window: one retry is allowed.
    clock = 1_000;
    handle.publishCursor({ x: 5, y: 5, surfaceVersion: 1 });
    await flushMicrotasks();
    expect(calls).toEqual([`${ROOM_URL}/join`, `${ROOM_URL}/join`]);

    handle.disconnect();
  });

  test("a join success resets the backoff, so a later failure streak starts from the base delay again", async () => {
    let clock = 0;
    const calls: string[] = [];
    let failNextJoin = true;
    let heartbeatStatus = 200;
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl: scriptedFetch(calls, (path) => {
        if (path.endsWith("/join")) return failNextJoin ? 500 : 200;
        if (path.endsWith("/heartbeat")) return heartbeatStatus;
        return 200;
      }),
      openEventSource: () => new FakeEventSource(),
      now: () => clock,
    });

    await flushMicrotasks(); // fails once (attempt 1): 1s backoff scheduled

    clock = 1_000;
    failNextJoin = false;
    handle.publishCursor({ x: 1, y: 1, surfaceVersion: 1 });
    await flushMicrotasks(); // succeeds; joinFailureCount resets to 0

    // Evict via a 404'd heartbeat and let the immediate rejoin attempt
    // fail too: if the reset above hadn't happened, this failure would
    // be attempt 3 (4s backoff) rather than a fresh attempt 1 (1s).
    heartbeatStatus = 404;
    failNextJoin = true;
    calls.length = 0;
    handle.publishTyping(true); // joined === true, so this sends a heartbeat
    await flushMicrotasks();
    expect(calls).toEqual([`${ROOM_URL}/heartbeat`, `${ROOM_URL}/join`]);

    clock = 1_999; // short of a full second past the failure at clock 1_000
    handle.publishCursor({ x: 2, y: 2, surfaceVersion: 1 });
    await flushMicrotasks();
    expect(calls).toEqual([`${ROOM_URL}/heartbeat`, `${ROOM_URL}/join`]);

    clock = 2_000; // a full second past the failure
    handle.publishCursor({ x: 3, y: 3, surfaceVersion: 1 });
    await flushMicrotasks();
    expect(calls).toEqual([
      `${ROOM_URL}/heartbeat`,
      `${ROOM_URL}/join`,
      `${ROOM_URL}/join`,
    ]);

    handle.disconnect();
  });

  test("a doc update that fails to post is redelivered once the next heartbeat succeeds", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const doc = new Y.Doc();
    const errors: PresenceError[] = [];
    let updateStatus = 500;
    const fetchImpl: PresenceFetch = (url, init) => {
      const body = JSON.parse(init.body) as unknown;
      calls.push({ path: url, body });
      const status = url.endsWith("/update") ? updateStatus : 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve({}),
      });
    };
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl,
      openEventSource: () => new FakeEventSource(),
      doc,
    });
    handle.onError((error) => errors.push(error));

    await flushMicrotasks(); // join settles
    doc.getText("content").insert(0, "hello");
    await flushMicrotasks(); // the update POST fails and is queued

    expect(errors).toEqual([{ operation: "update", status: 500 }]);
    const failedCall = calls.find((c) => c.path.endsWith("/update"));
    calls.length = 0;

    // The next successful heartbeat redelivers the queued update with
    // the exact same payload — nothing about the failed edit is lost.
    updateStatus = 200;
    handle.publishTyping(true);
    await flushMicrotasks();

    expect(calls.map((c) => c.path)).toEqual([
      `${ROOM_URL}/heartbeat`,
      `${ROOM_URL}/update`,
    ]);
    expect(calls.find((c) => c.path.endsWith("/update"))?.body).toEqual(
      failedCall?.body,
    );
    // No second `onError` fire for the now-successful redelivery.
    expect(errors).toEqual([{ operation: "update", status: 500 }]);
    handle.disconnect();
  });

  test("queued updates are redelivered in the order they were made", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const doc = new Y.Doc();
    let updateStatus = 500;
    const fetchImpl: PresenceFetch = (url, init) => {
      const body = JSON.parse(init.body) as unknown;
      calls.push({ path: url, body });
      const status = url.endsWith("/update") ? updateStatus : 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve({}),
      });
    };
    const handle = connectPresence({
      roomUrl: ROOM_URL,
      fetchImpl,
      openEventSource: () => new FakeEventSource(),
      doc,
    });

    await flushMicrotasks();
    doc.getText("content").insert(0, "a");
    await flushMicrotasks();
    doc.getText("content").insert(1, "b");
    await flushMicrotasks();
    const [firstFailedUpdate, secondFailedUpdate] = calls
      .filter((c) => c.path.endsWith("/update"))
      .map((c) => c.body);
    calls.length = 0;

    updateStatus = 200;
    handle.publishTyping(true);
    await flushMicrotasks(); // redelivers the first queued update
    handle.publishTyping(true);
    await flushMicrotasks(); // redelivers the second

    const redeliveredUpdates = calls
      .filter((c) => c.path.endsWith("/update"))
      .map((c) => c.body);
    expect(redeliveredUpdates).toEqual([firstFailedUpdate, secondFailedUpdate]);
    handle.disconnect();
  });
});
