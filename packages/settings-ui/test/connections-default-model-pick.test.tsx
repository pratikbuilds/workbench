// CL-6258 follow-up: "set default models" — the connected provider row's
// default-model caption is a select of that provider's own resolved
// models; picking one must PATCH the target offering's priority through
// the existing `updateOwnOffering` route and re-render the new default
// without a page reload.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ConnectionsSection } from "../src/connections-section";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

const STAMP = "2026-01-01T00:00:00.000Z";

const ANTHROPIC_PROVIDER = {
  id: "prv_anthropic",
  tenantId: "ten_1",
  name: "anthropic",
  plugin: "http",
  createdAt: STAMP,
  updatedAt: STAMP,
};

const ANTHROPIC_CREDENTIAL = {
  id: "crd_anthropic",
  tenantId: "ten_1",
  providerId: "prv_anthropic",
  name: "Anthropic",
  type: "api_key" as const,
  status: "active" as const,
  createdAt: STAMP,
  updatedAt: STAMP,
};

function resolvedModels(sonnetPriority: number, haikuPriority: number) {
  return [
    {
      id: "model_1",
      canonicalName: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      offerings: [
        {
          offeringId: "offering_sonnet",
          providerId: "cat_prv_anthropic",
          providerName: "anthropic",
          plugin: "anthropic",
          priority: sonnetPriority,
          deploymentTags: [],
          capabilities: [],
          pricing: [],
        },
      ],
    },
    {
      id: "model_2",
      canonicalName: "claude-haiku-5",
      displayName: "Claude Haiku 5",
      offerings: [
        {
          offeringId: "offering_haiku",
          providerId: "cat_prv_anthropic",
          providerName: "anthropic",
          plugin: "anthropic",
          priority: haikuPriority,
          deploymentTags: [],
          capabilities: [],
          pricing: [],
        },
      ],
    },
  ];
}

const OWN_OFFERINGS = [
  {
    id: "offering_sonnet",
    tenantId: "ten_1",
    modelId: "model_1",
    providerId: "cat_prv_anthropic",
    priority: 0,
    deploymentTags: [],
    capabilities: [],
    quirks: null,
    disabled: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  },
  {
    id: "offering_haiku",
    tenantId: "ten_1",
    modelId: "model_2",
    providerId: "cat_prv_anthropic",
    priority: 1,
    deploymentTags: [],
    capabilities: [],
    quirks: null,
    disabled: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  },
];

function renderSection() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<ConnectionsSection tenantId="ten_1" />);
  });
  return { container, root };
}

describe("Global model route", () => {
  test("making a fallback primary PATCHes the shared route and re-renders it first", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    let patched = false;

    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        ...(init?.body !== undefined ? { body: String(init.body) } : {}),
      });
      if (url === "/api/tenants/ten_1/credentials") {
        return Promise.resolve(
          json({ data: [ANTHROPIC_CREDENTIAL], nextCursor: null }),
        );
      }
      if (url === "/api/tenants/ten_1/providers") {
        return Promise.resolve(
          json({ data: [ANTHROPIC_PROVIDER], nextCursor: null }),
        );
      }
      if (url === "/api/tenants/ten_1/connections/oauth-configured") {
        return Promise.resolve(json({}));
      }
      if (url === "/api/tenants/ten_1/models") {
        return Promise.resolve(
          json(resolvedModels(patched ? 0 : 0, patched ? -1 : 1)),
        );
      }
      if (url === "/api/tenants/ten_1/catalog/offerings") {
        return Promise.resolve(json({ data: OWN_OFFERINGS, nextCursor: null }));
      }
      if (url === "/api/tenants/ten_1/catalog/offerings/offering_haiku") {
        patched = true;
        return Promise.resolve(json({ ...OWN_OFFERINGS[1], priority: -1 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = renderSection();
    try {
      await settle();

      expect(container.textContent).toContain("Default model");
      expect(container.textContent).toContain("Fallback order");

      const defaultModel = container.querySelector(
        'select[aria-label="Default model"]',
      ) as HTMLSelectElement | null;
      expect(defaultModel?.value).toBe("claude-sonnet-5");

      // Selecting the other model re-fetches the resolved catalog, whose
      // mock now reflects the PATCH having landed (haiku wins).
      act(() => {
        if (defaultModel !== null) {
          defaultModel.value = "claude-haiku-5";
          defaultModel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      await settle();

      const patchCall = calls.find(
        (call) =>
          call.url === "/api/tenants/ten_1/catalog/offerings/offering_haiku",
      );
      expect(patchCall?.method).toBe("PATCH");
      expect(JSON.parse(patchCall?.body ?? "{}")).toEqual({ priority: -1 });

      const updatedDefault = container.querySelector(
        'select[aria-label="Default model"]',
      ) as HTMLSelectElement | null;
      expect(updatedDefault?.value).toBe("claude-haiku-5");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("choosing a default model PATCHes offerings only, never agent capabilities (CL-6782)", async () => {
    const calls: { url: string; method: string }[] = [];
    let patched = false;

    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
      });
      if (url === "/api/tenants/ten_1/credentials") {
        return Promise.resolve(
          json({ data: [ANTHROPIC_CREDENTIAL], nextCursor: null }),
        );
      }
      if (url === "/api/tenants/ten_1/providers") {
        return Promise.resolve(
          json({ data: [ANTHROPIC_PROVIDER], nextCursor: null }),
        );
      }
      if (url === "/api/tenants/ten_1/connections/oauth-configured") {
        return Promise.resolve(json({}));
      }
      if (url === "/api/tenants/ten_1/models") {
        return Promise.resolve(
          json(resolvedModels(patched ? 0 : 0, patched ? -1 : 1)),
        );
      }
      if (url === "/api/tenants/ten_1/catalog/offerings") {
        return Promise.resolve(json({ data: OWN_OFFERINGS, nextCursor: null }));
      }
      if (url === "/api/tenants/ten_1/catalog/offerings/offering_haiku") {
        patched = true;
        return Promise.resolve(json({ ...OWN_OFFERINGS[1], priority: -1 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = renderSection();
    try {
      await settle();

      expect(container.textContent).toContain(
        "does not rewrite models already stored on existing agents",
      );

      const defaultModel = container.querySelector(
        'select[aria-label="Default model"]',
      ) as HTMLSelectElement | null;
      act(() => {
        if (defaultModel !== null) {
          defaultModel.value = "claude-haiku-5";
          defaultModel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      await settle();

      const writes = calls.filter(
        (call) => call.method !== "GET" && call.method !== "HEAD",
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(
        writes.every((call) =>
          call.url.startsWith("/api/tenants/ten_1/catalog/offerings/"),
        ),
      ).toBe(true);
      expect(
        calls.some((call) => call.url.includes("/agent-definitions")),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
