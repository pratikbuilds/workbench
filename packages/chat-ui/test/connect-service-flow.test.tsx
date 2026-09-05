// Container + actions-port round-trip for the generic service connect
// card (CL-6393): an initial `getConnectState` read on mount, live
// `subscribeConnectState` folds after — the same contract
// `connect-github-flow.test.tsx` proves for the GitHub card. The flip
// to "connected" arriving through the subscription is the card's whole
// point: OAuth finishes in another tab, the event flips the card here.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  ConnectServiceActions,
  ConnectServiceQuery,
} from "../src/blocks/connect-service-actions";
import { ConnectServiceBlockContainer } from "../src/blocks/connect-service-block-container";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mountElement(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

const DATA = {
  connectorId: "gmail",
  displayName: "Gmail",
  reason: "Connect Gmail so I can send this for you.",
};

function fakeActions(initial: ConnectServiceQuery): {
  readonly actions: ConnectServiceActions;
  readonly push: (query: ConnectServiceQuery) => void;
  readonly connects: string[];
} {
  const listeners = new Set<(query: ConnectServiceQuery) => void>();
  const connects: string[] = [];
  return {
    actions: {
      getConnectState: () => Promise.resolve(initial),
      subscribeConnectState: (_connectorId, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      notifySettingsChanged: async () => undefined,
      connect: (connectorId) => {
        connects.push(connectorId);
        return Promise.resolve({ ok: true });
      },
      submitKey: () => Promise.resolve({ ok: true }),
    },
    push: (query) => {
      for (const listener of listeners) listener(query);
    },
    connects,
  };
}

describe("ConnectServiceBlockContainer", () => {
  test("reads the live state on mount and wires connect to the port", async () => {
    const fake = fakeActions({ kind: "disconnected", affordance: "oauth" });
    const host = await mountElement(
      <ConnectServiceBlockContainer data={DATA} actions={fake.actions} />,
    );
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Connect Gmail",
    );
    if (button === undefined) throw new Error("no connect button");
    await act(async () => {
      button.click();
    });
    expect(fake.connects).toEqual(["gmail"]);
  });

  test("flips to connected when the subscription reports it", async () => {
    const fake = fakeActions({ kind: "disconnected", affordance: "oauth" });
    const host = await mountElement(
      <ConnectServiceBlockContainer data={DATA} actions={fake.actions} />,
    );
    await act(async () => {
      fake.push({ kind: "connected" });
    });
    expect(host.textContent).toContain("Gmail connected");
  });

  test("renders the disconnected framing with no port at all", async () => {
    const host = await mountElement(
      <ConnectServiceBlockContainer data={DATA} />,
    );
    expect(host.textContent).toContain("Connect Gmail");
  });
});
