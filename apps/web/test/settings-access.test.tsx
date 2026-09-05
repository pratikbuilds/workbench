// The app's cached settings-access probe must agree with
// `@corbits/settings-ui`'s mapping: evaluate effect !== allow is deny;
// a thrown probe is error, not deny (CL-6829).

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TenancyAccess } from "@corbits/settings-ui";

import { useSettingsAccess } from "../src/settings-access";
import {
  createTestQueryClient,
  TestQueryProvider,
} from "./test-query-provider";

const realFetch = globalThis.fetch;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function AccessProbe({
  onAccess,
}: {
  readonly onAccess: (access: TenancyAccess) => void;
}) {
  const access = useSettingsAccess("tnt_1", "prn_1");
  onAccess(access);
  return null;
}

async function mountProbe(): Promise<TenancyAccess[]> {
  const seen: TenancyAccess[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = createTestQueryClient();
  await act(async () => {
    root?.render(
      <TestQueryProvider client={client}>
        <AccessProbe onAccess={(access) => seen.push(access)} />
      </TestQueryProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return seen;
}

describe("useSettingsAccess", () => {
  test("a deny effect is denied", async () => {
    globalThis.fetch = (async () =>
      json({ effect: "deny", matchingGrants: [] })) as unknown as typeof fetch;
    const seen = await mountProbe();
    const last = seen[seen.length - 1];
    expect(last).toEqual({
      people: "denied",
      roles: "denied",
      grants: "denied",
      credentials: "denied",
    });
  });

  test("a 5xx is error, not denied", async () => {
    globalThis.fetch = (async () => json({}, 500)) as unknown as typeof fetch;
    const seen = await mountProbe();
    const last = seen[seen.length - 1];
    expect(last).toEqual({
      people: "error",
      roles: "error",
      grants: "error",
      credentials: "error",
    });
  });

  test("a network failure is error, not denied", async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        new TypeError("Failed to fetch"),
      )) as unknown as typeof fetch;
    const seen = await mountProbe();
    const last = seen[seen.length - 1];
    expect(last).toEqual({
      people: "error",
      roles: "error",
      grants: "error",
      credentials: "error",
    });
  });
});
