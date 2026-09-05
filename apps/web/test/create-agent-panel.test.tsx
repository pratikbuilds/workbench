// DOM-mounted coverage for the shared create-agent panel (CL-6074): the
// happy path is name-only (a purpose is an optional, quiet secondary
// field), Advanced stays collapsed, submitting drafts a system prompt
// via Myra before deploying, a Suggestions card runs the exact same
// drafting flow with its name+purpose prefilled, and a failed draft
// fails closed — the panel surfaces the failure, keeps Advanced
// collapsed, and the disabled primary names the blocker rather than
// silently opening Advanced or falling back to a silent template. Settings' global
// "Agents" directory (this form's original entry point) was cut in
// CL-6121 — agent configuration lives per-workbench now; the chat page's
// "+ New chat" picker moved to instant creation (CL-6081) and no longer
// opens it — see `instant-agent-create.ts`, which reuses this panel's own
// draft-then-create calls instead of duplicating them.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { CreateAgentPanel } from "../src/pages/create-agent-panel";

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CATALOG_MODEL = {
  id: "mdl_1",
  tenantId: "tenant_1",
  canonicalName: "anthropic/claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  description: null,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CREATED_DEFINITION = {
  id: "wfd_new",
  tenantId: "tenant_1",
  name: "Research Buddy",
  description: null,
  currentVersion: "1",
  status: "deployed",
  createdAt: "2026-08-05T11:00:00.000Z",
  updatedAt: "2026-08-05T11:00:00.000Z",
  skills: [],
};

function stubFetch(overrides: {
  draft?: (body: Record<string, unknown>) => Response;
  create?: (body: Record<string, unknown>) => Response;
  models?: readonly unknown[];
}): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      init?.body !== undefined
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
    if (url.includes("/catalog/models")) {
      return Promise.resolve(
        json({ data: overrides.models ?? [], nextCursor: null }),
      );
    }
    if (url.endsWith("/skills")) {
      return Promise.resolve(json({ skills: [] }));
    }
    if (url.includes("/planner/agent-definitions/draft")) {
      return Promise.resolve(
        overrides.draft?.(body) ??
          json({ draft: { systemPrompt: "You help with research." } }, 201),
      );
    }
    if (url.endsWith("/agent-definitions")) {
      return Promise.resolve(
        overrides.create?.(body) ?? json(CREATED_DEFINITION, 201),
      );
    }
    return Promise.resolve(json({}, 200));
  }) as typeof fetch;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  stubFetch({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

async function mount(
  onCreated: (definition: { id: string }) => void = () => {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CreateAgentPanel
        open
        onOpenChange={() => {}}
        tenantId="tenant_1"
        onCreated={onCreated}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function nativeValueSetter(
  proto: HTMLInputElement | HTMLTextAreaElement,
): (this: HTMLInputElement | HTMLTextAreaElement, value: string) => void {
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter === undefined) {
    throw new Error("native value setter unavailable in this DOM");
  }
  return setter;
}

function fillField(id: string, value: string, textarea = false) {
  const el = document.getElementById(id) as
    HTMLInputElement | HTMLTextAreaElement | null;
  expect(el).not.toBeNull();
  if (el === null) return;
  const setter = nativeValueSetter(
    textarea
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
  );
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("CreateAgentPanel happy path", () => {
  test("Advanced is collapsed by default", async () => {
    await mount();
    const details = document.querySelector(
      ".create-agent-advanced",
    ) as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });

  // CL-6745: create-agent dialog is an agent-definition mint, not a
  // workbench mint — title and CTA must use the agent noun.
  test("dialog title and primary CTA use the agent noun, not workbench", async () => {
    await mount();
    const heading = [
      ...document.body.querySelectorAll("h2, [role='heading']"),
    ].find((el) => (el.textContent ?? "").trim() === "New agent");
    expect(heading).toBeDefined();
    expect(document.body.textContent).not.toContain("New workbench");
    fillField("create-agent-name", "Research Buddy");
    const cta = findButton("Get started");
    expect(cta).toBeDefined();
    expect(cta?.textContent).not.toMatch(/workbench/i);
  });

  test("a name alone is enough — purpose is optional, never a gate", async () => {
    await mount();
    const emptyCta = findButton("Add a name to continue.");
    expect(emptyCta?.hasAttribute("disabled")).toBe(true);
    expect(findButton("Get started")).toBeUndefined();

    fillField("create-agent-name", "Research Buddy");
    expect(findButton("Get started")?.hasAttribute("disabled")).toBe(false);
    // No purpose was typed — still enabled, no "describe what it does"
    // requirement anywhere in the disabled-reason copy.
    expect(document.body.textContent).not.toContain(
      "Describe what this agent should do.",
    );
  });

  test("submitting with just a name still runs the drafting flow, then deploys with it", async () => {
    const captured: {
      draftBody: Record<string, unknown> | null;
      createBody: Record<string, unknown> | null;
    } = { draftBody: null, createBody: null };
    stubFetch({
      draft: (body) => {
        captured.draftBody = body;
        return json(
          { draft: { systemPrompt: "You are a friendly, capable assistant." } },
          201,
        );
      },
      create: (body) => {
        captured.createBody = body;
        return json(CREATED_DEFINITION, 201);
      },
    });

    let created: { id: string } | null = null;
    await mount((definition) => {
      created = definition;
    });

    fillField("create-agent-name", "Research Buddy");

    const button = findButton("Get started");
    expect(button?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      button?.click();
    });
    await settle();

    expect(captured.draftBody).toEqual({ name: "Research Buddy" });
    expect(captured.createBody?.systemPrompt).toBe(
      "You are a friendly, capable assistant.",
    );
    expect(captured.createBody?.handle).toBe("research-buddy");
    expect((created as { id: string } | null)?.id).toBe("wfd_new");
  });

  test("a typed purpose rides along in the draft request", async () => {
    const captured: { draftBody: Record<string, unknown> | null } = {
      draftBody: null,
    };
    stubFetch({
      draft: (body) => {
        captured.draftBody = body;
        return json(
          { draft: { systemPrompt: "You help with research." } },
          201,
        );
      },
    });

    await mount();
    fillField("create-agent-name", "Research Buddy");
    fillField("create-agent-purpose", "Helps with research", true);

    await act(async () => {
      findButton("Get started")?.click();
    });
    await settle();

    expect(captured.draftBody).toEqual({
      name: "Research Buddy",
      purpose: "Helps with research",
    });
  });
});

describe("CreateAgentPanel Suggestions", () => {
  test("clicking a suggestion card prefills its name+purpose and runs the same drafting flow", async () => {
    const captured: { draftBody: Record<string, unknown> | null } = {
      draftBody: null,
    };
    stubFetch({
      draft: (body) => {
        captured.draftBody = body;
        return json(
          { draft: { systemPrompt: "You prep a morning digest." } },
          201,
        );
      },
    });

    let created: { id: string } | null = null;
    await mount((definition) => {
      created = definition;
    });

    const card = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Morning Brief"),
    );
    expect(card).toBeDefined();
    await act(async () => {
      card?.click();
    });
    await settle();

    expect(captured.draftBody?.name).toBe("Morning Brief");
    expect(typeof captured.draftBody?.purpose).toBe("string");
    expect((created as { id: string } | null)?.id).toBe("wfd_new");
  });
});

describe("CreateAgentPanel drafting failure — fails closed", () => {
  test("a failed draft keeps Advanced collapsed and names the blocker on the disabled primary", async () => {
    let createCalled = false;
    stubFetch({
      models: [CATALOG_MODEL],
      draft: () =>
        json(
          {
            error: {
              code: "drafting_failed",
              userMessage: "Myra couldn't draft a starting prompt for that.",
              refId: "ref_1",
            },
          },
          422,
        ),
      create: () => {
        createCalled = true;
        return json(CREATED_DEFINITION, 201);
      },
    });

    await mount();
    await settle();
    fillField("create-agent-name", "Research Buddy");

    const button = findButton("Get started");
    await act(async () => {
      button?.click();
    });
    await settle();

    expect(createCalled).toBe(false);
    const details = document.querySelector(
      ".create-agent-advanced",
    ) as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
    expect(document.body.textContent).toContain(
      "Myra couldn't draft a starting prompt for that.",
    );
    expect(document.body.textContent).toContain("Reference: ref_1");
    expect(findButton("Get started")).toBeUndefined();
    const blockedCta = findButton(
      "Open Advanced and write a system prompt to continue.",
    );
    expect(blockedCta).toBeDefined();
    expect(blockedCta?.hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).not.toContain("Myra picks one");
    expect(document.body.textContent).toContain(
      "Left unset, the agent uses the workbench default.",
    );

    const manualField = document.getElementById(
      "create-agent-advanced-manualSystemPrompt",
    );
    expect(manualField).not.toBeNull();

    fillField(
      "create-agent-advanced-manualSystemPrompt",
      "You are Research Buddy. Help with research.",
      true,
    );
    await act(async () => {
      findButton("Get started")?.click();
    });
    await settle();

    expect(createCalled).toBe(true);
  });

  test("a 500 envelope shows the consumer sentence plus Reference, not a dead-end", async () => {
    stubFetch({
      draft: () =>
        json(
          {
            error: {
              code: "internal_error",
              userMessage: "Something went wrong. Please try again.",
              refId: "ref_sink_1",
            },
          },
          500,
        ),
    });

    await mount();
    fillField("create-agent-name", "Research Buddy");
    await act(async () => {
      findButton("Get started")?.click();
    });
    await settle();

    expect(document.body.textContent).toContain(
      "Something went wrong. Please try again.",
    );
    expect(document.body.textContent).toContain("Reference: ref_sink_1");
    expect(document.body.textContent).not.toContain("The server answered 500.");
    expect(document.body.textContent).not.toContain("at draft");
    const details = document.querySelector(
      ".create-agent-advanced",
    ) as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
  });
});

describe("agent creation entry points", () => {
  test("the chat page never imports this form — agent creation lives outside it entirely (CL-6138)", () => {
    const chatPageSource = readFileSync(
      new URL("../src/pages/chat-page.tsx", import.meta.url),
      "utf8",
    );
    expect(chatPageSource).not.toContain('from "./create-agent-panel"');
    expect(chatPageSource).not.toContain("instant-agent-create");
  });

  test("the command palette's new-workbench opens the template picker, not an instant mint (CL-6342)", () => {
    const commandPaletteActionsSource = readFileSync(
      new URL("../src/command-palette-actions.ts", import.meta.url),
      "utf8",
    );
    expect(commandPaletteActionsSource).not.toContain("instant-agent-create");
    expect(commandPaletteActionsSource).toContain('from "./routes"');
  });

  test("the template picker mints through instant-agent-create.ts's createWorkbenchFromTemplate", () => {
    const pickerSource = readFileSync(
      new URL("../src/pages/new-workbench-picker.tsx", import.meta.url),
      "utf8",
    );
    expect(pickerSource).toContain('from "../instant-agent-create"');
    expect(pickerSource).toContain("createWorkbenchFromTemplate");
  });
});
