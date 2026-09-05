// The SSE subscriber registry: ephemeral, in-process fan-out for
// events that never touch storage — typing and settings-changed —
// merged onto a workbench's SSE stream alongside the platform's own run
// events. Scoped to one `createChatRoutes` call, matching the
// per-router caching pattern `createInstanceRoutes` uses for its
// signing-key cache.
//
// `bridgeWorkbenchStream` is the route's one call into this module: it
// wires both this registry and the platform's own event stream onto a
// live SSE stream, and owns the defects that matter here.
//
// 1. A write that throws must drop that subscriber and close the
//    stream immediately rather than leaving it registered until
//    `stream.onAbort` eventually runs — a dangling subscriber between
//    disconnect and abort is a zombie: every event published in that
//    window still attempts a write. Hono's own `StreamingApi.write`
//    swallows writer errors internally and never rejects, so a
//    `writeSSE` that "succeeds" is not proof the bytes landed: after
//    every write we check whether the underlying writer is errored
//    (`desiredSize === null`) or the stream aborted/closed, and we
//    bound the write itself with a timeout so a stalled TCP sink
//    cannot pin the delivery queue forever (CL-7246). A write that
//    does throw is still handled the same way. Stall teardown aborts
//    the underlying writer rather than awaiting Hono `close()`, which
//    queues behind the same in-flight write and never drops the
//    socket. A clean end (revoked access) still `close()`s — aborting a
//    healthy Hono stream errors the body with `undefined` instead of a
//    normal SSE disconnect. `stream.onAbort` (wired by the route) remains the
//    disconnect path for a client that goes away between writes; a
//    clean abort already torn down that way is not a new incident.
// 2. Access must be re-checked on every delivered event, not only at
//    connect time. The route resolves access once before opening the
//    stream, but a share or a share member's row can be revoked at
//    any point during a long-lived connection; without a live check
//    the subscriber would keep receiving every subsequent event
//    forever. The caller passes an `authorize` callback (the same
//    fail-closed `resolveWorkbenchAccess` check the route ran up
//    front); this module calls it before every write and, the moment
//    it returns `false`, unsubscribes from both sources and closes
//    the stream so the client's connection actually ends. This makes
//    revocation live relative to the workbench's own traffic — the very
//    next event delivered after a revocation is the last one a
//    revoked subscriber sees — not instantly on a workbench that goes
//    quiet. A truly instant kill would need a poll/heartbeat
//    independent of traffic; that's a real, disclosed scope cut, not
//    a hidden gap, and out of scope here.
// 3. Every delivery — the presence snapshot, each event, and the
//    keepalive ping — runs through one chained promise so writes reach
//    the stream in the order they were enqueued, never in the order
//    their `authorize()` calls happen to resolve. This is also what
//    keeps the presence snapshot first: it's enqueued before the local
//    and platform subscriptions are installed, so nothing can jump
//    ahead of it even if an event arrives the instant a subscription is
//    wired up.
import type { SSEStreamingApi } from "hono/streaming";
import { reportError } from "@corbits/error-sink";
import type { WorkbenchEvents, ChatWorkbenchEvent } from "./platform-port";
import { ChatPresenceSnapshotEventData } from "./stream-events";
import type { WorkbenchPresenceRegistry } from "./workbench-presence";

// Below nginx's 60s default proxy timeout and most load balancers' idle
// timeouts, so an idle connection never looks abandoned to anything
// sitting between the client and this process.
const DEFAULT_KEEPALIVE_INTERVAL_MS = 25_000;

// A stream whose deliveries have backed up this far has already lost
// coherence with the client (whatever it shows is minutes stale by the
// time it drains) — closing and letting the client reconnect is more
// useful than an unbounded queue holding every event since the backup
// started.
const MAX_QUEUED_DELIVERIES = 200;

// Hono's `StreamingApi.write` awaits `writer.write` inside a bare
// `catch {}`, so a failed or stalled sink never rejects `writeSSE`.
// Bound every write so a client that has stopped reading cannot pin
// the delivery queue; well below the keepalive interval, since a
// write of a small SSE frame that has not flushed in this long is
// already a dead connection, not a slow one.
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;

function underlyingWriterIsErrored(stream: SSEStreamingApi): boolean {
  const writer = Reflect.get(stream, "writer");
  if (typeof writer !== "object" || writer === null) return false;
  if (!("desiredSize" in writer)) return false;
  return writer.desiredSize === null;
}

function abortUnderlyingWriter(stream: SSEStreamingApi): boolean {
  const writer = Reflect.get(stream, "writer");
  if (typeof writer !== "object" || writer === null) return false;
  const abort = Reflect.get(writer, "abort");
  if (typeof abort !== "function") return false;
  try {
    void Promise.resolve(abort.call(writer)).catch(() => undefined);
    return true;
  } catch {
    // report-error-ignore: aborting an already-closed writer is not an incident
    return true;
  }
}

function closeStream(stream: SSEStreamingApi): void {
  void stream.close().catch(() => undefined);
}

function dropHungStream(stream: SSEStreamingApi): void {
  if (abortUnderlyingWriter(stream)) return;
  closeStream(stream);
}

async function writeSSEObservingFailure(
  stream: SSEStreamingApi,
  message: { event?: string; data: string },
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const write = stream.writeSSE(message).then(() => {
    if (stream.aborted || stream.closed || underlyingWriterIsErrored(stream)) {
      throw new Error("workbench SSE write failed");
    }
  });
  const stalled = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("workbench SSE write stalled"));
    }, timeoutMs);
  });
  try {
    await Promise.race([write, stalled]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    // If the timeout won, the in-flight write may still reject later;
    // swallow that so it cannot surface as an unhandled rejection.
    void write.catch(() => undefined);
  }
}

export type WorkbenchSubscriber = (event: ChatWorkbenchEvent) => void;

export interface WorkbenchSubscriberRegistry {
  subscribe(workbenchId: string, subscriber: WorkbenchSubscriber): () => void;
  publish(workbenchId: string, event: ChatWorkbenchEvent): void;
}

/**
 * Wraps a `WorkbenchEvents` so every workbench has at most one live upstream
 * subscription, fanned out in-process to however many local callers ask
 * for it — the fix for CL-6186. Without this, each SSE connection called
 * `platform.subscribeToWorkbench` directly: N browser tabs open on the same
 * workbench meant N folded-run lookups and N sidecar subscriptions for the
 * same workbench, and a reconnect storm (every tab's `EventSource` retrying
 * at once after a hub restart) turned into a proportional storm of DB
 * lookups and sidecar subscribes that starved both. Ref-counted per
 * workbench instead: the first subscriber triggers the one upstream call,
 * every later subscriber for that workbench just joins the fan-out, and the
 * upstream subscription is released only once the last local subscriber
 * for that workbench goes away.
 */
export function createPlatformWorkbenchFanout(
  platform: WorkbenchEvents,
): WorkbenchEvents {
  interface Entry {
    subscribers: Set<WorkbenchSubscriber>;
    unsubscribeUpstream: () => void;
  }
  const entriesByWorkbench = new Map<string, Entry>();

  return {
    subscribeToWorkbench(workbenchId, onEvent) {
      let entry = entriesByWorkbench.get(workbenchId);
      if (entry === undefined) {
        const subscribers = new Set<WorkbenchSubscriber>();
        const unsubscribeUpstream = platform.subscribeToWorkbench(
          workbenchId,
          (event) => {
            for (const subscriber of subscribers) subscriber(event);
          },
        );
        entry = { subscribers, unsubscribeUpstream };
        entriesByWorkbench.set(workbenchId, entry);
      }
      entry.subscribers.add(onEvent);

      return () => {
        const current = entriesByWorkbench.get(workbenchId);
        if (current === undefined || !current.subscribers.delete(onEvent)) {
          return;
        }
        if (current.subscribers.size === 0) {
          current.unsubscribeUpstream();
          entriesByWorkbench.delete(workbenchId);
        }
      };
    },
  };
}

export function createWorkbenchSubscriberRegistry(): WorkbenchSubscriberRegistry {
  const subscribersByWorkbench = new Map<string, Set<WorkbenchSubscriber>>();
  return {
    subscribe(workbenchId, subscriber) {
      let subscribers = subscribersByWorkbench.get(workbenchId);
      if (subscribers === undefined) {
        subscribers = new Set();
        subscribersByWorkbench.set(workbenchId, subscribers);
      }
      subscribers.add(subscriber);
      return () => {
        subscribers?.delete(subscriber);
        if (subscribers?.size === 0) {
          subscribersByWorkbench.delete(workbenchId);
        }
      };
    },
    publish(workbenchId, event) {
      const subscribers = subscribersByWorkbench.get(workbenchId);
      if (subscribers === undefined) return;
      for (const subscriber of subscribers) subscriber(event);
    },
  };
}

/** What `bridgeWorkbenchStream` hands back to the route. */
export interface WorkbenchStreamBridge {
  /** Unsubscribes both sources and closes the stream; safe to call more
   * than once. The route calls this from `stream.onAbort`. */
  teardown: () => void;
  /** Resolves once `teardown` has run, from any cause — client abort,
   * a revoked `authorize()`, or a write failure. The route awaits this
   * instead of a promise that never resolves, so its closure (and
   * everything it closes over) is released once the connection ends
   * rather than pinned in memory for the life of the process. */
  closed: Promise<void>;
}

/**
 * Wires a live SSE stream to both the local registry and the
 * platform's own per-workbench event stream, and returns the combined
 * teardown the route calls from `stream.onAbort` plus a `closed`
 * promise it awaits instead of parking forever. Before every event
 * from either source is written, `authorize()` re-runs the same
 * fail-closed access check the route ran at connect time; a `false`
 * result (or a rejection — a transient resolver error must not become
 * an unhandled rejection) unsubscribes both sources and closes the
 * stream rather than writing the event, so a revoked share or share
 * member stops receiving events on the very next one published. A
 * `writeSSE` that throws (the client is already gone) unsubscribes
 * that source immediately, closes the stream, and reports the
 * failure. Hono's own `write` swallows writer errors today, so a
 * resolved `writeSSE` is inspected for an errored writer, an aborted
 * or closed stream, or a write that never settles within
 * `writeTimeoutMs` — any of those is treated as the same failure. A
 * stalled write aborts the underlying writer so the client's
 * EventSource sees a disconnect; Hono `close()` is not awaited
 * because it queues behind the in-flight write. A client abort that
 * already ran `teardown` via `stream.onAbort` is not reported as a
 * new incident, but still aborts the in-flight writer so Hono
 * `close()` does not wait on it. A periodic keepalive keeps idle
 * connections alive behind proxies that time out on silence.
 */
export function bridgeWorkbenchStream(input: {
  registry: WorkbenchSubscriberRegistry;
  platform: WorkbenchEvents;
  workbenchId: string;
  stream: SSEStreamingApi;
  authorize: () => Promise<boolean>;
  /**
   * Wires this connection into the workbench's "who's here" roster —
   * see `./workbench-presence.ts`. Omitted, this stream carries no
   * presence at all (the original behavior): a caller with no presence
   * feature wired sees nothing change. When present, connecting
   * registers one live connection for `principalId`, hands this
   * stream a `chat.presence.snapshot` of the roster as it stands right
   * now, and broadcasts a `chat.presence` `"online"` delta; tearing
   * down releases the connection and, only once this was the
   * principal's last one on this workbench, broadcasts `"offline"`.
   */
  presence?: {
    registry: WorkbenchPresenceRegistry;
    principalId: string;
  };
  /** Overrides `DEFAULT_KEEPALIVE_INTERVAL_MS`; exists for tests. */
  keepaliveIntervalMs?: number;
  /** Overrides `DEFAULT_WRITE_TIMEOUT_MS`; exists for tests. */
  writeTimeoutMs?: number;
}): WorkbenchStreamBridge {
  let tornDown = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let unsubscribeLocal: () => void = () => undefined;
  let unsubscribePlatform: () => void = () => undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined = undefined;

  const teardownPresence = () => {
    if (input.presence === undefined) return;
    const wentOffline = input.presence.registry.disconnect(
      input.workbenchId,
      input.presence.principalId,
    );
    if (!wentOffline) return;
    input.registry.publish(input.workbenchId, {
      type: "chat.presence",
      data: {
        principalId: input.presence.principalId,
        state: "offline",
        lastActiveAt: new Date().toISOString(),
      },
    });
  };
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    unsubscribeLocal();
    unsubscribePlatform();
    teardownPresence();
    if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
    resolveClosed();
  };
  const writeTimeoutMs = input.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;

  // Every write to this stream — the presence snapshot, each delivered
  // event, and the keepalive ping — is chained onto this one promise so
  // they land on the wire in the order they were enqueued, never in the
  // order their own async work (an `authorize()` call, say) happens to
  // settle. `queuedCount` bounds how far a stuck client can make this
  // grow.
  let deliveryQueue: Promise<void> = Promise.resolve();
  let queuedCount = 0;

  const enqueue = (task: () => Promise<void>) => {
    if (tornDown) return;
    if (queuedCount >= MAX_QUEUED_DELIVERIES) {
      reportError(new Error("workbench stream delivery queue overflow"), {
        operation: "chat.workbenchStream.overflow",
        roomId: input.workbenchId,
      });
      teardown();
      dropHungStream(input.stream);
      return;
    }
    queuedCount += 1;
    deliveryQueue = deliveryQueue
      .then(async () => {
        queuedCount -= 1;
        if (tornDown) return;
        await task();
      })
      // A task's own failure is already handled (reported, torn down)
      // inside itself; this catch only exists so a task that somehow
      // still throws can't poison every delivery queued after it.
      .catch(() => undefined);
  };

  const deliverEvent = async (event: ChatWorkbenchEvent) => {
    let authorized: boolean;
    try {
      authorized = await input.authorize();
    } catch (error) {
      reportError(error, {
        operation: "chat.workbenchStream.authorize",
        roomId: input.workbenchId,
      });
      teardown();
      closeStream(input.stream);
      return;
    }
    if (!authorized) {
      teardown();
      closeStream(input.stream);
      return;
    }
    try {
      await writeSSEObservingFailure(
        input.stream,
        {
          event: event.type,
          data: JSON.stringify(event.data),
        },
        writeTimeoutMs,
      );
    } catch (error) {
      if (!(tornDown || input.stream.aborted)) {
        reportError(error, {
          operation: "chat.workbenchStream.write",
          roomId: input.workbenchId,
        });
      }
      teardown();
      dropHungStream(input.stream);
    }
  };

  // Enqueued before either subscription is installed, so nothing
  // delivered by either source can be written ahead of it — the fix
  // for the snapshot/delta race.
  if (input.presence !== undefined) {
    const { registry: presenceRegistry, principalId } = input.presence;
    presenceRegistry.connect(input.workbenchId, principalId);
    const snapshot = ChatPresenceSnapshotEventData.assert({
      members: presenceRegistry.snapshot(input.workbenchId),
    });
    enqueue(async () => {
      try {
        await writeSSEObservingFailure(
          input.stream,
          {
            event: "chat.presence.snapshot",
            data: JSON.stringify(snapshot),
          },
          writeTimeoutMs,
        );
      } catch (error) {
        if (!(tornDown || input.stream.aborted)) {
          reportError(error, {
            operation: "chat.workbenchStream.presenceSnapshot",
            roomId: input.workbenchId,
          });
        }
        teardown();
        dropHungStream(input.stream);
      }
    });
  }

  unsubscribeLocal = input.registry.subscribe(input.workbenchId, (event) => {
    enqueue(() => deliverEvent(event));
  });

  // The platform side resolves a folded run before it can subscribe
  // (see `subscribeToWorkbench` in `platform-adapter.ts`); a transient
  // failure there (the run isn't back yet after a hub restart, a slow
  // DB) must degrade this stream to registry-only rather than take the
  // whole SSE connection down — a client still gets typing/settings
  // events and its own poll fallback covers the rest. The degradation
  // itself is still a failure worth knowing about, so it's reported
  // rather than swallowed.
  try {
    unsubscribePlatform = input.platform.subscribeToWorkbench(
      input.workbenchId,
      (event) => {
        enqueue(() => deliverEvent(event));
      },
    );
  } catch (error) {
    reportError(error, {
      operation: "chat.workbenchStream.platformSubscribe",
      roomId: input.workbenchId,
    });
    unsubscribePlatform = () => undefined;
  }

  if (input.presence !== undefined) {
    input.registry.publish(input.workbenchId, {
      type: "chat.presence",
      data: {
        principalId: input.presence.principalId,
        state: "online",
        lastActiveAt: new Date().toISOString(),
      },
    });
  }

  keepaliveTimer = setInterval(() => {
    // A backed-up queue is already proof the connection is alive;
    // adding to the backlog would only make it worse.
    if (tornDown || queuedCount > 0) return;
    enqueue(async () => {
      try {
        await writeSSEObservingFailure(
          input.stream,
          { event: "keepalive", data: "" },
          writeTimeoutMs,
        );
      } catch (error) {
        if (!(tornDown || input.stream.aborted)) {
          reportError(error, {
            operation: "chat.workbenchStream.keepalive",
            roomId: input.workbenchId,
          });
        }
        teardown();
        dropHungStream(input.stream);
      }
    });
  }, input.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS);

  return { teardown, closed };
}
