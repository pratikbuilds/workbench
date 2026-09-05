// Verifies the "Manage" dialog for an already-connected Granola binding
// (webhookTrigger exists, nothing just revealed) shows the hook URL and
// warns that rotating invalidates the old secret immediately — the same
// information WebhookTriggerPanel (apps/web/src/pages/routines-page.tsx)
// persistently shows in its own unrevealed state.

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

describe("GranolaWebhookCard Manage dialog (already connected)", () => {
  test("shows the hook URL and an invalidation warning without clicking Rotate", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.startsWith("/api/tenants/ten_1/workflows/definitions")) {
        return json(200, {
          data: [{ id: "def_1", name: "granola-call", status: "active" }],
          nextCursor: null,
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
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      const manageButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Manage",
      );
      expect(manageButton).not.toBeUndefined();
      act(() => manageButton?.click());
      await settle();

      // The hook URL is not secret (it's derived from the trigger id) and
      // should be visible/copyable without forcing a rotate.
      expect(document.body.textContent).toContain("/api/webhooks/wht_1");
      // Rotating should be flagged as immediately invalidating the old
      // secret, mirroring routines-page's WebhookTriggerPanel copy.
      expect(document.body.textContent?.toLowerCase()).toContain(
        "stops verifying immediately",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
