// CL-6075: the People section lists humans only. A tenant with one real
// member and several machine principals (one per folded-run launch, kind
// "workflow") must render exactly the human row — never the machine rows
// flooding the human-management surface.
//
// CL-5879: invite-by-email creates a pending invite (not a native invite,
// which only works for existing accounts), role changes go through the
// native role-assignment routes, the last owner can't be demoted, and a
// pending invite can be cancelled.
//
// CL-7378: the People table's Actions cells must not inherit page-fill's
// nowrap+ellipsis clip, or Suspend/Remove controls get truncated.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

const reportErrorCalls: {
  error: unknown;
  context: Record<string, unknown>;
}[] = [];
mock.module("@corbits/error-sink", () => ({
  reportError: (error: unknown, context: Record<string, unknown>) => {
    reportErrorCalls.push({ error, context });
    return "ref_test";
  },
}));

const { PeopleSection, PeopleTable } = await import("../src/people-section");

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

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const OWNER_ROLE = {
  id: "role_owner",
  tenantId: "tnt_1",
  name: "owner",
  isSystem: true,
  ...timestamps,
};
const MEMBER_ROLE = {
  id: "role_member",
  tenantId: "tnt_1",
  name: "member",
  isSystem: true,
  ...timestamps,
};

function workflowPrincipal(n: number) {
  return {
    id: `prn_workflow_${n}`,
    tenantId: "tnt_1",
    kind: "workflow" as const,
    refId: `run_${n}`,
    displayName: `Workflow (run_${n}@alice-0ufqkxuy.localhost)`,
    status: "active" as const,
    roles: [],
    ...timestamps,
  };
}

function humanPrincipal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "prn_human_1",
    tenantId: "tnt_1",
    kind: "user" as const,
    refId: "user_1",
    displayName: "Alice Anderson",
    status: "active" as const,
    roles: [OWNER_ROLE].map((r) => ({ id: r.id, name: r.name })),
    ...timestamps,
    ...overrides,
  };
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PeopleSection tenantId="tnt_1" />);
  });
  return { container, root };
}

type FetchCall = { url: string; init: RequestInit | undefined };

function mockFetch(handlers: Record<string, unknown>, calls: FetchCall[]) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    if (key in handlers) {
      const value = handlers[key];
      return typeof value === "function" ? value() : json(200, value);
    }
    if (url in handlers) {
      const value = handlers[url];
      return typeof value === "function" ? value() : json(200, value);
    }
    throw new Error(`unexpected fetch: ${key}`);
  }) as unknown as typeof fetch;
}

const rolesPage = { data: [OWNER_ROLE, MEMBER_ROLE], nextCursor: null };
const noInvites = { data: [] };

describe("PeopleSection", () => {
  test("excludes workflow-kind rows and renders only the human member", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      {
        "/api/tenants/tnt_1/principals": {
          data: [
            workflowPrincipal(1),
            workflowPrincipal(2),
            workflowPrincipal(3),
            humanPrincipal(),
          ],
          nextCursor: null,
        },
        "/api/tenants/tnt_1/roles": rolesPage,
        "/api/tenants/tnt_1/access-policy/pending-invites": noInvites,
      },
      calls,
    );

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Alice Anderson");
      expect(container.textContent).not.toContain("Workflow");
      expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("shows the empty state when only machine principals exist", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      {
        "/api/tenants/tnt_1/principals": {
          data: [workflowPrincipal(1), workflowPrincipal(2)],
          nextCursor: null,
        },
        "/api/tenants/tnt_1/roles": rolesPage,
        "/api/tenants/tnt_1/access-policy/pending-invites": noInvites,
      },
      calls,
    );

    const { container, root } = mount();
    try {
      await settle();
      expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("inviting someone creates a pending invite with the chosen role", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      {
        "/api/tenants/tnt_1/principals": {
          data: [humanPrincipal()],
          nextCursor: null,
        },
        "/api/tenants/tnt_1/roles": rolesPage,
        "/api/tenants/tnt_1/access-policy/pending-invites": noInvites,
        "POST /api/tenants/tnt_1/access-policy/pending-invites": () =>
          json(201, {
            id: "pinv_1",
            tenantId: "tnt_1",
            matchType: "email",
            value: "bob@example.com",
            roleId: "role_member",
            createdAt: timestamps.createdAt,
          }),
      },
      calls,
    );

    const { container, root } = mount();
    try {
      await settle();

      const inviteButton = Array.from(
        container.querySelectorAll("button"),
      ).find((b) => b.textContent === "Invite someone");
      expect(inviteButton).toBeDefined();
      act(() =>
        inviteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      await settle();

      const emailInput = document.querySelector(
        'input[type="email"]',
      ) as HTMLInputElement;
      act(() => setNativeValue(emailInput, "bob@example.com"));
      await settle();

      const form = document.getElementById(
        "invite-person-form",
      ) as HTMLFormElement;
      act(() => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await settle();

      const inviteCall = calls.find(
        (c) =>
          c.url === "/api/tenants/tnt_1/access-policy/pending-invites" &&
          c.init?.method === "POST",
      );
      if (inviteCall === undefined) throw new Error("invite call not found");
      const body = JSON.parse(inviteCall.init?.body as string);
      expect(body).toEqual({
        matchType: "email",
        value: "bob@example.com",
        roleId: "role_member",
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("changing a member's role calls the role-assignment API", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      {
        "/api/tenants/tnt_1/principals": {
          data: [
            humanPrincipal(),
            humanPrincipal({
              id: "prn_human_2",
              displayName: "Bob Baker",
              refId: "user_2",
              roles: [{ id: MEMBER_ROLE.id, name: MEMBER_ROLE.name }],
            }),
          ],
          nextCursor: null,
        },
        "/api/tenants/tnt_1/roles": rolesPage,
        "/api/tenants/tnt_1/access-policy/pending-invites": noInvites,
        "POST /api/tenants/tnt_1/principals/prn_human_2/roles/role_owner": () =>
          json(200, {}),
        "DELETE /api/tenants/tnt_1/principals/prn_human_2/roles/role_member":
          () => json(204, undefined),
      },
      calls,
    );

    const { container, root } = mount();
    try {
      await settle();
      const selects = container.querySelectorAll("tbody select");
      const bobSelect = Array.from(selects).find(
        (s) => (s as HTMLSelectElement).value === "role_member",
      ) as HTMLSelectElement;
      expect(bobSelect).toBeDefined();

      act(() => {
        bobSelect.value = "role_owner";
        bobSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();

      expect(
        calls.some(
          (c) =>
            c.url ===
              "/api/tenants/tnt_1/principals/prn_human_2/roles/role_member" &&
            c.init?.method === "DELETE",
        ),
      ).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.url ===
              "/api/tenants/tnt_1/principals/prn_human_2/roles/role_owner" &&
            c.init?.method === "POST",
        ),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("blocks demoting the last owner and never calls the API", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      {
        "/api/tenants/tnt_1/principals": {
          data: [humanPrincipal()],
          nextCursor: null,
        },
        "/api/tenants/tnt_1/roles": rolesPage,
        "/api/tenants/tnt_1/access-policy/pending-invites": noInvites,
      },
      calls,
    );

    const { container, root } = mount();
    try {
      await settle();
      const select = container.querySelector(
        "tbody select",
      ) as HTMLSelectElement;
      expect(select.value).toBe("role_owner");

      act(() => {
        select.value = "role_member";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();

      expect(
        calls.some(
          (c) =>
            c.init?.method === "DELETE" ||
            (c.init?.method === "POST" && c.url.includes("/roles/")),
        ),
      ).toBe(false);
      expect(container.textContent).toContain(
        "This workbench needs at least one owner",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("cancelling a pending invite deletes it", async () => {
    const calls: FetchCall[] = [];
    mockFetch(
      {
        "/api/tenants/tnt_1/principals": {
          data: [humanPrincipal()],
          nextCursor: null,
        },
        "/api/tenants/tnt_1/roles": rolesPage,
        "/api/tenants/tnt_1/access-policy/pending-invites": {
          data: [
            {
              id: "pinv_1",
              tenantId: "tnt_1",
              matchType: "email",
              value: "carol@example.com",
              roleId: "role_member",
              createdAt: timestamps.createdAt,
            },
          ],
        },
        "DELETE /api/tenants/tnt_1/access-policy/pending-invites/pinv_1": () =>
          json(204, undefined),
      },
      calls,
    );

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("carol@example.com");

      const cancelButton = Array.from(
        container.querySelectorAll("button"),
      ).find((b) => b.textContent === "Cancel");
      expect(cancelButton).toBeDefined();
      act(() =>
        cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      await settle();

      const confirmButton = Array.from(
        container.querySelectorAll("button"),
      ).find((b) => b.textContent?.includes("Cancel this invite"));
      if (confirmButton !== undefined) {
        act(() =>
          confirmButton.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          ),
        );
        await settle();
      }

      expect(
        calls.some(
          (c) =>
            c.url ===
              "/api/tenants/tnt_1/access-policy/pending-invites/pinv_1" &&
            c.init?.method === "DELETE",
        ),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  // CL-7139: every mutation catch must report the failure through
  // reportError with its own operation, not just set the generic message.
  const REPORT_ERROR_CASES: {
    readonly name: string;
    readonly operation: string;
    readonly principals: unknown[];
    readonly invites: { readonly data: unknown[] };
    readonly failingHandler: Record<string, unknown>;
    readonly trigger: (container: HTMLDivElement) => Promise<void>;
  }[] = [
    {
      name: "invite",
      operation: "settings.people.invite",
      principals: [humanPrincipal()],
      invites: noInvites,
      failingHandler: {
        "POST /api/tenants/tnt_1/access-policy/pending-invites": () =>
          json(500, { error: "boom" }),
      },
      trigger: async (container) => {
        const inviteButton = Array.from(
          container.querySelectorAll("button"),
        ).find((b) => b.textContent === "Invite someone");
        act(() =>
          inviteButton?.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          ),
        );
        await settle();
        const emailInput = document.querySelector(
          'input[type="email"]',
        ) as HTMLInputElement;
        act(() => setNativeValue(emailInput, "bob@example.com"));
        await settle();
        const form = document.getElementById(
          "invite-person-form",
        ) as HTMLFormElement;
        act(() => {
          form.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        });
        await settle();
      },
    },
    {
      name: "cancelInvite",
      operation: "settings.people.cancelInvite",
      principals: [humanPrincipal()],
      invites: {
        data: [
          {
            id: "pinv_1",
            tenantId: "tnt_1",
            matchType: "email",
            value: "carol@example.com",
            roleId: "role_member",
            createdAt: timestamps.createdAt,
          },
        ],
      },
      failingHandler: {
        "DELETE /api/tenants/tnt_1/access-policy/pending-invites/pinv_1": () =>
          json(500, { error: "boom" }),
      },
      trigger: async (container) => {
        const cancelButton = Array.from(
          container.querySelectorAll("button"),
        ).find((b) => b.textContent === "Cancel");
        act(() =>
          cancelButton?.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          ),
        );
        await settle();
        const confirmButton = Array.from(
          container.querySelectorAll("button"),
        ).find((b) => b.textContent?.includes("Cancel this invite"));
        act(() =>
          confirmButton?.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          ),
        );
        await settle();
      },
    },
    {
      name: "updateStatus",
      operation: "settings.people.updateStatus",
      principals: [humanPrincipal()],
      invites: noInvites,
      failingHandler: {
        "PATCH /api/tenants/tnt_1/principals/prn_human_1": () =>
          json(500, { error: "boom" }),
      },
      trigger: async (container) => {
        const suspendButton = Array.from(
          container.querySelectorAll("button"),
        ).find((b) => b.textContent === "Suspend");
        act(() =>
          suspendButton?.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          ),
        );
        await settle();
      },
    },
    {
      name: "remove",
      operation: "settings.people.remove",
      principals: [humanPrincipal()],
      invites: noInvites,
      failingHandler: {
        "DELETE /api/tenants/tnt_1/principals/prn_human_1": () =>
          json(500, { error: "boom" }),
      },
      trigger: async (container) => {
        const removeButton = Array.from(
          container.querySelectorAll("button"),
        ).find((b) => b.textContent === "Remove");
        act(() =>
          removeButton?.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          ),
        );
        await settle();
        const confirmButton = Array.from(
          container.querySelectorAll("button"),
        ).find((b) => b.textContent === "Remove for good?");
        act(() =>
          confirmButton?.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          ),
        );
        await settle();
      },
    },
    {
      name: "changeRole",
      operation: "settings.people.changeRole",
      principals: [
        humanPrincipal(),
        humanPrincipal({
          id: "prn_human_2",
          displayName: "Bob Baker",
          refId: "user_2",
          roles: [{ id: MEMBER_ROLE.id, name: MEMBER_ROLE.name }],
        }),
      ],
      invites: noInvites,
      failingHandler: {
        "DELETE /api/tenants/tnt_1/principals/prn_human_2/roles/role_member":
          () => json(500, { error: "boom" }),
      },
      trigger: async (container) => {
        const selects = container.querySelectorAll("tbody select");
        const bobSelect = Array.from(selects).find(
          (s) => (s as HTMLSelectElement).value === "role_member",
        ) as HTMLSelectElement;
        act(() => {
          bobSelect.value = "role_owner";
          bobSelect.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await settle();
      },
    },
  ];

  for (const testCase of REPORT_ERROR_CASES) {
    test(`a failing ${testCase.name} reports the error with its operation and tenant`, async () => {
      const calls: FetchCall[] = [];
      reportErrorCalls.length = 0;
      mockFetch(
        {
          "/api/tenants/tnt_1/principals": {
            data: testCase.principals,
            nextCursor: null,
          },
          "/api/tenants/tnt_1/roles": rolesPage,
          "/api/tenants/tnt_1/access-policy/pending-invites": testCase.invites,
          ...testCase.failingHandler,
        },
        calls,
      );

      const { container, root } = mount();
      try {
        await settle();
        await testCase.trigger(container);

        expect(
          reportErrorCalls.some(
            (call) =>
              call.context.operation === testCase.operation &&
              call.context.tenantId === "tnt_1",
          ),
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    });
  }
});

function actionsCellOpenTag(markup: string): string {
  const heads = [...markup.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)];
  const index = heads.findIndex((match) => /Actions/.test(match[0]));
  if (index === -1) throw new Error("no Actions column");
  const firstRow = /<tbody[\s\S]*?<tr[\s\S]*?<\/tr>/.exec(markup);
  if (firstRow === null) throw new Error("no body row");
  const cells = [...firstRow[0].matchAll(/<td\b[^>]*>/g)];
  const cell = cells[index];
  if (cell === undefined) throw new Error("no Actions td");
  return cell[0];
}

function ruleFor(css: string, className: string): string {
  const selector = new RegExp(`\\.${className}\\s*[,{]`);
  const block = css.split("}").find((candidate) => selector.test(candidate));
  if (block === undefined) throw new Error(`no rule for .${className}`);
  return block.slice(block.indexOf("{"));
}

describe("PeopleTable Actions column", () => {
  test("Actions cells opt out of page-fill nowrap-ellipsis clipping", () => {
    const markup = renderToStaticMarkup(
      <PeopleTable
        people={[humanPrincipal()]}
        roles={[OWNER_ROLE, MEMBER_ROLE]}
        onSuspend={() => undefined}
        onReactivate={() => undefined}
        onRemove={() => undefined}
        onRoleChange={() => undefined}
      />,
    );

    expect(actionsCellOpenTag(markup)).toContain("settings-actions-cell");
    expect(markup).toContain("Remove");

    const css = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    const cell = ruleFor(css, "settings-actions-cell");
    expect(cell).toContain("overflow: visible");
    expect(cell).toContain("min-width");
    expect(cell).not.toContain("text-overflow: ellipsis");
    expect(cell).not.toContain("white-space: nowrap");
    expect(cell).not.toContain("overflow: hidden");

    const actions = ruleFor(css, "settings-row-actions");
    expect(actions).toContain("min-width");
  });
});
