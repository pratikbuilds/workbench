// ACL evaluate probes decide whether People/Roles/Grants/Credentials belong
// in the settings nav. A 200 with effect !== allow is an authenticated deny;
// a thrown probe (network, 5xx) is not — it must not collapse to "denied"
// or those sections vanish as if the principal were unauthorized (CL-6829).

import { afterEach, describe, expect, test } from "bun:test";

import { coalesceSectionAccess, probeSectionAccess } from "../src/access";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(
  respond: (path: string) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    return Promise.resolve(respond(path));
  }) as typeof fetch;
}

describe("probeSectionAccess", () => {
  test("an allow effect is allowed", async () => {
    stubFetch(() => json({ effect: "allow", matchingGrants: [] }));
    await expect(
      probeSectionAccess("tnt_1", "prn_1", "principal"),
    ).resolves.toBe("allowed");
  });

  test("a deny effect is denied", async () => {
    stubFetch(() => json({ effect: "deny", matchingGrants: [] }));
    await expect(
      probeSectionAccess("tnt_1", "prn_1", "principal"),
    ).resolves.toBe("denied");
  });

  test("an ask effect is denied — only allow is allowed", async () => {
    stubFetch(() => json({ effect: "ask", matchingGrants: [] }));
    await expect(probeSectionAccess("tnt_1", "prn_1", "role")).resolves.toBe(
      "denied",
    );
  });

  test("a 5xx is error, not denied", async () => {
    stubFetch(() => json({}, 500));
    await expect(probeSectionAccess("tnt_1", "prn_1", "grant")).resolves.toBe(
      "error",
    );
  });

  test("a network failure is error, not denied", async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        new TypeError("Failed to fetch"),
      )) as unknown as typeof fetch;
    await expect(
      probeSectionAccess("tnt_1", "prn_1", "credential"),
    ).resolves.toBe("error");
  });
});

describe("coalesceSectionAccess", () => {
  test("a failed probe keeps a prior allow so gated nav does not vanish", () => {
    expect(coalesceSectionAccess("allowed", "error")).toBe("allowed");
  });

  test("a failed probe keeps a prior deny so gated nav does not flash", () => {
    expect(coalesceSectionAccess("denied", "error")).toBe("denied");
  });

  test("a failed first probe is error — there is no last-known to keep", () => {
    expect(coalesceSectionAccess("loading", "error")).toBe("error");
  });

  test("a successful deny replaces a prior allow", () => {
    expect(coalesceSectionAccess("allowed", "denied")).toBe("denied");
  });
});
