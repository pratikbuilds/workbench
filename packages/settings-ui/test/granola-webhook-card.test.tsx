// The Granola webhook connector card: "Not set up" when no granola-call
// workflow definition has a webhook trigger yet, "Connected" with a trigger
// count and last-delivery readout once one does, and a dialog that
// creates/rotates through the real webhook-triggers routes, revealing the
// secret exactly once per the shell precedent.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ConnectorDescriptor } from "@corbits/connections/registry";

import { GranolaWebhookCard } from "../src/granola-webhook-card";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

const descriptor: ConnectorDescriptor = {
  id: "granola-webhook",
  displayName: "Granola inbound webhook",
  authKind: "webhook-secret",
  docsUrl: "https://www.granola.ai",
  credentialPlugin: "http",
  feedsTools: [],
};

function definitionsResponse(
  definitions: readonly { id: string; name: string }[],
) {
  return json(200, {
    data: definitions.map((d) => ({ ...d, status: "active" })),
    nextCursor: null,
  });
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <GranolaWebhookCard tenantId="ten_1" descriptor={descriptor} />,
    );
  });
  return { container, root };
}

describe("GranolaWebhookCard", () => {
  test("reads Not set up when no granola-call definition exists", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.startsWith("/api/tenants/ten_1/workflows/definitions")) {
        return definitionsResponse([]);
      }
      if (url === "/api/tenants/ten_1/webhook-triggers") {
        return json(200, { items: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Granola inbound webhook");
      expect(container.textContent).toContain("Not set up");
      expect(container.textContent).toContain(
        "Workbench gives you a signed webhook address Granola calls",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("reads Connected with a trigger count once a granola-call definition has a webhook trigger", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.startsWith("/api/tenants/ten_1/workflows/definitions")) {
        return definitionsResponse([{ id: "def_1", name: "granola-call" }]);
      }
      if (url === "/api/tenants/ten_1/webhook-triggers") {
        return json(200, {
          items: [
            {
              id: "wht_1",
              name: "Granola calls webhook",
              workflowDefinitionId: "def_1",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              lastFiredAt: null,
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Connected");
      expect(container.textContent).toContain("1 webhook wired");
      expect(container.textContent).toContain("No deliveries yet");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("create flow mints a trigger and reveals the secret once", async () => {
    let createBody: unknown;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/tenants/ten_1/workflows/definitions")) {
        return definitionsResponse([{ id: "def_1", name: "granola-call" }]);
      }
      if (
        url === "/api/tenants/ten_1/webhook-triggers" &&
        init?.method === "POST"
      ) {
        createBody = JSON.parse(String(init.body));
        return json(201, {
          id: "wht_new",
          name: "granola-call",
          workflowDefinitionId: "def_1",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastFiredAt: null,
          secret: "sec_fresh",
        });
      }
      if (url === "/api/tenants/ten_1/webhook-triggers") {
        return json(200, { items: [] });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      const setUpButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Set up",
      );
      expect(setUpButton).not.toBeUndefined();
      act(() => setUpButton?.click());
      await settle();

      const createButton = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Create",
      );
      expect(createButton).not.toBeUndefined();
      act(() => createButton?.click());
      await settle();

      expect(createBody).toEqual({
        name: "granola-call",
        workflowDefinitionId: "def_1",
        inputTemplate: "New webhook delivery.",
      });
      expect(document.body.textContent).toContain("sec_fresh");
      expect(document.body.textContent).toContain("shown once");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("rotate flow warns before the click, reveals the new secret once, and clears on close", async () => {
    let rotateCalls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/tenants/ten_1/workflows/definitions")) {
        return definitionsResponse([{ id: "def_1", name: "granola-call" }]);
      }
      if (
        url === "/api/tenants/ten_1/webhook-triggers/wht_1/rotate-secret" &&
        init?.method === "POST"
      ) {
        rotateCalls += 1;
        return json(200, {
          id: "wht_1",
          name: "Granola calls webhook",
          workflowDefinitionId: "def_1",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastFiredAt: null,
          secret: "sec_rotated",
        });
      }
      if (url === "/api/tenants/ten_1/webhook-triggers") {
        return json(200, {
          items: [
            {
              id: "wht_1",
              name: "Granola calls webhook",
              workflowDefinitionId: "def_1",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              lastFiredAt: null,
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      const manageButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Manage",
      );
      act(() => manageButton?.click());
      await settle();

      // The invalidation warning must be visible before the destructive
      // click, not only after — this is the regression the review flagged.
      expect(document.body.textContent?.toLowerCase()).toContain(
        "stops verifying immediately",
      );

      // The bound-and-hidden state reuses the same react-ui-backed field
      // row the rest of the dialog uses (see webhook-secret-panel.tsx),
      // not a hand-rolled Tailwind box — and that row is zero-radius like
      // every other settings surface.
      expect(document.body.innerHTML).toContain("settings-webhook-field-box");
      expect(document.body.innerHTML).not.toContain("rounded-[var(--ui-radius");
      expect(document.body.textContent).toContain("Hook URL");
      expect(document.body.textContent).toContain("Signing secret");

      const rotateButton = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Rotate secret",
      );
      expect(rotateButton).not.toBeUndefined();
      act(() => rotateButton?.click());
      await settle();

      expect(rotateCalls).toBe(1);
      expect(document.body.textContent).toContain("sec_rotated");
      expect(document.body.textContent).toContain("shown once");

      const cancelButton = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      );
      act(() => cancelButton?.click());
      await settle();
      expect(document.body.textContent).not.toContain("sec_rotated");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
