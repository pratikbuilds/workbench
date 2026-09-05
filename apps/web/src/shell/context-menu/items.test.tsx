import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { spyOnReactUiToast } from "../../../test/react-ui-toast-mock";
import type { ContextMenuEntry } from "@corbits/context-menu";
import { WORKBENCHES_MUTATED_EVENT } from "@corbits/chat-ui";
import * as errorSink from "@corbits/error-sink";

const toastMock = spyOnReactUiToast();

import { shellContextMenuFor } from "./items";
import type { ShellContextMenuActions } from "./items";
import type { ShellContextMenuTarget } from "./targets";
import { LIBRARY_BULK_OPERATION_IDS } from "../library-artifacts";

function itemIds(entries: readonly ContextMenuEntry[]): readonly string[] {
  return entries
    .filter(
      (entry): entry is Extract<ContextMenuEntry, { kind: "item" }> =>
        entry.kind === "item",
    )
    .map((entry) => entry.id);
}

function findItem(entries: readonly ContextMenuEntry[], id: string) {
  const entry = entries.find(
    (candidate) => candidate.kind === "item" && candidate.id === id,
  );
  if (entry === undefined || entry.kind !== "item") {
    throw new Error(`no item "${id}" in menu`);
  }
  return entry;
}

function actions(
  overrides: Partial<ShellContextMenuActions> = {},
): ShellContextMenuActions {
  return {
    tenantId: "tenant-1",
    navigate: mock(() => undefined),
    openProfile: mock(() => undefined),
    cycleTheme: mock(() => undefined),
    signOut: mock(() => undefined),
    onRoutineRan: mock((_tenantId: string) => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock(() => Promise.resolve()) },
  });
  toastMock.mockClear();
});

describe("shellContextMenuFor: workbench", () => {
  const target: ShellContextMenuTarget = {
    type: "workbench",
    id: "ch-1",
    title: "Launch Planning",
    pinned: false,
  };

  test("offers rename, pin, and copy-link with a tenant selected", () => {
    const menu = shellContextMenuFor(target, actions());
    expect(itemIds(menu.entries)).toEqual(["rename", "pin", "copy-link"]);
    expect(findItem(menu.entries, "pin").label).toBe("Pin workbench");
  });

  test("labels the pin item Unpin for an already-pinned workbench", () => {
    const menu = shellContextMenuFor({ ...target, pinned: true }, actions());
    expect(findItem(menu.entries, "pin").label).toBe("Unpin workbench");
  });

  test("drops the pin item without a selected tenant", () => {
    const menu = shellContextMenuFor(target, actions({ tenantId: null }));
    expect(itemIds(menu.entries)).toEqual(["rename", "copy-link"]);
  });

  test("pin dispatches WORKBENCHES_MUTATED_EVENT so the sidebar list refetches (CL-6657)", async () => {
    const realFetch = globalThis.fetch;
    // `patchWorkbenchSettings` validates against WorkbenchSettingsResponse —
    // a partial body rejects and the success path (event + toast) never runs.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "ch-1",
            title: "Launch Planning",
            kind: "workbench",
            pinned: true,
            participants: [],
            settings: { "chat/pinned": true },
            contextWindow: { value: 0, source: "inherit" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener(WORKBENCHES_MUTATED_EVENT, listener);
    try {
      const menu = shellContextMenuFor(target, actions());
      findItem(menu.entries, "pin").onSelect();
      // request() awaits fetch then response.json() before the success
      // .then (event + toast) runs — a few microtasks alone fall short.
      for (let i = 0; i < 10 && events.length === 0; i++) {
        await Promise.resolve();
      }
      if (events.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(events).toHaveLength(1);
      expect((events[0] as CustomEvent<{ tenantId: string }>).detail).toEqual({
        tenantId: "tenant-1",
      });
      expect(toastMock).toHaveBeenCalledWith("Workbench pinned");
    } finally {
      window.removeEventListener(WORKBENCHES_MUTATED_EVENT, listener);
      globalThis.fetch = realFetch;
    }
  });

  test("copy-link writes the workbench's canonical URL to the clipboard", async () => {
    const menu = shellContextMenuFor(target, actions());
    findItem(menu.entries, "copy-link").onSelect();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/w/ch-1`,
    );
    expect(toastMock).toHaveBeenCalledWith("Launch Planning link copied");
  });

  test("copy-link surfaces a toast instead of throwing when the clipboard write fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mock(() => Promise.reject(new Error("denied"))) },
    });
    const menu = shellContextMenuFor(target, actions());

    expect(() => findItem(menu.entries, "copy-link").onSelect()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastMock).toHaveBeenCalledWith("Couldn't copy the link");
  });
});

describe("shellContextMenuFor: profile", () => {
  test("offers exactly one open-profile item", () => {
    const target: ShellContextMenuTarget = {
      type: "profile",
      address: "agent:echo",
      handle: "echo",
    };
    const openProfile = mock(() => undefined);
    const menu = shellContextMenuFor(target, actions({ openProfile }));
    expect(itemIds(menu.entries)).toEqual(["open-profile"]);
    findItem(menu.entries, "open-profile").onSelect();
    expect(openProfile).toHaveBeenCalledTimes(1);
  });
});

describe("shellContextMenuFor: routine", () => {
  const target: ShellContextMenuTarget = {
    type: "routine",
    id: "rt-1",
    name: "Nightly Digest",
  };

  test("offers open, run-now, and copy-link with a tenant selected", () => {
    const menu = shellContextMenuFor(target, actions());
    expect(itemIds(menu.entries)).toEqual(["open", "run-now", "copy-link"]);
  });

  test("drops run-now without a selected tenant", () => {
    const menu = shellContextMenuFor(target, actions({ tenantId: null }));
    expect(itemIds(menu.entries)).toEqual(["open", "copy-link"]);
  });

  test("open navigates to the routine's canonical route", () => {
    const navigate = mock((_to: string) => undefined);
    const menu = shellContextMenuFor(target, actions({ navigate }));
    findItem(menu.entries, "open").onSelect();
    expect(navigate).toHaveBeenCalledWith("/routines/rt-1");
  });

  test("run-now invalidates routine queries via onRoutineRan once the run starts", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ runId: "run-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    const onRoutineRan = mock((_tenantId: string) => undefined);
    try {
      const menu = shellContextMenuFor(target, actions({ onRoutineRan }));
      findItem(menu.entries, "run-now").onSelect();
      for (let i = 0; i < 10 && onRoutineRan.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(onRoutineRan).toHaveBeenCalledWith("tenant-1");
      expect(toastMock).toHaveBeenCalledWith("Nightly Digest started");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("run-now does not invalidate routine queries when the run fails to start", async () => {
    const realFetch = globalThis.fetch;
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    const onRoutineRan = mock((_tenantId: string) => undefined);
    try {
      const menu = shellContextMenuFor(target, actions({ onRoutineRan }));
      findItem(menu.entries, "run-now").onSelect();
      for (let i = 0; i < 10 && toastMock.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(toastMock).toHaveBeenCalledWith("Couldn't start the routine");
      expect(onRoutineRan).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalled();
      expect(report.mock.calls[0]?.[1]).toEqual({
        operation: "scheduled_workflow_run_now",
        tenantId: "tenant-1",
      });
    } finally {
      report.mockRestore();
      globalThis.fetch = realFetch;
    }
  });
});

describe("shellContextMenuFor: insights-run", () => {
  test("offers open and copy-link, pointed at the run's canonical route", () => {
    const target: ShellContextMenuTarget = {
      type: "insights-run",
      id: "run-1",
    };
    const navigate = mock((_to: string) => undefined);
    const menu = shellContextMenuFor(target, actions({ navigate }));
    expect(itemIds(menu.entries)).toEqual(["open", "copy-link"]);
    findItem(menu.entries, "open").onSelect();
    expect(navigate).toHaveBeenCalledWith("/insights/runs/run-1");
  });
});

describe("shellContextMenuFor: artifact", () => {
  test("a single right-clicked file offers exactly the Files bulk action bar's operation set", () => {
    const target: ShellContextMenuTarget = {
      type: "artifact",
      id: "art_1",
      ids: ["art_1"],
    };
    const menu = shellContextMenuFor(target, actions());
    // Parity, not eyeballing: the context menu and the bulk action bar are
    // driven off the exact same constant (CL-6423).
    expect(itemIds(menu.entries)).toEqual([...LIBRARY_BULK_OPERATION_IDS]);
    expect(findItem(menu.entries, "copy-link").label).toBe("Copy link");
  });

  test("right-clicking inside a multi-select still offers the same operation set, pluralized", () => {
    const target: ShellContextMenuTarget = {
      type: "artifact",
      id: "art_2",
      ids: ["art_1", "art_2", "art_3"],
    };
    const menu = shellContextMenuFor(target, actions());
    expect(itemIds(menu.entries)).toEqual([...LIBRARY_BULK_OPERATION_IDS]);
    expect(findItem(menu.entries, "copy-link").label).toBe("Copy 3 links");
  });

  test("copy-link writes every acted-on file's canonical link, newline-joined", async () => {
    const target: ShellContextMenuTarget = {
      type: "artifact",
      id: "art_1",
      ids: ["art_1", "art_2"],
    };
    const menu = shellContextMenuFor(target, actions());
    findItem(menu.entries, "copy-link").onSelect();
    await Promise.resolve();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/files/a/art_1\n${window.location.origin}/files/a/art_2`,
    );
    expect(toastMock).toHaveBeenCalledWith("2 links copied");
  });
});

describe("shellContextMenuFor: account", () => {
  test("offers settings and sign-out, never a bare destructive gesture", () => {
    const menu = shellContextMenuFor({ type: "account" }, actions());
    expect(itemIds(menu.entries)).toEqual(["settings", "sign-out"]);
  });

  test("settings navigates to the settings route", () => {
    const navigate = mock((_to: string) => undefined);
    const menu = shellContextMenuFor(
      { type: "account" },
      actions({ navigate }),
    );
    findItem(menu.entries, "settings").onSelect();
    expect(navigate).toHaveBeenCalledWith("/settings");
  });

  test("sign-out only fires from its own explicit menu item", () => {
    const signOut = mock(() => undefined);
    const menu = shellContextMenuFor({ type: "account" }, actions({ signOut }));
    expect(signOut).not.toHaveBeenCalled();
    findItem(menu.entries, "sign-out").onSelect();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("shellContextMenuFor: shell", () => {
  test("offers search, workbenches, and theme", () => {
    const menu = shellContextMenuFor({ type: "shell" }, actions());
    expect(itemIds(menu.entries)).toEqual(["search", "workbenches", "theme"]);
  });

  test("theme item calls cycleTheme", () => {
    const cycleTheme = mock(() => undefined);
    const menu = shellContextMenuFor(
      { type: "shell" },
      actions({ cycleTheme }),
    );
    findItem(menu.entries, "theme").onSelect();
    expect(cycleTheme).toHaveBeenCalledTimes(1);
  });
});
