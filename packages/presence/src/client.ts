// The browser-safe half of `@corbits/presence`: no React, no DOM APIs
// assumed beyond `fetch` and `EventSource` (both dependency-injectable, so
// this module is unit-testable in plain `bun:test` with fakes — mirroring
// `packages/chat-ui/src/use-channel-stream.ts`'s reconnect/backoff shape,
// but exposed as a plain subscribe/callback API rather than a React hook.
// A thin hook wrapping `connectPresence` belongs in the consuming app, not
// here — this package never depends on React.
import * as Y from "yjs";

import { decodeBase64, encodeBase64 } from "./base64";
import type {
  PresenceCursor,
  PresenceState,
  PresenceStatePatch,
} from "./room-registry";

/** The one field this module reads off a real `MessageEvent` — spelled out
 * locally rather than typed against the DOM lib's `MessageEvent`, since
 * this package's tsconfig deliberately doesn't pull in DOM globals (see
 * `openEventSource`'s default below for why). */
export interface PresenceStreamEvent {
  readonly data: string;
}

/** The minimal `EventSource` surface this module uses — small enough that a
 * test fake can implement it directly, rather than the full DOM interface. */
export interface PresenceEventSourceLike {
  addEventListener(
    type: string,
    listener: (event: PresenceStreamEvent) => void,
  ): void;
  close(): void;
}

/** The minimal `fetch` surface this module uses. `json()` is only ever
 * read when a `doc` is configured (to pull `docUpdate` off the join
 * response) — a real `Response` satisfies this structurally, no cast
 * needed. */
export type PresenceFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The four requests this module ever POSTs — also each one's URL path
 * segment under `roomUrl`. */
export type PresenceOperation = "join" | "heartbeat" | "leave" | "update";

/**
 * Reported through `PresenceHandle.onError` for every join/heartbeat/leave/
 * update request that never reached the server (a rejected `fetch`, no
 * `status`) or came back non-2xx (`status` set). This is the only signal a
 * consuming UI has that "connected" is a lie — the SSE stream opens and
 * stays open regardless of whether join or any later heartbeat actually
 * succeeded server-side.
 */
export interface PresenceError {
  readonly operation: PresenceOperation;
  readonly status?: number;
}

export interface PresenceClientOptions {
  /** The room's base URL, e.g. `/api/tenants/tnt_1/presence/rooms/channel:chn_1`. */
  readonly roomUrl: string;
  readonly displayName?: string;
  readonly heartbeatIntervalMs?: number;
  readonly fetchImpl?: PresenceFetch;
  readonly openEventSource?: (streamUrl: string) => PresenceEventSourceLike;
  /**
   * When provided, this connection speaks doc sync as well as awareness:
   * the join response's `docUpdate` seeds it, remote `doc.update` SSE
   * events apply into it, and its own local changes are relayed to the
   * room's `/update` endpoint. Omit for an awareness-only connection
   * (e.g. the channel who's-here stack, which has no doc content) — the
   * extra machinery below only activates when a caller actually hands
   * over a `Y.Doc` to keep in sync.
   */
  readonly doc?: Y.Doc;
  /**
   * Called for every `doc.saved` event the room's stream carries — the
   * only honest source for a "Saved · v12" line, since a debounced
   * server-side write finishing is not something the client can infer
   * from anything it did locally.
   */
  readonly onSaved?: (info: { version: number; savedAt: number }) => void;
  /** Injectable clock, for deterministic tests of rejoin backoff. */
  readonly now?: () => number;
}

/**
 * The real global `EventSource` constructor, cast to the minimal shape
 * this module needs. A real cast, not a lie: every `EventSource` in every
 * browser satisfies `PresenceEventSourceLike` structurally — this package
 * just doesn't add the DOM lib to its own tsconfig (doing so would pull
 * DOM's `BodyInit` into scope for the whole package, including the
 * server-side route modules that never touch it).
 */
function defaultOpenEventSource(streamUrl: string): PresenceEventSourceLike {
  const EventSourceCtor = (
    globalThis as unknown as {
      EventSource: new (url: string) => PresenceEventSourceLike;
    }
  ).EventSource;
  return new EventSourceCtor(streamUrl);
}

export interface PresenceHandle {
  /** Publishes (and immediately heartbeats) a cursor position. */
  publishCursor(cursor: PresenceCursor): void;
  /** Publishes (and immediately heartbeats) a typing flag. */
  publishTyping(typing: boolean): void;
  /** Subscribes to every room snapshot; fires once with whatever has been received so far. */
  subscribe(listener: (members: readonly PresenceState[]) => void): () => void;
  /** Subscribes to every failed join/heartbeat/leave/update request. */
  onError(listener: (error: PresenceError) => void): () => void;
  /**
   * Subscribes to every successful join or heartbeat — the client's only
   * signals that the connection is healthy again after failures. A consuming
   * UI that showed a reconnecting/degraded caption from `onError` clears it
   * here, not from the SSE snapshot (the stream stays open even while join
   * is failing).
   */
  onRecovered(listener: () => void): () => void;
  /** Leaves the room and tears down the stream/heartbeat timer. */
  disconnect(): void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

// Exponential backoff for repeated join failures: without it, a client
// whose join keeps failing (server down, or a caller publishing cursor
// updates on every mouse move while unjoined) would re-POST `/join` as
// fast as each failed attempt resolves. Mirrors
// `packages/chat-ui/src/use-workbench-stream.ts`'s `backoffDelayMs` shape
// (not imported — that package depends on this one, not the reverse).
const REJOIN_BASE_DELAY_MS = 1_000;
const REJOIN_MAX_DELAY_MS = 30_000;

function rejoinDelayMs(failureCount: number): number {
  return Math.min(
    REJOIN_BASE_DELAY_MS * 2 ** (failureCount - 1),
    REJOIN_MAX_DELAY_MS,
  );
}

function parseMembers(data: string): readonly PresenceState[] {
  try {
    const parsed: unknown = JSON.parse(data);
    return Array.isArray(parsed) ? (parsed as PresenceState[]) : [];
  } catch {
    return [];
  }
}

/** `undefined` for anything that isn't a well-formed `{update: string}` payload — the same "parse, don't crash on a bad event" stance `parseMembers` takes. */
function parseDocUpdateEvent(data: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "update" in parsed &&
      typeof (parsed as { update: unknown }).update === "string"
    ) {
      return (parsed as { update: string }).update;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** `undefined` for anything that isn't a well-formed `{version, savedAt}` payload. */
function parseSnapshotEvent(
  data: string,
): { version: number; savedAt: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      "savedAt" in parsed &&
      typeof (parsed as { version: unknown }).version === "number" &&
      typeof (parsed as { savedAt: unknown }).savedAt === "number"
    ) {
      return parsed as { version: number; savedAt: number };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function docUpdateFromJoinResponse(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "docUpdate" in body &&
    typeof (body as { docUpdate: unknown }).docUpdate === "string"
  ) {
    return (body as { docUpdate: string }).docUpdate;
  }
  return undefined;
}

/** Origin tag stamped on every update `applyRemoteUpdate` applies, so the
 * doc's own `update` observer (which relays local changes to the server)
 * can tell "I made this edit" from "the server told me about someone
 * else's edit" and skip re-posting the latter — without this, every
 * remote update would round-trip back to the server as if it were new. */
const REMOTE_UPDATE_ORIGIN = "presence-remote";

function defaultFetch(
  ...args: Parameters<PresenceFetch>
): ReturnType<PresenceFetch> {
  return (globalThis as unknown as { fetch: PresenceFetch }).fetch(...args);
}

export function connectPresence(
  options: PresenceClientOptions,
): PresenceHandle {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const openEventSource = options.openEventSource ?? defaultOpenEventSource;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const doc = options.doc;
  const now = options.now ?? Date.now;

  const listeners = new Set<(members: readonly PresenceState[]) => void>();
  const errorListeners = new Set<(error: PresenceError) => void>();
  const recoveredListeners = new Set<() => void>();
  let latestMembers: readonly PresenceState[] = [];
  let disconnected = false;
  // Whether the last join attempt is known to have succeeded server-side.
  // A heartbeat answered 404 (`not_joined`) — this room evicted us, most
  // often ordinary heartbeat jitter racing the server's own timeout sweep
  // — flips this back to `false` so the next heartbeat tick rejoins
  // instead of heartbeating a membership that no longer exists.
  let joined = false;
  // Guards against a `publishCursor`/`publishTyping` call landing while
  // the initial (or a rejoin) `join` request is still in flight from
  // firing a second, redundant one.
  let joinInFlight = false;
  // Consecutive join failures since the last success — drives
  // `rejoinDelayMs`'s backoff and resets to 0 the moment a join succeeds.
  let joinFailureCount = 0;
  // The earliest time `doJoin` will send another request while
  // `joinFailureCount > 0` — the actual throttle; `joinFailureCount` by
  // itself only picks the delay.
  let nextJoinAttemptAt = 0;
  // Local doc edits (base64-encoded) whose `/update` POST failed and
  // hasn't yet been redelivered. Safe to replay in order once the
  // connection is healthy again: a Yjs update is idempotent against a
  // doc that has already applied it, so redelivering never double-edits
  // — without this queue a dropped update is gone for good (see CL-7202).
  let pendingUpdates: string[] = [];
  let flushingPendingUpdates = false;

  const notify = (members: readonly PresenceState[]) => {
    latestMembers = members;
    for (const listener of listeners) listener(members);
  };

  const reportError = (operation: PresenceOperation, status?: number) => {
    const error: PresenceError =
      status === undefined ? { operation } : { operation, status };
    for (const listener of errorListeners) listener(error);
  };

  const notifyRecovered = () => {
    for (const listener of recoveredListeners) listener();
  };

  const post = (operation: PresenceOperation, body: unknown) =>
    fetchImpl(`${options.roomUrl}/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).catch(() => undefined);

  /**
   * Joins (or rejoins) the room. Called once at connect time and again
   * whenever a heartbeat discovers the server no longer considers us
   * joined — the only two situations this room's membership needs
   * (re-)establishing. Backs off after repeated failures rather than
   * retrying on every call: `publishCursor`/`publishTyping` land far more
   * often than the heartbeat timer ticks, so without the backoff gate a
   * still-unjoined client publishing cursor moves would re-POST `/join`
   * as fast as each failed attempt resolves.
   */
  function doJoin(): void {
    if (joinInFlight) return;
    if (joinFailureCount > 0 && now() < nextJoinAttemptAt) return;
    joinInFlight = true;
    void post("join", { displayName: options.displayName }).then((response) => {
      joinInFlight = false;
      if (disconnected) return;
      if (response === undefined) {
        joinFailureCount += 1;
        nextJoinAttemptAt = now() + rejoinDelayMs(joinFailureCount);
        reportError("join");
        return;
      }
      if (!response.ok) {
        joinFailureCount += 1;
        nextJoinAttemptAt = now() + rejoinDelayMs(joinFailureCount);
        reportError("join", response.status);
        return;
      }
      joinFailureCount = 0;
      joined = true;
      notifyRecovered();
      flushPendingUpdates();
      if (doc === undefined) return;
      void response.json().then((body) => {
        if (disconnected) return;
        const docUpdate = docUpdateFromJoinResponse(body);
        if (docUpdate !== undefined) applyRemoteUpdate(docUpdate);
      });
    });
  }

  /**
   * Sends a heartbeat (optionally carrying a cursor/typing patch) if the
   * room still considers us joined, rejoining first if it doesn't — the
   * self-healing half of CL-7202: a 404'd heartbeat now recovers instead
   * of leaving the client heartbeating into the void while its own SSE
   * stream keeps reading as live.
   */
  function sendHeartbeat(patch: PresenceStatePatch): void {
    if (!joined) {
      doJoin();
      return;
    }
    void post("heartbeat", patch).then((response) => {
      if (disconnected) return;
      if (response === undefined) {
        reportError("heartbeat");
        return;
      }
      if (!response.ok) {
        reportError("heartbeat", response.status);
        if (response.status === 404) {
          joined = false;
          doJoin();
        }
        return;
      }
      notifyRecovered();
      flushPendingUpdates();
    });
  }

  function applyRemoteUpdate(base64Update: string): void {
    if (doc === undefined) return;
    try {
      Y.applyUpdate(doc, decodeBase64(base64Update), REMOTE_UPDATE_ORIGIN);
    } catch {
      // A malformed update is dropped rather than crashing the client;
      // the next join/reconnect resyncs the full doc state from scratch.
    }
  }

  /**
   * POSTs one already-encoded doc update. `isRetry` distinguishes a fresh
   * local edit (queued into `pendingUpdates` on failure) from a replay out
   * of that queue (left in place on failure — `flushPendingUpdates` is
   * already the thing re-adding it by not removing it).
   */
  function postUpdate(
    base64Update: string,
    isRetry: boolean,
  ): Promise<boolean> {
    return post("update", { update: base64Update }).then((response) => {
      if (disconnected) return false;
      if (response === undefined) {
        reportError("update");
        if (!isRetry) pendingUpdates.push(base64Update);
        return false;
      }
      if (!response.ok) {
        reportError("update", response.status);
        if (!isRetry) pendingUpdates.push(base64Update);
        return false;
      }
      return true;
    });
  }

  /**
   * Redelivers queued failed updates in order, one at a time, stopping at
   * the first failure so a later edit can never leapfrog an earlier one
   * still waiting to land. Called whenever a join or heartbeat succeeds —
   * the client's only signals that the connection is healthy again.
   */
  function flushPendingUpdates(): void {
    if (disconnected || flushingPendingUpdates || pendingUpdates.length === 0) {
      return;
    }
    const [next, ...rest] = pendingUpdates;
    if (next === undefined) return;
    flushingPendingUpdates = true;
    void postUpdate(next, true).then((succeeded) => {
      flushingPendingUpdates = false;
      if (!succeeded) return;
      pendingUpdates = rest;
      flushPendingUpdates();
    });
  }

  let onLocalDocUpdate:
    ((update: Uint8Array, origin: unknown) => void) | undefined;
  if (doc !== undefined) {
    onLocalDocUpdate = (update, origin) => {
      if (disconnected || origin === REMOTE_UPDATE_ORIGIN) return;
      void postUpdate(encodeBase64(update), false);
    };
    doc.on("update", onLocalDocUpdate);
  }

  doJoin();

  const source = openEventSource(`${options.roomUrl}/stream`);
  source.addEventListener("presence.state", (event) => {
    if (disconnected) return;
    notify(parseMembers(event.data));
  });
  source.addEventListener("doc.update", (event) => {
    if (disconnected) return;
    const update = parseDocUpdateEvent(event.data);
    if (update !== undefined) applyRemoteUpdate(update);
  });
  source.addEventListener("doc.saved", (event) => {
    if (disconnected) return;
    const info = parseSnapshotEvent(event.data);
    if (info !== undefined) options.onSaved?.(info);
  });

  const heartbeatTimer = setInterval(() => {
    if (disconnected) return;
    sendHeartbeat({});
  }, heartbeatIntervalMs);

  return {
    publishCursor(cursor) {
      if (disconnected) return;
      sendHeartbeat({ cursor });
    },

    publishTyping(typing) {
      if (disconnected) return;
      sendHeartbeat({ typing });
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(latestMembers);
      return () => {
        listeners.delete(listener);
      };
    },

    onError(listener) {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },

    onRecovered(listener) {
      recoveredListeners.add(listener);
      return () => {
        recoveredListeners.delete(listener);
      };
    },

    disconnect() {
      if (disconnected) return;
      disconnected = true;
      clearInterval(heartbeatTimer);
      source.close();
      listeners.clear();
      errorListeners.clear();
      recoveredListeners.clear();
      if (doc !== undefined && onLocalDocUpdate !== undefined) {
        doc.off("update", onLocalDocUpdate);
      }
      // Best-effort: the room drops this principal on its own heartbeat
      // timeout even if this never arrives (page unload racing the
      // request), so a failed leave is not reported as a `PresenceError`
      // — there is no listener left to hear it by the time it would fire.
      void post("leave", {});
    },
  };
}
