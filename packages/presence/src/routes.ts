// The presence HTTP surface: join/heartbeat/leave over plain POSTs, and a
// live SSE stream of the room's awareness snapshot — mounted by the hub
// inside its own tenant-scoped middleware (see apps/hub/src/index.ts), so
// `TenantEnv`'s `tenant`/`principal` are always resolved before a handler
// here runs. No new auth path: identity and tenant membership ride the
// platform's existing session + tenant resolution, exactly like every
// other extension mounted under `TENANT_PREFIX`.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { artifactIdForSurface } from "./artifact-persistence";
import { decodeBase64, encodeBase64, InvalidBase64Error } from "./base64";
import { colorForPrincipal } from "./color";
import {
  createPresenceRoomRegistry,
  type PresenceRoomKey,
  type PresenceRoomRegistry,
  type PresenceState,
  type PresenceStatePatch,
} from "./room-registry";
import { makeErrorEnvelope } from "@corbits/error-sink";
import {
  MAX_DOC_UPDATE_BYTES,
  maxBase64LengthFor,
  PresenceDocUpdateBody,
  PresenceHeartbeatBody,
  PresenceJoinBody,
} from "./schema";
import { bindPresenceStream } from "./sse-stream";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

export interface CreatePresenceRoutesDeps {
  registry?: PresenceRoomRegistry;
  heartbeatTimeoutMs?: number;
  now?: () => number;
  /** Decoded-byte ceiling for a single `POST /update` body. */
  maxDocUpdateBytes?: number;
  /**
   * Runs after a successful join, before the response's `docUpdate` is
   * read off the registry — the seam persistence's seed-on-join hook
   * (`createArtifactDocPersistence`) uses to populate a freshly-created
   * artifact room's doc from the artifact's stored content before the
   * joiner ever sees it. Optional: a bare presence room (no artifact
   * behind it) has no seeding to do.
   */
  onJoin?: (key: PresenceRoomKey, principalId: string) => Promise<void> | void;
  /**
   * Gates every doc-carrying surface's `POST /rooms/:surface/join`,
   * `GET /rooms/:surface/stream` (read — a room's join response and SSE
   * stream can both carry real document text) and
   * `POST /rooms/:surface/update` (write). REQUIRED, not optional: phase
   * 1's "waving a cursor isn't a write" argument for leaving join/stream
   * ungated stopped holding the moment join's response and the SSE
   * stream started carrying document content a principal might not have
   * read access to — the same `("asset:*", "read"/"write")` grant
   * Library's own artifact routes already check. A presence-only surface
   * (never doc-carrying — e.g. a channel's who's-here stack) stays
   * exactly as ungated as phase 1 left it regardless; see
   * `isDocCarryingSurface`.
   */
  requireGrant: RequireGrant;
  /**
   * Whether `surface` carries doc content that needs a grant check on
   * join/stream/update. Defaults to the `artifact:<id>` convention
   * `artifact-persistence.ts` already owns, so a channel's who's-here
   * surface (never `artifact:...`) stays ungated without every caller
   * having to know or repeat that convention. Override only for a
   * deployment that names its doc-carrying surfaces differently.
   */
  isDocCarryingSurface?: (surface: string) => boolean;
}

/**
 * Every mutating request opportunistically sweeps its own room for stale
 * clients before acting. This is deliberately not a background timer: a
 * timer running forever in every process that imports this module would
 * outlive tests and complicate shutdown for no real gain — the heartbeat
 * protocol already guarantees frequent-enough traffic (joins, heartbeats,
 * and the SSE `stream` route's own subscribe/unsubscribe) that a stale
 * client is caught within one timeout window of the next request to its
 * room, which is the only guarantee "ephemeral, no persistence" presence
 * needs.
 */
export function createPresenceRoutes(
  deps: CreatePresenceRoutesDeps,
): Hono<TenantEnv> {
  const registry = deps.registry ?? createPresenceRoomRegistry();
  const heartbeatTimeoutMs =
    deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const maxDocUpdateBytes = deps.maxDocUpdateBytes ?? MAX_DOC_UPDATE_BYTES;
  const maxBase64UpdateLength = maxBase64LengthFor(maxDocUpdateBytes);
  const isDocCarryingSurface =
    deps.isDocCarryingSurface ??
    ((surface: string) => artifactIdForSurface(surface) !== null);

  const app = new Hono<TenantEnv>();

  /**
   * Wraps `requireGrant(action)` so it only ever runs for a surface
   * `isDocCarryingSurface` says actually carries doc content — a
   * presence-only surface (e.g. `channel:<id>`) passes straight through,
   * exactly as ungated as phase 1 left it.
   */
  function gateDocCarryingSurface(
    action: "read" | "write",
  ): MiddlewareHandler<TenantEnv> {
    const grantMiddleware = deps.requireGrant("asset:*", action);
    return (c, next) => {
      const surface = c.req.param("surface");
      if (surface === undefined || !isDocCarryingSurface(surface)) {
        return next();
      }
      // Returned, not just awaited: a grant middleware that denies short
      // -circuits by returning a `Response` (e.g. `c.json(..., 403)`)
      // rather than calling `next()` — Hono's own dispatcher only
      // recognizes that as "the response is ready" if this wrapper hands
      // that same return value back up the chain instead of discarding
      // it.
      return grantMiddleware(c, next);
    };
  }

  const readGate = gateDocCarryingSurface("read");
  const writeGate = gateDocCarryingSurface("write");

  app.post("/rooms/:surface/join", readGate, async (c) => {
    const body = PresenceJoinBody(await c.req.json().catch(() => ({})));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid join body: ${body.summary}`,
        }),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const user = c.get("user");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    registry.sweepStale(heartbeatTimeoutMs, now());

    let state: PresenceState = {
      principalId: principal.id,
      displayName: body.displayName ?? user?.name ?? principal.id,
      color: colorForPrincipal(principal.id),
    };
    if (body.cursor !== undefined) state = { ...state, cursor: body.cursor };
    if (body.typing !== undefined) state = { ...state, typing: body.typing };

    const states = registry.join(key, state, now());
    await deps.onJoin?.(key, principal.id);
    const docUpdate = encodeBase64(registry.docStateAsUpdate(key));
    return c.json({ self: state, members: states, docUpdate }, 200);
  });

  app.post("/rooms/:surface/heartbeat", async (c) => {
    const body = PresenceHeartbeatBody(await c.req.json().catch(() => ({})));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid heartbeat body: ${body.summary}`,
        }),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    let patch: PresenceStatePatch = {};
    if (body.cursor !== undefined) patch = { ...patch, cursor: body.cursor };
    if (body.typing !== undefined) patch = { ...patch, typing: body.typing };
    // Refresh this principal's `lastSeenAt` *before* sweeping: this
    // request arriving is itself proof of liveness, so the sweep below
    // must judge staleness against the fresh timestamp, never the
    // pre-request one — otherwise a heartbeat landing a moment past
    // `heartbeatTimeoutMs` (ordinary jitter) would evict its own sender.
    const heartbeatResult = registry.heartbeat(key, principal.id, patch, now());
    if (heartbeatResult === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "not_joined",
          userMessage: "principal has not joined this room",
        }),
        404,
      );
    }
    registry.sweepStale(heartbeatTimeoutMs, now());
    return c.json({ members: registry.states(key) });
  });

  app.post(
    "/rooms/:surface/update",
    writeGate,
    async (c: Context<TenantEnv, "/rooms/:surface/update">) => {
      const body = PresenceDocUpdateBody(await c.req.json().catch(() => ({})));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid update body: ${body.summary}`,
          }),
          400,
        );
      }

      // Rejected by STRING length first, before ever decoding: an
      // oversize base64 payload is refused by a cheap `.length` check
      // rather than first paying the cost of decoding it into a
      // `Uint8Array` only to discard it once the byte-length check below
      // would have caught it anyway.
      if (body.update.length > maxBase64UpdateLength) {
        return c.json(
          makeErrorEnvelope({
            code: "payload_too_large",
            userMessage: `update exceeds the ${maxDocUpdateBytes} byte limit`,
          }),
          413,
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(body.update);
      } catch (err) {
        if (err instanceof InvalidBase64Error) {
          return c.json(
            makeErrorEnvelope({
              code: "bad_request",
              userMessage: "update is not valid base64",
            }),
            400,
          );
        }
        throw err;
      }

      // Belt-and-suspenders: the string-length bound above is a
      // necessary-but-not-exact ceiling (padding/whitespace can shift
      // the true decoded size within a few bytes), so the decoded byte
      // count is still checked directly before it ever reaches Yjs.
      if (bytes.byteLength > maxDocUpdateBytes) {
        return c.json(
          makeErrorEnvelope({
            code: "payload_too_large",
            userMessage: `update exceeds the ${maxDocUpdateBytes} byte limit`,
          }),
          413,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const surface = c.req.param("surface");
      const key = { tenantId: tenant.id, surface };

      try {
        registry.applyDocUpdate(key, bytes, principal.id);
      } catch {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: "update is not a valid Yjs update",
          }),
          400,
        );
      }

      return c.body(null, 202);
    },
  );

  app.post("/rooms/:surface/leave", (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    registry.leave(key, principal.id);
    return c.body(null, 202);
  });

  app.get("/rooms/:surface/stream", readGate, (c) => {
    const tenant = c.get("tenant");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    return streamSSE(c, async (stream) => {
      const { teardown, closed } = bindPresenceStream({
        stream,
        registry,
        key,
      });
      stream.onAbort(teardown);
      await closed;
    });
  });

  return app;
}
