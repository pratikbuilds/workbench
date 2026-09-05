// `usePresenceRoom` (CL-5958): connects to `@corbits/presence/client` only
// while both tenant and surface are known, tears down and reconnects when
// either changes, and exposes publishCursor/publishTyping as stable
// callbacks. Mocks `@corbits/presence/client` directly rather than a real
// EventSource/fetch — that transport is `@corbits/presence`'s own test
// responsibility, not apps/web's. CL-7228: also wires `onError`/`onRecovered`
// so a degraded connection is visible after more than one retry.

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { PresenceError } from "@corbits/presence/client";
import type { UsePresenceRoomOptions } from "../src/presence/use-presence-room";

interface FakeHandle {
  roomUrl: string;
  disconnected: boolean;
  listener: ((members: unknown[]) => void) | null;
  errorListeners: Set<(error: PresenceError) => void>;
  recoveredListeners: Set<() => void>;
  cursorCalls: unknown[];
}

const created: FakeHandle[] = [];
const reportErrorCalls: { error: unknown; context: Record<string, unknown> }[] =
  [];

mock.module("@corbits/error-sink", () => ({
  reportError: (error: unknown, context: Record<string, unknown>) => {
    reportErrorCalls.push({ error, context });
    return "presence-error";
  },
}));

mock.module("@corbits/presence/client", () => ({
  connectPresence: (options: { roomUrl: string }) => {
    const handle: FakeHandle = {
      roomUrl: options.roomUrl,
      disconnected: false,
      listener: null,
      errorListeners: new Set(),
      recoveredListeners: new Set(),
      cursorCalls: [],
    };
    created.push(handle);
    return {
      subscribe: (listener: (members: unknown[]) => void) => {
        handle.listener = listener;
        listener([]);
        return () => {
          handle.listener = null;
        };
      },
      onError: (listener: (error: PresenceError) => void) => {
        handle.errorListeners.add(listener);
        return () => {
          handle.errorListeners.delete(listener);
        };
      },
      onRecovered: (listener: () => void) => {
        handle.recoveredListeners.add(listener);
        return () => {
          handle.recoveredListeners.delete(listener);
        };
      },
      publishCursor: (cursor: unknown) => handle.cursorCalls.push(cursor),
      publishTyping: () => undefined,
      disconnect: () => {
        handle.disconnected = true;
      },
    };
  },
}));

const { usePresenceRoom } = await import("../src/presence/use-presence-room");

afterEach(() => {
  created.length = 0;
  reportErrorCalls.length = 0;
});

afterAll(() => {
  mock.restore();
});

function fireError(error: PresenceError): void {
  const handle = created[created.length - 1];
  if (handle === undefined) throw new Error("no presence handle");
  act(() => {
    for (const listener of handle.errorListeners) listener(error);
  });
}

function fireRecovered(): void {
  const handle = created[created.length - 1];
  if (handle === undefined) throw new Error("no presence handle");
  act(() => {
    for (const listener of handle.recoveredListeners) listener();
  });
}

function mountHook(
  initialTenantId: string | null,
  initialSurface: string | null,
  options?: UsePresenceRoomOptions,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest: ReturnType<typeof usePresenceRoom> | null = null;
  let setArgs: (
    tenantId: string | null,
    surface: string | null,
  ) => void = () => {};

  function Host({
    tenantId,
    surface,
  }: {
    tenantId: string | null;
    surface: string | null;
  }) {
    latest = usePresenceRoom(tenantId, surface, undefined, options);
    return null;
  }

  function Wrapper() {
    const argsRef = useRef({
      tenantId: initialTenantId,
      surface: initialSurface,
    });
    setArgs = (tenantId, surface) => {
      argsRef.current = { tenantId, surface };
      act(() => root.render(createElement(Host, argsRef.current)));
    };
    return createElement(Host, argsRef.current);
  }

  act(() => {
    root.render(createElement(Wrapper));
  });

  return {
    setArgs,
    result: () => latest,
    unmount: () => act(() => root.unmount()),
  };
}

describe("usePresenceRoom", () => {
  test("does not connect when tenantId or surface is null", () => {
    const harness = mountHook(null, "workbench:chn_1");
    expect(created).toHaveLength(0);
    harness.unmount();
  });

  test("connects once both tenantId and surface are present", () => {
    const harness = mountHook("tnt_1", "workbench:chn_1");
    expect(created).toHaveLength(1);
    expect(created[0]?.roomUrl).toBe(
      "/api/tenants/tnt_1/presence/rooms/workbench:chn_1",
    );
    harness.unmount();
  });

  test("disconnects the old room and connects a new one when the surface changes", () => {
    const harness = mountHook("tnt_1", "workbench:chn_1");
    harness.setArgs("tnt_1", "workbench:chn_2");

    expect(created).toHaveLength(2);
    expect(created[0]?.disconnected).toBe(true);
    expect(created[1]?.roomUrl).toBe(
      "/api/tenants/tnt_1/presence/rooms/workbench:chn_2",
    );
    harness.unmount();
  });

  test("publishCursor forwards to the connected handle", () => {
    const harness = mountHook("tnt_1", "workbench:chn_1");
    harness.result()?.publishCursor(0.5, 0.5, 3);

    expect(created[0]?.cursorCalls).toEqual([
      { x: 0.5, y: 0.5, surfaceVersion: 3 },
    ]);
    harness.unmount();
  });

  test("disconnects on unmount", () => {
    const harness = mountHook("tnt_1", "workbench:chn_1");
    harness.unmount();
    expect(created[0]?.disconnected).toBe(true);
  });

  test("stays ok through a single transient error", () => {
    const harness = mountHook("tnt_1", "artifact:art_1", {
      principalId: "prn_1",
    });
    fireError({ operation: "join", status: 500 });

    expect(harness.result()?.connection).toBe("ok");
    expect(reportErrorCalls).toHaveLength(1);
    harness.unmount();
  });

  test("marks the connection degraded after a second consecutive error", () => {
    const harness = mountHook("tnt_1", "artifact:art_1", {
      principalId: "prn_1",
    });
    fireError({ operation: "join", status: 500 });
    fireError({ operation: "join" });

    expect(harness.result()?.connection).toBe("degraded");
    expect(reportErrorCalls).toHaveLength(2);
    expect(reportErrorCalls[1]?.context).toEqual({
      operation: "presence.join",
      tenantId: "tnt_1",
      roomId: "artifact:art_1",
      extra: { principalId: "prn_1" },
    });
    harness.unmount();
  });

  test("reports every error with room and principal context", () => {
    const harness = mountHook("tnt_1", "artifact:art_1", {
      principalId: "prn_1",
    });
    fireError({ operation: "heartbeat", status: 404 });

    expect(reportErrorCalls).toHaveLength(1);
    const call = reportErrorCalls[0];
    expect(call?.error).toBeInstanceOf(Error);
    expect((call?.error as Error).message).toBe(
      "Presence heartbeat failed (404)",
    );
    expect(call?.context).toEqual({
      operation: "presence.heartbeat",
      tenantId: "tnt_1",
      roomId: "artifact:art_1",
      extra: { principalId: "prn_1", status: 404 },
    });
    harness.unmount();
  });

  test("clears degraded state on successful rejoin", () => {
    const harness = mountHook("tnt_1", "artifact:art_1", {
      principalId: "prn_1",
    });
    fireError({ operation: "join", status: 500 });
    fireError({ operation: "join", status: 500 });
    expect(harness.result()?.connection).toBe("degraded");

    fireRecovered();
    expect(harness.result()?.connection).toBe("ok");
    harness.unmount();
  });
});
