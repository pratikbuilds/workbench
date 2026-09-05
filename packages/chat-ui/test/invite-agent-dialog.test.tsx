// CL-6499: Jimmy is no longer seeded through a workbench template — his
// only create path left is this dialog's own "Add Jimmy" quick-create
// row (see `quickCreateJimmy` in `../src/api`). This proves the row
// appears only when Jimmy is genuinely absent from the tenant's
// invitable list, and that clicking it creates him and then invites him
// into the current workbench through the same `onInvite` seam every
// other row uses.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { InviteAgentDialog } from "../src/invite-agent-dialog";
import { JIMMY_QUICK_CREATE } from "../src/api";

const realFetch = globalThis.fetch;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(routes: {
  invitable: () => readonly {
    id: string;
    name: string;
    description?: string;
  }[];
  createJimmy?: () => { id: string };
}) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    if (path.endsWith("/invitable")) {
      return Promise.resolve(jsonResponse({ items: routes.invitable() }));
    }
    if (init?.method === "POST" && path.endsWith("/agent-definitions")) {
      const created = routes.createJimmy?.() ?? { id: "wfd_jimmy" };
      return Promise.resolve(jsonResponse(created, 201));
    }
    throw new Error(`unstubbed fetch: ${String(init?.method)} ${path}`);
  }) as typeof fetch;
}

async function mount(props: {
  readonly invitable: () => readonly {
    id: string;
    name: string;
    description?: string;
  }[];
  readonly onInvite: (definitionId: string) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}) {
  stubFetch({ invitable: props.invitable });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <InviteAgentDialog
        open={true}
        onOpenChange={props.onOpenChange}
        tenantId="tnt_1"
        workbenchId="wb_1"
        onInvite={props.onInvite}
      />,
    );
  });
  // Flush the effect's `listInvitableDefinitions` promise.
  await act(async () => {
    await Promise.resolve();
  });
  // `Dialog` portals its content to `document.body`, not into `container`.
  return document.body;
}

describe("InviteAgentDialog's Jimmy quick-create row", () => {
  test("appears when the tenant's invitable list has no Jimmy yet", async () => {
    const el = await mount({
      invitable: () => [{ id: "wfd_echo", name: "echo" }],
      onInvite: async () => undefined,
      onOpenChange: () => undefined,
    });
    const row = el.querySelector('[data-testid="quick-create-jimmy"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain(JIMMY_QUICK_CREATE.description);
  });

  // CL-6649: the row used to render only `JIMMY_QUICK_CREATE.description`
  // ("Searches Giphy and replies with a GIF") — Jimmy's own name never
  // appeared at all. The name must lead, with the description as a
  // secondary line and a first-party attribution alongside the name.
  test("renders Jimmy's name prominently, attributed to Corbits, with the description as a secondary line", async () => {
    const el = await mount({
      invitable: () => [{ id: "wfd_echo", name: "echo" }],
      onInvite: async () => undefined,
      onOpenChange: () => undefined,
    });
    const row = el.querySelector('[data-testid="quick-create-jimmy"]');
    const name = row?.querySelector(".chat-invitable-item-name");
    const description = row?.querySelector(".chat-invitable-item-description");
    expect(name?.textContent).toContain(JIMMY_QUICK_CREATE.name);
    expect(name?.textContent).toContain("by Corbits");
    expect(description?.textContent).toBe(JIMMY_QUICK_CREATE.description);
  });

  test("is absent once the tenant's invitable list already includes Jimmy", async () => {
    const el = await mount({
      invitable: () => [{ id: "wfd_jimmy", name: JIMMY_QUICK_CREATE.handle }],
      onInvite: async () => undefined,
      onOpenChange: () => undefined,
    });
    expect(el.querySelector('[data-testid="quick-create-jimmy"]')).toBeNull();
  });

  test("clicking Add creates Jimmy and invites the created definition", async () => {
    const invited: string[] = [];
    let closed = false;
    const el = await mount({
      invitable: () => [],
      onInvite: async (definitionId) => {
        invited.push(definitionId);
      },
      onOpenChange: (open) => {
        if (!open) closed = true;
      },
    });

    const button = el.querySelector(
      '[data-testid="quick-create-jimmy"] button',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invited).toEqual(["wfd_jimmy"]);
    expect(closed).toBe(true);
  });
});

describe("InviteAgentDialog definition rows (CL-6424)", () => {
  test("shows each definition's display name, never its raw slug", async () => {
    const el = await mount({
      invitable: () => [
        { id: "wfd_myra", name: "myra", description: "Myra" },
        { id: "wfd_review", name: "code-review" },
        { id: "wfd_jimmy", name: JIMMY_QUICK_CREATE.handle },
      ],
      onInvite: async () => undefined,
      onOpenChange: () => undefined,
    });
    const names = Array.from(
      el.querySelectorAll(
        '[data-testid="invitable-definition"] .chat-invitable-item-name',
      ),
    ).map((name) => name.textContent);
    expect(names).toEqual(["Myra", "Code Review", "Jimmy"]);
  });
});
