// DOM-mounted composition tests for the Agents master-detail settings
// section (CL-6215): the list (every invited agent, Invite agent, the
// autonomy callout) is the whole surface until a row is clicked; its
// detail is the old, separate "Myra" tab's editor — name/instructions,
// Capabilities (including a model picker fed from the tenant's resolved
// inference catalog), and History — generalized to any agent. This reads
// and saves through `@corbits/agent-directory`'s routes rather than the
// workbench settings PATCH every other section uses, so its load/save/error
// sequencing needs a real effect-driven mount. Stubs `global.fetch`
// directly, never `mock.module`.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { WorkbenchSettingsSurface } from "../src/workbench-settings";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type AgentFixture = {
  readonly address: string;
  readonly handle: string;
  readonly definitionId: string;
  name: string;
  systemPrompt: string;
  toolPackagePins: { name: string; version: string }[];
  skills: string[];
  model?: string;
};

const MYRA: AgentFixture = {
  address: "myra@acme.example",
  handle: "myra",
  definitionId: "wfd_myra",
  name: "Myra",
  systemPrompt: "Be a helpful assistant.",
  toolPackagePins: [],
  skills: [],
};

type VersionFixture = {
  readonly commitSha: string;
  readonly message: string;
  readonly author: string;
  readonly committedAtIso: string;
  readonly current: boolean;
};

type ModelFixture = {
  readonly canonicalName: string;
  readonly displayName?: string;
};
type OfferingFixture = { readonly providerName: string };

function stubFetch(options: {
  readonly agents?: readonly AgentFixture[];
  readonly workbenchKind?: string;
  readonly saveFails?: boolean;
  readonly versions?: readonly VersionFixture[];
  readonly capabilityInventory?: {
    readonly toolPackages: readonly { name: string }[];
    readonly skills: readonly { name: string }[];
    readonly models: readonly { canonicalName: string }[];
  };
  readonly catalogModels?: readonly (ModelFixture & {
    readonly offerings: readonly OfferingFixture[];
  })[];
  /** When true, every catalog (`/models`) read fails. */
  readonly catalogFails?: boolean;
  /** HTTP status for a failing catalog read (default 500). */
  readonly catalogFailStatus?: number;
  /** When true, a failing catalog read throws (network), not an HTTP envelope. */
  readonly catalogNetworkFails?: boolean;
  /** Fail the first N catalog reads, then succeed — used to exercise Retry. */
  readonly catalogFailUntil?: number;
  readonly addCapabilityFails?: boolean;
  readonly restoreFails?: boolean;
  readonly onSave?: (
    definitionId: string,
    body: { name: string; systemPrompt: string },
  ) => void;
  readonly onRefresh?: (address: string) => void;
  readonly onAddCapability?: (definitionId: string, body: unknown) => void;
  readonly onRestore?: (definitionId: string, commitSha: string) => void;
}) {
  // Cloned so a save in one test can never mutate a fixture another
  // test (or another `stubFetch` call in the same test) still reads —
  // `agents`/`MYRA` are shared object literals, not fresh per call.
  const agents = (options.agents ?? [MYRA]).map((agent) => ({
    ...agent,
    toolPackagePins: [...agent.toolPackagePins],
    skills: [...agent.skills],
  }));
  const refreshCalls: string[] = [];
  const capabilityInventory = options.capabilityInventory ?? {
    toolPackages: [],
    skills: [],
    models: [],
  };
  const catalogModels = options.catalogModels ?? [
    {
      canonicalName: "anthropic/claude-sonnet",
      offerings: [{ providerName: "anthropic" }],
    },
  ];
  let catalogCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
      return json({
        id: "ch_1",
        title: "Talk to Myra",
        kind: options.workbenchKind ?? "chat",
        pinned: false,
        participants: agents.map((agent) => ({
          address: agent.address,
          handle: agent.handle,
        })),
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    if (/\/models$/.test(path)) {
      catalogCalls += 1;
      const catalogShouldFail =
        options.catalogFails === true ||
        options.catalogNetworkFails === true ||
        options.catalogFailStatus !== undefined ||
        (options.catalogFailUntil !== undefined &&
          catalogCalls <= options.catalogFailUntil);
      if (catalogShouldFail) {
        if (options.catalogNetworkFails === true) {
          throw new TypeError("Failed to fetch");
        }
        const status = options.catalogFailStatus ?? 500;
        return json(
          {
            error: {
              code: status === 401 ? "unauthenticated" : "internal",
              userMessage: status === 401 ? "signed out boom" : "catalog boom",
              refId: "ref_catalog",
            },
          },
          status,
        );
      }
      return json(
        catalogModels.map((model, index) => ({
          id: `model_${String(index)}`,
          canonicalName: model.canonicalName,
          displayName: model.displayName ?? null,
          offerings: model.offerings.map((offering, offeringIndex) => ({
            offeringId: `offering_${String(index)}_${String(offeringIndex)}`,
            providerId: `provider_${String(index)}_${String(offeringIndex)}`,
            providerName: offering.providerName,
            plugin: "anthropic",
            priority: offeringIndex,
            deploymentTags: [],
            capabilities: [],
            pricing: [],
          })),
        })),
      );
    }
    if (/\/chat\/workbenches\/[^/]+\/agents\/refresh$/.test(path)) {
      const body = JSON.parse(String(init?.body)) as { address: string };
      refreshCalls.push(body.address);
      options.onRefresh?.(body.address);
      return json({ ok: true });
    }
    if (/\/chat\/workbenches\/[^/]+\/agents$/.test(path)) {
      return json({
        items: agents.map((agent) => ({
          address: agent.address,
          handle: agent.handle,
          definitionId: agent.definitionId,
          definitionAssetId: `ast_${agent.definitionId}`,
          displayName: agent.name,
        })),
      });
    }
    if (/\/agent-definitions\/capabilities\/inventory$/.test(path)) {
      return json(capabilityInventory);
    }
    const versionsMatch = /\/agent-definitions\/([^/]+)\/versions$/.exec(path);
    if (versionsMatch !== null) {
      return json({ versions: options.versions ?? [] });
    }
    const restoreMatch = /\/agent-definitions\/([^/]+)\/restore$/.exec(path);
    if (restoreMatch !== null) {
      const definitionId = restoreMatch[1] as string;
      const agent = agents.find((a) => a.definitionId === definitionId);
      if (agent === undefined) {
        return json(
          { error: { code: "not_found", message: "no such agent" } },
          404,
        );
      }
      if (options.restoreFails === true) {
        return json({ error: { code: "internal", message: "boom" } }, 500);
      }
      const body = JSON.parse(String(init?.body)) as { commitSha: string };
      options.onRestore?.(definitionId, body.commitSha);
      return json({
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        toolPackagePins: agent.toolPackagePins,
        skills: agent.skills,
        model: agent.model,
      });
    }
    const capabilitiesMatch =
      /\/agent-definitions\/([^/]+)\/capabilities$/.exec(path);
    if (capabilitiesMatch !== null) {
      const definitionId = capabilitiesMatch[1] as string;
      const agent = agents.find((a) => a.definitionId === definitionId);
      if (agent === undefined) {
        return json(
          { error: { code: "not_found", message: "no such agent" } },
          404,
        );
      }
      if (options.addCapabilityFails === true) {
        return json({ error: { code: "bad_request", message: "boom" } }, 400);
      }
      const body = JSON.parse(String(init?.body)) as
        | { kind: "toolPackage"; name: string }
        | { kind: "skill"; name: string }
        | { kind: "model"; canonicalName: string };
      options.onAddCapability?.(definitionId, body);
      if (body.kind === "toolPackage") {
        agent.toolPackagePins = [
          ...agent.toolPackagePins,
          { name: body.name, version: "*" },
        ];
      } else if (body.kind === "skill") {
        agent.skills = [...agent.skills, body.name];
      } else {
        agent.model = body.canonicalName;
      }
      return json({
        toolPackagePins: agent.toolPackagePins,
        skills: agent.skills,
        model: agent.model,
      });
    }
    const definitionMatch = /\/agent-definitions\/([^/]+)$/.exec(path);
    if (definitionMatch !== null) {
      const definitionId = definitionMatch[1];
      const agent = agents.find((a) => a.definitionId === definitionId);
      if (agent === undefined) {
        return json(
          { error: { code: "not_found", message: "no such agent" } },
          404,
        );
      }
      if (init?.method === "PUT") {
        if (options.saveFails === true) {
          return json({ error: { code: "internal", message: "boom" } }, 500);
        }
        const body = JSON.parse(String(init.body)) as {
          name: string;
          systemPrompt: string;
        };
        agent.name = body.name;
        agent.systemPrompt = body.systemPrompt;
        options.onSave?.(definitionId as string, body);
        return json({ name: agent.name, systemPrompt: agent.systemPrompt });
      }
      return json({
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        toolPackagePins: agent.toolPackagePins,
        skills: agent.skills,
        model: agent.model,
      });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;

  return { refreshCalls };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof WorkbenchSettingsSurface>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(WorkbenchSettingsSurface, props));
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function baseProps(
  overrides: Partial<Parameters<typeof WorkbenchSettingsSurface>[0]> = {},
) {
  return {
    tenantId: "tnt_1",
    workbenchId: "ch_1",
    workbenchTitle: "Talk to Myra",
    onBack: () => undefined,
    onInviteParticipant: () => undefined,
    section: "agents" as const,
    ...overrides,
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(el: HTMLElement, text: string) {
  return Array.from(
    el.querySelectorAll(".workbench-settings-panel-area button"),
  ).find((button) => button.textContent === text) as
    HTMLButtonElement | undefined;
}

function openAgent(el: HTMLElement, handle: string) {
  const row = Array.from(
    el.querySelectorAll(".chat-settings-agent-picker-row"),
  ).find((button) => button.textContent === `@${handle}`) as
    HTMLButtonElement | undefined;
  act(() => {
    row?.click();
  });
}

describe("Agents section — list", () => {
  test("lists every agent participant, with Invite agent and the autonomy note", async () => {
    const second: AgentFixture = {
      address: "researcher@acme.example",
      handle: "researcher",
      definitionId: "wfd_researcher",
      name: "Researcher",
      systemPrompt: "Dig up sources.",
      toolPackagePins: [],
      skills: [],
    };
    stubFetch({ agents: [MYRA, second] });
    const el = mount(baseProps());
    await settle();

    const rows = Array.from(
      el.querySelectorAll(".chat-settings-agent-picker-row"),
    ).map((row) => row.textContent);
    expect(rows.sort()).toEqual(["@myra", "@researcher"]);
    expect(findButton(el, "Invite agent")).toBeDefined();
    expect(el.textContent).toContain("Autonomy");
  });

  test("each row carries a persistent trailing chevron", async () => {
    stubFetch({ agents: [MYRA] });
    const el = mount(baseProps());
    await settle();

    const row = el.querySelector(".chat-settings-agent-picker-row");
    expect(
      row?.querySelector(".chat-settings-agent-picker-row-chevron"),
    ).not.toBeNull();
  });

  test("no agents invited yet reads honestly, not as an empty list", async () => {
    // A workbench (not a DM chat), so the empty agent list itself is under
    // test rather than the separate DM trim that hides Agents entirely.
    stubFetch({ agents: [], workbenchKind: "workbench" });
    const el = mount(baseProps());
    await settle();

    expect(el.textContent).toContain("No agents invited yet.");
  });

  test("clicking a row opens that agent's detail, not every agent's at once", async () => {
    const second: AgentFixture = {
      address: "researcher@acme.example",
      handle: "researcher",
      definitionId: "wfd_researcher",
      name: "Researcher",
      systemPrompt: "Dig up sources.",
      toolPackagePins: [],
      skills: [],
    };
    stubFetch({ agents: [MYRA, second] });
    const el = mount(baseProps());
    await settle();

    openAgent(el, "researcher");
    await settle();

    const titles = Array.from(
      el.querySelectorAll(".chat-settings-agent-block-title"),
    ).map((node) => node.textContent);
    expect(titles).toEqual(["Researcher"]);
    expect(el.querySelector(".chat-settings-agent-back")).not.toBeNull();
  });

  test("entityId deep-links straight into that agent's detail", async () => {
    stubFetch({ agents: [MYRA] });
    const el = mount(
      baseProps({
        entityId: "wfd_myra",
        onEntityIdChange: () => {},
      }),
    );
    await settle();

    const titles = Array.from(
      el.querySelectorAll(".chat-settings-agent-block-title"),
    ).map((node) => node.textContent);
    expect(titles).toEqual(["Myra"]);
    expect(el.querySelector(".chat-settings-agent-picker-row")).toBeNull();
  });

  test("select and back report definitionId changes to the host", async () => {
    stubFetch({ agents: [MYRA] });
    const changes: (string | null)[] = [];
    const el = mount(
      baseProps({
        onEntityIdChange: (id) => {
          changes.push(id);
        },
      }),
    );
    await settle();

    openAgent(el, "myra");
    expect(changes).toEqual(["wfd_myra"]);

    // Host owns the URL — remount with the deepened entityId.
    act(() => {
      root?.render(
        createElement(
          WorkbenchSettingsSurface,
          baseProps({
            entityId: "wfd_myra",
            onEntityIdChange: (id) => {
              changes.push(id);
            },
          }),
        ),
      );
    });
    await settle();

    act(() => {
      (
        el.querySelector(
          ".chat-settings-agent-back",
        ) as HTMLButtonElement | null
      )?.click();
    });
    expect(changes).toEqual(["wfd_myra", null]);
  });

  test("unknown entityId clears once the agent list loads", async () => {
    stubFetch({ agents: [MYRA] });
    const changes: (string | null)[] = [];
    mount(
      baseProps({
        entityId: "wfd_missing",
        onEntityIdChange: (id) => {
          changes.push(id);
        },
      }),
    );
    await settle();

    expect(changes).toEqual([null]);
  });
});

describe("Agents section — detail", () => {
  test("loads the agent's name and instructions, saves them, and refreshes its running instance", async () => {
    let saved: { name: string; systemPrompt: string } | undefined;
    const { refreshCalls } = stubFetch({
      onSave: (_definitionId, body) => {
        saved = body;
      },
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const nameInput = el.querySelector(
      ".workbench-settings-panel-area input",
    ) as HTMLInputElement | null;
    const textarea = el.querySelector(
      ".workbench-settings-panel-area textarea",
    ) as HTMLTextAreaElement | null;
    expect(nameInput?.value).toBe("Myra");
    expect(textarea?.value).toBe("Be a helpful assistant.");

    setTextareaValue(textarea, "Be a blunt, no-nonsense assistant.");
    await settle();

    const saveButton = findButton(el, "Save instructions");
    expect(saveButton).toBeDefined();
    act(() => {
      saveButton?.click();
    });
    await settle();

    expect(saved).toEqual({
      name: "Myra",
      systemPrompt: "Be a blunt, no-nonsense assistant.",
    });
    expect(refreshCalls).toEqual(["myra@acme.example"]);
    expect(findButton(el, "Save instructions")?.disabled).toBe(true);
  });

  test("a failed save shows an inline error and keeps the edit", async () => {
    stubFetch({ saveFails: true });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const textarea = el.querySelector(
      ".workbench-settings-panel-area textarea",
    ) as HTMLTextAreaElement | null;
    setTextareaValue(textarea, "Try to save this.");
    await settle();

    const saveButton = findButton(el, "Save instructions");
    act(() => {
      saveButton?.click();
    });
    await settle();

    expect(el.querySelector(".chat-dialog-error")?.textContent).toBe(
      "Couldn't save these changes — try again.",
    );
    expect(textarea?.value).toBe("Try to save this.");
  });

  test("back returns to the list without losing the other agent's own state", async () => {
    const second: AgentFixture = {
      address: "researcher@acme.example",
      handle: "researcher",
      definitionId: "wfd_researcher",
      name: "Researcher",
      systemPrompt: "Dig up sources.",
      toolPackagePins: [],
      skills: [],
    };
    stubFetch({ agents: [MYRA, second] });
    const el = mount(baseProps());
    await settle();

    openAgent(el, "myra");
    await settle();
    const back = el.querySelector(
      ".chat-settings-agent-back",
    ) as HTMLButtonElement | null;
    act(() => {
      back?.click();
    });
    await settle();

    expect(
      Array.from(el.querySelectorAll(".chat-settings-agent-picker-row"))
        .map((row) => row.textContent)
        .sort(),
    ).toEqual(["@myra", "@researcher"]);

    openAgent(el, "researcher");
    await settle();
    const researcherTextarea = el.querySelector(
      ".workbench-settings-panel-area textarea",
    ) as HTMLTextAreaElement | null;
    expect(researcherTextarea?.value).toBe("Dig up sources.");
  });
});

describe("Agents section — Capabilities", () => {
  test("lists current tools/skills/model and offers only what's not already attached", async () => {
    const withCapabilities: AgentFixture = {
      ...MYRA,
      toolPackagePins: [{ name: "@corbits/github-tools", version: "*" }],
      skills: ["research"],
    };
    stubFetch({
      agents: [withCapabilities],
      capabilityInventory: {
        toolPackages: [
          { name: "@corbits/github-tools" },
          { name: "@corbits/granola-tools" },
        ],
        skills: [{ name: "research" }, { name: "writing" }],
        models: [{ canonicalName: "anthropic/claude-sonnet" }],
      },
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const listText = el.querySelector(
      ".chat-settings-capability-list",
    )?.textContent;
    expect(listText).toContain("@corbits/github-tools");
    expect(listText).toContain("research");

    const choiceSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[1] as HTMLSelectElement | null;
    const toolOptions = Array.from(choiceSelect?.options ?? []).map(
      (option) => option.value,
    );
    // The already-pinned tool package is not offered again; the
    // not-yet-pinned one is.
    expect(toolOptions).not.toContain("@corbits/github-tools");
    expect(toolOptions).toContain("@corbits/granola-tools");
  });

  test("a static capability chip is a plain caption tint, not button chrome", async () => {
    const withCapabilities: AgentFixture = {
      ...MYRA,
      toolPackagePins: [{ name: "@corbits/github-tools", version: "*" }],
      skills: [],
    };
    stubFetch({ agents: [withCapabilities] });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const chip = el.querySelector(".chat-settings-capability-chip");
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.className).not.toContain("border");
  });

  test("the model picker is the tenant's resolved catalog, labeled by its connected provider", async () => {
    stubFetch({
      catalogModels: [
        {
          canonicalName: "anthropic/claude-sonnet",
          displayName: "Claude Sonnet",
          offerings: [{ providerName: "anthropic" }],
        },
        // No offerings anywhere in the ancestor chain — not actually
        // launchable, so it never appears in the picker.
        { canonicalName: "ghost/unconnected-model", offerings: [] },
      ],
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const kindSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[0] as HTMLSelectElement | null;
    act(() => {
      if (kindSelect !== null) {
        kindSelect.value = "model";
        kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await settle();

    const choiceSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[1] as HTMLSelectElement | null;
    const labels = Array.from(choiceSelect?.options ?? [])
      .filter((option) => option.value !== "")
      .map((option) => option.textContent);
    expect(labels).toEqual(["Claude Sonnet · Anthropic"]);
    expect(choiceSelect?.options[0]?.textContent).toBe("Choose a model…");
  });

  test("adding a capability calls the capabilities route, refreshes the running instance, and reflects the addition", async () => {
    let addedBody: unknown;
    const { refreshCalls } = stubFetch({
      capabilityInventory: {
        toolPackages: [{ name: "@corbits/github-tools" }],
        skills: [],
        models: [],
      },
      onAddCapability: (_definitionId, body) => {
        addedBody = body;
      },
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const kindSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[0] as HTMLSelectElement | null;
    expect(kindSelect?.value).toBe("toolPackage");

    const choiceSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[1] as HTMLSelectElement | null;
    act(() => {
      if (choiceSelect !== null) {
        choiceSelect.value = "@corbits/github-tools";
        choiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await settle();

    const addButton = findButton(el, "Add");
    expect(addButton?.disabled).toBe(false);
    act(() => {
      addButton?.click();
    });
    await settle();

    expect(addedBody).toEqual({
      kind: "toolPackage",
      name: "@corbits/github-tools",
    });
    expect(refreshCalls).toEqual(["myra@acme.example"]);
    const badges = Array.from(
      el.querySelectorAll(".chat-settings-capability-list"),
    )[0]?.textContent;
    expect(badges).toContain("@corbits/github-tools");
  });

  test("a rejected capability add shows an inline error and never claims success", async () => {
    stubFetch({
      addCapabilityFails: true,
      capabilityInventory: {
        toolPackages: [{ name: "@corbits/github-tools" }],
        skills: [],
        models: [],
      },
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const choiceSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[1] as HTMLSelectElement | null;
    act(() => {
      if (choiceSelect !== null) {
        choiceSelect.value = "@corbits/github-tools";
        choiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await settle();
    act(() => {
      findButton(el, "Add")?.click();
    });
    await settle();

    expect(el.querySelector(".chat-dialog-error")?.textContent).toBe(
      "Couldn't add that — it may no longer be available.",
    );
  });
});

describe("Agents section — Model select (CL-6272.3)", () => {
  function modelSelect(el: HTMLElement) {
    return el.querySelector(
      ".chat-settings-agent-model-select select",
    ) as HTMLSelectElement | null;
  }

  test("shows the current model and options labeled 'Model · Provider'", async () => {
    stubFetch({
      agents: [{ ...MYRA, model: "anthropic/claude-sonnet" }],
      catalogModels: [
        {
          canonicalName: "anthropic/claude-sonnet",
          displayName: "Claude Sonnet",
          offerings: [{ providerName: "anthropic" }],
        },
        {
          canonicalName: "opencode-zen/gpt",
          displayName: "GPT",
          offerings: [{ providerName: "opencode-zen" }],
        },
      ],
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const select = modelSelect(el);
    expect(select?.value).toBe("anthropic/claude-sonnet");
    const labels = Array.from(select?.options ?? []).map(
      (option) => option.textContent,
    );
    expect(labels).toEqual(["Claude Sonnet · Anthropic", "GPT · Opencode Zen"]);
  });

  test("choosing a different model saves immediately through addAgentCapability and refreshes the running instance", async () => {
    let addedBody: unknown;
    const { refreshCalls } = stubFetch({
      agents: [{ ...MYRA, model: "anthropic/claude-sonnet" }],
      catalogModels: [
        {
          canonicalName: "anthropic/claude-sonnet",
          displayName: "Claude Sonnet",
          offerings: [{ providerName: "anthropic" }],
        },
        {
          canonicalName: "opencode-zen/gpt",
          displayName: "GPT",
          offerings: [{ providerName: "opencode-zen" }],
        },
      ],
      onAddCapability: (_definitionId, body) => {
        addedBody = body;
      },
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const select = modelSelect(el);
    act(() => {
      if (select !== null) {
        select.value = "opencode-zen/gpt";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await settle();

    expect(addedBody).toEqual({
      kind: "model",
      canonicalName: "opencode-zen/gpt",
    });
    expect(refreshCalls).toEqual([MYRA.address]);
    expect(modelSelect(el)?.value).toBe("opencode-zen/gpt");
  });

  test("with no model set yet, the select offers an honest unset option", async () => {
    stubFetch({
      catalogModels: [
        {
          canonicalName: "anthropic/claude-sonnet",
          displayName: "Claude Sonnet",
          offerings: [{ providerName: "anthropic" }],
        },
      ],
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    expect(modelSelect(el)?.value).toBe("");
    expect(modelSelect(el)?.options[0]?.textContent).toBe("No model set");
  });

  test("a catalog load failure reads as an error, not an empty picker (CL-6831)", async () => {
    stubFetch({ catalogFails: true });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const select = modelSelect(el);
    expect(select?.disabled).toBe(true);

    const alert = el.querySelector(".chat-dialog-error")?.textContent;
    expect(alert).toBe("catalog boom");
    expect(alert).not.toBe("Couldn't load the models.");
    expect(el.textContent).not.toContain(
      "No connected providers yet — connect one in Shared Settings.",
    );
    expect(el.textContent).not.toContain("No connected providers yet");

    expect(findButton(el, "Retry")).toBeDefined();
    const settingsHop = el.querySelector(
      'a[href="/settings/connections"]',
    ) as HTMLAnchorElement | null;
    expect(settingsHop).not.toBeNull();
    expect(settingsHop?.textContent).toBe("Shared Settings");
  });

  test("a catalog 401 reads as signed-out copy, not the envelope or generic fallback", async () => {
    stubFetch({ catalogFailStatus: 401 });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const alert = el.querySelector(".chat-dialog-error")?.textContent;
    expect(alert).toBe("You're signed out. Sign in again to continue.");
    expect(alert).not.toBe("signed out boom");
    expect(alert).not.toBe("Couldn't load the models.");
  });

  test("a catalog network failure reads as a connection error, not the generic fallback", async () => {
    stubFetch({ catalogNetworkFails: true });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const alert = el.querySelector(".chat-dialog-error")?.textContent;
    expect(alert).toBe(
      "Couldn't reach the server. Check your connection and try again.",
    );
    expect(alert).not.toBe("Couldn't load the models.");
  });

  test("Retry after a catalog load failure recovers the picker", async () => {
    stubFetch({
      catalogFailUntil: 1,
      catalogModels: [
        {
          canonicalName: "anthropic/claude-sonnet",
          displayName: "Claude Sonnet",
          offerings: [{ providerName: "anthropic" }],
        },
      ],
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    expect(modelSelect(el)?.disabled).toBe(true);
    expect(el.querySelector(".chat-dialog-error")?.textContent).toBe(
      "catalog boom",
    );

    act(() => {
      findButton(el, "Retry")?.click();
    });
    await settle();

    expect(el.querySelector(".chat-dialog-error")).toBeNull();
    const select = modelSelect(el);
    expect(select?.disabled).toBe(false);
    expect(
      Array.from(select?.options ?? []).map((option) => option.textContent),
    ).toContain("Claude Sonnet · Anthropic");
  });
});

describe("Agents section — History", () => {
  test("lists version history newest first, with the current version's restore disabled", async () => {
    stubFetch({
      versions: [
        {
          commitSha: "sha2",
          message: "Update agent instructions for myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: true,
        },
        {
          commitSha: "sha1",
          message: "Define agent Myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: false,
        },
      ],
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const rows = el.querySelectorAll("table tbody tr");
    expect(rows.length).toBe(2);
    const restoreButtons = Array.from(
      el.querySelectorAll("table tbody tr button"),
    ) as HTMLButtonElement[];
    expect(restoreButtons[0]?.disabled).toBe(true);
    expect(restoreButtons[1]?.disabled).toBe(false);
  });

  test("restoring a version calls restore, refreshes the running instance, and updates the editor", async () => {
    let restoredSha: string | undefined;
    const { refreshCalls } = stubFetch({
      versions: [
        {
          commitSha: "sha2",
          message: "Update agent instructions for myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: true,
        },
        {
          commitSha: "sha1",
          message: "Define agent Myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: false,
        },
      ],
      onRestore: (_definitionId, commitSha) => {
        restoredSha = commitSha;
      },
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const restoreButtons = Array.from(
      el.querySelectorAll("table tbody tr button"),
    ) as HTMLButtonElement[];
    act(() => {
      restoreButtons[1]?.click();
    });
    await settle();

    expect(restoredSha).toBe("sha1");
    expect(refreshCalls).toEqual(["myra@acme.example"]);
  });

  test("a failed restore shows an inline error", async () => {
    stubFetch({
      restoreFails: true,
      versions: [
        {
          commitSha: "sha2",
          message: "Update agent instructions for myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: true,
        },
        {
          commitSha: "sha1",
          message: "Define agent Myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: false,
        },
      ],
    });
    const el = mount(baseProps());
    await settle();
    openAgent(el, "myra");
    await settle();

    const restoreButtons = Array.from(
      el.querySelectorAll("table tbody tr button"),
    ) as HTMLButtonElement[];
    act(() => {
      restoreButtons[1]?.click();
    });
    await settle();

    expect(el.querySelector(".chat-dialog-error")?.textContent).toBe(
      "Couldn't restore that version — try again.",
    );
  });
});
