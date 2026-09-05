// Screen-level proof for the Routines page's "Available" section
// (CL-7073): lists catalog workflows the bench hasn't added yet, Add
// posts through the existing template-blocks deploy route, and a
// missing required connection disables Add with a reason instead of
// letting the request fail.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { AvailableCatalogWorkflowsSection } from "../src/pages/routines-page";
import { NavigationProvider } from "../src/navigation";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const codeReview = {
  assetName: "code-review",
  displayName: "Code review",
  description: "Reviews a pull request and posts one review back on it.",
  requiredConnections: ["github"],
  missingConnections: ["github"],
  connectionsSatisfied: false,
  deployable: true,
};

const echo = {
  assetName: "echo",
  displayName: "Echo",
  description: "Replies with the exact text it received.",
  requiredConnections: [],
  missingConnections: [],
  connectionsSatisfied: true,
  deployable: true,
};

const granolaCall = {
  assetName: "granola-call",
  displayName: "Granola call",
  description: "Polls Granola for new calls and starts a call-notes run.",
  requiredConnections: ["granola"],
  missingConnections: ["granola"],
  connectionsSatisfied: false,
  deployable: false,
  notDeployableReason: "credential_bindings_unsupported",
};

async function render(
  fetchImpl: typeof fetch,
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  await act(async () => {
    root.render(
      <TestQueryProvider>
        <NavigationProvider navigate={noop}>
          {createElement(AvailableCatalogWorkflowsSection, {
            tenantId: "tnt_1",
          })}
        </NavigationProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  (container as unknown as { __realFetch: typeof fetch }).__realFetch =
    realFetch;
  return { container, root };
}

function restoreFetch(container: HTMLDivElement, root: Root): void {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = (
    container as unknown as { __realFetch: typeof fetch }
  ).__realFetch;
  window.localStorage.clear();
}

describe("AvailableCatalogWorkflowsSection", () => {
  test("renders every available entry with its display name and description", async () => {
    const { container, root } = await render((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.includes("/workflows/available")) {
        return jsonResponse({ items: [codeReview, echo] });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch);
    try {
      expect(container.textContent).toContain("Code review");
      expect(container.textContent).toContain(
        "Reviews a pull request and posts one review back on it.",
      );
      expect(container.textContent).toContain("Echo");
    } finally {
      restoreFetch(container, root);
    }
  });

  test("Add is disabled with a reason when a required connection is missing, and links to Plugins", async () => {
    const { container, root } = await render((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.includes("/workflows/available")) {
        return jsonResponse({ items: [codeReview] });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch);
    try {
      const addButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Add",
      );
      expect(addButton).not.toBeUndefined();
      expect(addButton?.hasAttribute("disabled")).toBe(true);
      expect(container.textContent).toContain("Connect GitHub first.");
      const link = container.querySelector("a");
      expect(link?.getAttribute("href")).toBe("/plugins");
    } finally {
      restoreFetch(container, root);
    }
  });

  test("Add is disabled with 'Coming with the next platform update.' for a not-yet-deployable entry, and never links to Plugins", async () => {
    const { container, root } = await render((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.includes("/workflows/available")) {
        return jsonResponse({ items: [granolaCall] });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch);
    try {
      const addButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Add",
      );
      expect(addButton).not.toBeUndefined();
      expect(addButton?.hasAttribute("disabled")).toBe(true);
      expect(container.textContent).toContain(
        "Coming with the next platform update.",
      );
      expect(container.textContent).not.toContain("Connect");
      expect(container.querySelector("a")).toBeNull();
    } finally {
      restoreFetch(container, root);
    }
  });

  test("Add posts to the template-blocks deploy route and the entry disappears from Available", async () => {
    let available = [echo];
    let deployCalls = 0;
    const { container, root } = await render((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/workflows/available")) {
        return jsonResponse({ items: available });
      }
      if (url.includes("/template-blocks/echo/deploy")) {
        deployCalls += 1;
        expect(init?.method).toBe("POST");
        available = [];
        return jsonResponse({ id: "wfd_echo", created: true });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch);
    try {
      const addButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Add",
      );
      expect(addButton).not.toBeUndefined();
      await act(async () => {
        addButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      for (let i = 0; i < 8; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      expect(deployCalls).toBe(1);
      expect(container.textContent).not.toContain("Echo");
    } finally {
      restoreFetch(container, root);
    }
  });
});
