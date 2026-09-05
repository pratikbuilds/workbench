// Regression coverage for an unknown or gate-denied /settings/:section deep
// link: the URL, stage, and col2 nav must re-agree on the first allowed
// section instead of the stage silently rendering a fallback under a URL
// its own nav disagrees with.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { SETTINGS_STRINGS, type TenancyAccess } from "@corbits/settings-ui";

import type { PrincipalsPage } from "../src/api";
import { BenchProvider } from "../src/bench-context";
import { SettingsRoute } from "../src/pages/settings-page";
import { meKeys, tenantKeys } from "../src/query-client";
import { TestQueryProvider } from "./test-query-provider";

const principalsPage: PrincipalsPage = {
  data: [
    {
      principalId: "principal_1",
      tenantId: "tenant_1",
      tenantName: "ABK Labs",
      tenantSlug: "abk-labs",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

const deniedAccess: TenancyAccess = {
  people: "denied",
  roles: "denied",
  grants: "denied",
  credentials: "denied",
};

const errorAccess: TenancyAccess = {
  people: "error",
  roles: "error",
  grants: "error",
  credentials: "error",
};

/** A client pre-seeded so both the bench and the settings-access probe are
 * already resolved on first render — deterministic, no real network. */
function seededClient(access: TenancyAccess = deniedAccess): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  client.setQueryData(meKeys.principals, principalsPage);
  client.setQueryData(
    tenantKeys.settingsAccess("tenant_1", "principal_1"),
    access,
  );
  return client;
}

describe("SettingsRoute section-id redirect", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  async function mount(
    path: string,
    navigated: string[],
    access: TenancyAccess = deniedAccess,
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider client={seededClient(access)}>
          <BenchProvider>
            <SettingsRoute path={path} navigate={(to) => navigated.push(to)} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
  }

  test("an unknown section id redirects to the first allowed section", async () => {
    const navigated: string[] = [];
    await mount("/settings/no-such-section", navigated);
    expect(navigated).toEqual(["/settings/account"]);
  });

  test("a gate-denied section id redirects to the first allowed section", async () => {
    const navigated: string[] = [];
    await mount("/settings/people", navigated);
    expect(navigated).toEqual(["/settings/account"]);
  });

  test("an always-allowed section id does not redirect", async () => {
    const navigated: string[] = [];
    await mount("/settings/account", navigated);
    expect(navigated).toEqual([]);
  });

  test("a probe failure is not presented as a gate deny", async () => {
    const navigated: string[] = [];
    await mount("/settings/account", navigated, errorAccess);
    expect(container?.textContent).toContain(
      SETTINGS_STRINGS.accessProbeFailedHint,
    );
    expect(container?.textContent).not.toContain(
      SETTINGS_STRINGS.peopleSectionTitle,
    );
  });

  test("a gate deny does not claim the access check failed", async () => {
    const navigated: string[] = [];
    await mount("/settings/account", navigated);
    expect(container?.textContent).not.toContain(
      SETTINGS_STRINGS.accessProbeFailedHint,
    );
  });
});
