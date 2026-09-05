// The Agents page directory client: model catalog path/shape and failure
// isolation so a broken picker never blanks definitions and instances.

import { afterEach, describe, expect, test } from "bun:test";

import { ApiQueryError } from "@corbits/api-query";

import {
  clearAgentModel,
  draftAgentDefinition,
  getAgentDefinitionBySlug,
  listCatalogModels,
  listRoutineRunFires,
  loadAgentDirectory,
  updateAgentSkills,
} from "../src/agents-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly method: string };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const full =
      typeof input === "string"
        ? input
        : `${new URL(String(input)).pathname}${new URL(String(input)).search}`;
    const path = typeof input === "string" ? input : full;
    calls.push({ path, method: init?.method ?? "GET" });
    // Matchers key on the path-with-query the client builds.
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const modelFixture = {
  id: "mdl_1",
  tenantId: "tnt_1",
  canonicalName: "anthropic/claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  description: null,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const disabledModel = {
  ...modelFixture,
  id: "mdl_2",
  canonicalName: "disabled/model",
  disabled: true,
};

const definitionFixture = {
  id: "wfd_1",
  tenantId: "tnt_1",
  name: "Researcher",
  description: "Answers research questions",
  currentVersion: "1",
  status: "deployed" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const instanceFixture = {
  id: "ins_1",
  definitionId: "wfd_1",
  definitionName: "Researcher",
  tenantId: "tnt_1",
  address: "ins_1@acme.localhost",
  status: "running" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("listCatalogModels", () => {
  test("fetches the paginated catalog models endpoint", async () => {
    const calls = stubFetch((path) => {
      expect(path.startsWith("/api/tenants/tnt_1/catalog/models")).toBe(true);
      return json({ data: [modelFixture, disabledModel], nextCursor: null });
    });

    const models = await listCatalogModels("tnt_1");
    expect(calls[0]?.path).toContain("/api/tenants/tnt_1/catalog/models");
    expect(models).toEqual([modelFixture]);
  });

  test("CL-6744: drops embedding-named, hf.co, and .gguf catalog rows from the picker", async () => {
    const embedding = {
      ...modelFixture,
      id: "mdl_embed",
      canonicalName: "all-minilm",
      displayName: "all-minilm",
    };
    const hfPath = {
      ...modelFixture,
      id: "mdl_hf",
      canonicalName: "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M",
      displayName: "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M",
    };
    const gguf = {
      ...modelFixture,
      id: "mdl_gguf",
      canonicalName: "model.Q4_K_M.gguf",
      displayName: "model.Q4_K_M.gguf",
    };
    stubFetch(() =>
      json({
        data: [modelFixture, embedding, hfPath, gguf, disabledModel],
        nextCursor: null,
      }),
    );

    const models = await listCatalogModels("tnt_1");
    expect(models).toEqual([modelFixture]);
  });

  test("rejects the bare-array discovery shape the wrong endpoint returns", async () => {
    stubFetch(() =>
      json([
        {
          id: "mdl_1",
          canonicalName: "anthropic/claude-sonnet-4",
          offerings: [],
        },
      ]),
    );

    await expect(listCatalogModels("tnt_1")).rejects.toThrow(
      /Unexpected response shape/,
    );
  });
});

describe("loadAgentDirectory", () => {
  test("loads definitions and instances even when the model catalog fails", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [definitionFixture], nextCursor: null });
      }
      if (path.includes("/top-level-runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ error: { message: "catalog down" } }, 503);
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.definitions).toEqual([definitionFixture]);
    expect(directory.instances).toEqual([instanceFixture]);
    expect(directory.models).toEqual([]);
    expect(directory.modelsError).toMatch(/503|catalog/i);
  });

  test("surfaces a definitions failure as a hard error", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ error: { message: "nope" } }, 500);
      }
      if (path.includes("/top-level-runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ data: [modelFixture], nextCursor: null });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    await expect(loadAgentDirectory("tnt_1")).rejects.toThrow(/500/);
  });

  test("returns ready models when the catalog succeeds", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [definitionFixture], nextCursor: null });
      }
      if (path.includes("/top-level-runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ data: [modelFixture], nextCursor: null });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.models).toEqual([modelFixture]);
    expect(directory.modelsError).toBeUndefined();
  });

  test("carries each definition's attached skills", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [definitionFixture], nextCursor: null });
      }
      if (path.includes("/top-level-runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ data: [modelFixture], nextCursor: null });
      }
      if (path.includes("/agent-definitions/skills")) {
        return json({ skills: { wfd_1: ["web-research"] } });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.definitionSkills).toEqual({ wfd_1: ["web-research"] });
    expect(directory.skillsError).toBeUndefined();
  });

  test("CL-6836: a broken skills endpoint keeps the page and surfaces skillsError, never silent empty", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [definitionFixture], nextCursor: null });
      }
      if (path.includes("/top-level-runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ data: [modelFixture], nextCursor: null });
      }
      if (path.includes("/agent-definitions/skills")) {
        return json({ error: { message: "down" } }, 500);
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.definitions).toEqual([definitionFixture]);
    expect(directory.instances).toEqual([instanceFixture]);
    expect(directory.definitionSkills).toEqual({});
    expect(directory.skillsError).toMatch(/500|down/i);
  });

  test("reads instances from the server-scoped top-level-runs endpoint, never /workflows/runs", async () => {
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [definitionFixture], nextCursor: null });
      }
      if (path.includes("/top-level-runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ data: [modelFixture], nextCursor: null });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.instances).toEqual([instanceFixture]);
    expect(calls.some((c) => c.path.includes("/top-level-runs"))).toBe(true);
    expect(calls.some((c) => c.path.includes("/workflows/runs"))).toBe(false);
  });
});

describe("updateAgentSkills", () => {
  test("PUTs the full replacement skill set and returns it back", async () => {
    const calls = stubFetch((path) => {
      expect(path).toBe("/api/tenants/tnt_1/agent-definitions/wfd_1/skills");
      return json({ skills: ["web-research"] });
    });

    const skills = await updateAgentSkills("tnt_1", "wfd_1", ["web-research"]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(skills).toEqual(["web-research"]);
  });
});

describe("getAgentDefinitionBySlug", () => {
  // A slug-addressed page must not depend on the definition being inside
  // the listing's first (and only) page — it asks the server by name.
  test("resolves one definition by name, never through the paginated listing", async () => {
    const calls = stubFetch((path) => {
      expect(path).toBe(
        "/api/tenants/tnt_1/agent-definitions/by-name/triage-bot",
      );
      return json({
        id: "wfd_1",
        tenantId: "tnt_1",
        name: "triage-bot",
        description: "Triage bot",
        currentVersion: "1",
        status: "deployed",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
    });

    const definition = await getAgentDefinitionBySlug("tnt_1", "triage-bot");
    expect(definition.id).toBe("wfd_1");
    expect(calls.every((call) => !call.path.includes("limit="))).toBe(true);
  });
});

describe("listRoutineRunFires", () => {
  test("requests the fires feed of top-level-runs, not the plain feed", async () => {
    const calls = stubFetch(() =>
      json({
        data: [
          {
            ...instanceFixture,
            routineId: "rtn_1",
            routineName: "Weekly digest",
          },
        ],
        nextCursor: null,
      }),
    );

    const fires = await listRoutineRunFires("tnt_1");

    expect(calls[0]?.path).toContain("/api/tenants/tnt_1/top-level-runs");
    expect(calls[0]?.path).toContain("feed=fires");
    expect(fires).toEqual([
      { ...instanceFixture, routineId: "rtn_1", routineName: "Weekly digest" },
    ]);
  });
});

describe("clearAgentModel", () => {
  test("DELETEs the model capability rather than posting an empty name", async () => {
    const calls = stubFetch((path) => {
      expect(path).toBe(
        "/api/tenants/tnt_1/agent-definitions/wfd_1/capabilities/model",
      );
      return json({ skills: [] });
    });

    await clearAgentModel("tnt_1", "wfd_1");
    expect(calls[0]?.method).toBe("DELETE");
  });
});

const DRAFT_FAILED_MESSAGE =
  "Myra couldn't draft a starting prompt for that. Write one yourself, or try again.";

describe("draftAgentDefinition errors", () => {
  test("keeps the envelope userMessage and refId on a 422", async () => {
    stubFetch(() =>
      json(
        {
          error: {
            code: "drafting_failed",
            userMessage: DRAFT_FAILED_MESSAGE,
            refId: "ref_draft_1",
          },
        },
        422,
      ),
    );

    try {
      await draftAgentDefinition("tnt_1", { name: "Research Buddy" });
      throw new Error("expected draftAgentDefinition to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiQueryError);
      const error = err as ApiQueryError;
      expect(error.message).toBe(DRAFT_FAILED_MESSAGE);
      expect(error.refId).toBe("ref_draft_1");
      expect(error.status).toBe(422);
    }
  });

  test("keeps the envelope userMessage and refId on a 500", async () => {
    stubFetch(() =>
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
    );

    try {
      await draftAgentDefinition("tnt_1", { name: "Research Buddy" });
      throw new Error("expected draftAgentDefinition to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiQueryError);
      const error = err as ApiQueryError;
      expect(error.message).toBe("Something went wrong. Please try again.");
      expect(error.refId).toBe("ref_sink_1");
      expect(error.status).toBe(500);
    }
  });

  test("does not treat a legacy {code, message} body as an envelope", async () => {
    stubFetch(() =>
      json(
        {
          error: {
            code: "drafting_failed",
            message:
              "MyraAgentDefinitionDraftingUnavailableError: no myra\n    at draft",
          },
        },
        422,
      ),
    );

    try {
      await draftAgentDefinition("tnt_1", { name: "Research Buddy" });
      throw new Error("expected draftAgentDefinition to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiQueryError);
      const error = err as ApiQueryError;
      expect(error.message).toBe("The server answered 422.");
      expect(error.refId).toBeUndefined();
      expect(error.message).not.toContain("no myra");
    }
  });
});
