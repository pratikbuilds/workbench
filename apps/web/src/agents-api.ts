// The Agents page's one seam to the hub: agent definitions (templates
// an agent can be launched from), their deployed instances, and the
// tenant's model catalog — each fetched with the platform's own wire
// schemas, validated at the boundary exactly like every other query in
// `./api.ts`. Kept separate from that file because these three
// endpoints are tenant-scoped (the path needs a resolved `tenantId`
// before it can even be built), unlike the fixed `/api/me/...` paths
// `useAPIQuery` there is built around.

import {
  ModelResponse,
  WorkflowDefinitionResponse,
  WorkflowRunResponse,
  paginatedSchema,
} from "@intx/types";
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useQuery } from "@tanstack/react-query";

import type { APIQuery } from "@corbits/api-query";
import {
  ApiQueryError,
  UnauthenticatedError,
  toAPIQuery,
} from "@corbits/api-query";
import { isChatPickerModelName } from "@corbits/connections/model-capability";
import { parseErrorEnvelope } from "@corbits/error-sink";
import { tenantKeys } from "./query-client";

export type AgentDefinition = typeof WorkflowDefinitionResponse.infer;
export type AgentInstance = typeof WorkflowRunResponse.infer;
export type CatalogModel = typeof ModelResponse.infer;

const RunFireResponse = WorkflowRunResponse.and(
  type({
    routineId: "string | null",
    routineName: "string | null",
    "hasInFlightTurn?": "boolean",
    "turns?": type({
      status: "string",
      "endedAt?": "string | null",
    }).array(),
  }),
);
/** A `feed=fires` row: every `AgentInstance` field plus the routine that
 * fired it (both `null` for a directly-triggered deployment with no
 * routine parent). */
export type RunFire = typeof RunFireResponse.infer;

const DefinitionsPage = paginatedSchema(WorkflowDefinitionResponse);
const InstancesPage = paginatedSchema(WorkflowRunResponse);
const RunFiresPage = paginatedSchema(RunFireResponse);
const ModelsPage = paginatedSchema(ModelResponse);

// The REST pagination ceiling (see `vendor/intx/hub-api/src/pagination.ts`).
// A bench with more agents or instances than this needs real pagination on
// this page, not raised here — tracked as a known limit, not silently
// worked around.
const PAGE_LIMIT = 100;

type Validator<T> = (data: unknown) => T | ArkErrors;

async function getJSON<T>(path: string, schema: Validator<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (response.status === 401) {
    throw new ApiQueryError("Not signed in.", 401, path);
  }
  if (!response.ok) {
    throw new ApiQueryError(
      `The server answered ${response.status}.`,
      response.status,
      path,
    );
  }
  const parsed = schema(await response.json().catch(() => undefined));
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected response shape: ${parsed.summary}`,
      undefined,
      path,
    );
  }
  return parsed;
}

async function postJSON<T>(
  path: string,
  schema: Validator<T>,
  body: unknown,
  method: "POST" | "PUT" | "DELETE" = "POST",
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = parseErrorEnvelope(json);
    throw new ApiQueryError(
      envelope?.error.userMessage ?? `The server answered ${response.status}.`,
      response.status,
      path,
      envelope?.error.refId,
    );
  }
  const parsed = schema(json);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected response shape: ${parsed.summary}`,
      undefined,
      path,
    );
  }
  return parsed;
}

export function listAgentDefinitions(
  tenantId: string,
): Promise<readonly AgentDefinition[]> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/definitions?limit=${PAGE_LIMIT}`,
    DefinitionsPage,
  ).then((page) => page.data);
}

export function listAgentInstances(
  tenantId: string,
): Promise<readonly AgentInstance[]> {
  return getJSON(
    `/api/tenants/${tenantId}/workflows/runs?limit=${PAGE_LIMIT}`,
    InstancesPage,
  ).then((page) => page.data);
}

/**
 * The tenant's genuine top-level deployment runs — every folded run
 * (workbench host, invited agent, routine fire, task) excluded server-side
 * by the hub's own `folded_run` marker table (see `@corbits/folded-runs`'s
 * `scope-routes.ts`), not derived client-side from a tenant's workbenches
 * the way `foldedRunIdsFromWorkbenches` used to. Used wherever a page needs
 * "real deployments only" — the Agent Directory. A routine fire IS a
 * folded run, so this feed structurally never carries one; a caller that
 * needs routine activity wants `listRoutineRunFires` below instead.
 */
export function listTopLevelRuns(
  tenantId: string,
): Promise<readonly AgentInstance[]> {
  return getJSON(
    `/api/tenants/${tenantId}/top-level-runs?limit=${PAGE_LIMIT}`,
    InstancesPage,
  ).then((page) => page.data);
}

/**
 * `feed=fires` (CL-6249): the tenant's genuine *executed* runs — unlike
 * `listTopLevelRuns`, a routine's fire is kept even though it is a folded
 * run, tagged with the routine that fired it (see
 * `@corbits/folded-runs`'s `scope-routes.ts`'s `listTopLevelRunFires`).
 * The shell's "Running" activity band (CL-6595) reads this, not
 * `listTopLevelRuns`, so a routine's own run is actually visible here —
 * `listTopLevelRuns`'s `notExists(folded_run)` filter drops every routine
 * fire by construction, which left Mission Control's active-run count
 * permanently desynced from the Routines page's own "Running now" pill.
 */
export function listRoutineRunFires(
  tenantId: string,
): Promise<readonly RunFire[]> {
  return getJSON(
    `/api/tenants/${tenantId}/top-level-runs?limit=${PAGE_LIMIT}&feed=fires`,
    RunFiresPage,
  ).then((page) => page.data);
}

/** The tenant's visible, enabled catalog models for the create-agent form's
 * model picker. Uses `/catalog/models` (paginated `ModelResponse`), not the
 * bare-array discovery route at `/models` (`ModelInfo[]`) — those are
 * different wire shapes. Disabled rows are filtered out here because the
 * catalog may retain them. Embedding-named models, Hugging Face Hub paths,
 * and bare `.gguf` names are also omitted (CL-6744) — this endpoint carries
 * no offering capability lists, so the name-only
 * {@link isChatPickerModelName} gate is the available signal. */
export function listCatalogModels(
  tenantId: string,
): Promise<readonly CatalogModel[]> {
  return getJSON(
    `/api/tenants/${tenantId}/catalog/models?limit=${PAGE_LIMIT}`,
    ModelsPage,
  ).then((page) =>
    page.data.filter(
      (model) => !model.disabled && isChatPickerModelName(model.canonicalName),
    ),
  );
}

const AgentDefinitionDraftResponse = type({
  draft: {
    systemPrompt: "string",
    "description?": "string",
    "modelPreference?": "string",
    "toolPackagePins?": "string[]",
    "skills?": "string[]",
  },
});
export type AgentDefinitionDraft =
  typeof AgentDefinitionDraftResponse.infer.draft;

/**
 * Asks Myra to draft a starting system prompt (and optionally a
 * refined description, a model pick, and skills) from a name and a
 * plain-language purpose — the create-agent panel's "Create & chat"
 * flow (CL-6074). Hits `@corbits/agent-directory`'s
 * `POST .../planner/agent-definitions/draft`; never deploys anything
 * itself. A caller that gets a rejected promise here (Myra unavailable,
 * the draft timing out, an unparseable or out-of-inventory reply, or a
 * concurrent draft already in flight) should let the person write the
 * system prompt by hand rather than retry silently — see that route's
 * own fail-closed posture.
 */
export function draftAgentDefinition(
  tenantId: string,
  input: { readonly name: string; readonly purpose?: string },
): Promise<AgentDefinitionDraft> {
  return postJSON(
    `/api/tenants/${tenantId}/planner/agent-definitions/draft`,
    AgentDefinitionDraftResponse,
    input,
  ).then((body) => body.draft);
}

export type CreateAgentDefinitionInput = {
  readonly name: string;
  readonly handle: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly skills?: readonly string[];
  /** Tool packages to pin by name (no version — the create route
   * resolves each to `*`). Used by a template-driven create
   * (`instantiateWorkbenchTemplate`'s Scout/Jimmy requests), never by
   * the hand-authored create form, which has no field for it. */
  readonly toolPackagePins?: readonly string[];
};

const CreatedAgentDefinition = WorkflowDefinitionResponse.and({
  skills: "string[]",
});

export function createAgentDefinition(
  tenantId: string,
  input: CreateAgentDefinitionInput,
): Promise<AgentDefinition & { readonly skills: readonly string[] }> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions`,
    CreatedAgentDefinition,
    input,
  );
}

const AgentCapabilitiesResponse = type({
  name: "string",
  "model?": "string",
});
export type AgentCapabilities = typeof AgentCapabilitiesResponse.infer;

/** `GET /api/tenants/:t/agent-definitions/:id` — the same route
 * `@corbits/chat-ui`'s per-workbench Agents section reads for its model
 * picker. Fetched lazily, per definition, only once its row is expanded on
 * the Agents roster — the paginated definitions list itself carries no
 * model field. */
export function getAgentCapabilities(
  tenantId: string,
  definitionId: string,
): Promise<AgentCapabilities> {
  return getJSON(
    `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}`,
    AgentCapabilitiesResponse,
  );
}

/** `GET /agent-definitions/by-name/:slug` — one definition resolved by its
 * immutable slug, server-side. A slug-addressed page reads this instead of
 * scanning the paginated definitions listing, so an agent past that
 * listing's ceiling still answers on its own URL. */
export function getAgentDefinitionBySlug(
  tenantId: string,
  slug: string,
): Promise<AgentDefinition> {
  return getJSON(
    `/api/tenants/${tenantId}/agent-definitions/by-name/${encodeURIComponent(slug)}`,
    WorkflowDefinitionResponse,
  );
}

const AgentDefinitionDetailResponse = type({
  name: "string",
  systemPrompt: "string",
  "model?": "string",
  skills: "string[]",
});
export type AgentDefinitionDetail = typeof AgentDefinitionDetailResponse.infer;

/** Everything the agent detail page edits, read from the one route that
 * owns a definition's authored state (`GET /agent-definitions/:id`): its
 * display name, its system prompt, its pinned skills, and the model it
 * resolves against. `name` here is the display name the definition's row
 * carries, never its immutable slug. */
export function getAgentDefinitionDetail(
  tenantId: string,
  definitionId: string,
): Promise<AgentDefinitionDetail> {
  return getJSON(
    `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}`,
    AgentDefinitionDetailResponse,
  );
}

/** Replaces a definition's display name and system prompt in one write —
 * the same route the per-workbench Assistant editor saves through, never
 * a second write path of this page's own. */
export function updateAgentInstructions(
  tenantId: string,
  definitionId: string,
  input: { readonly name: string; readonly systemPrompt: string },
): Promise<{ readonly name: string; readonly systemPrompt: string }> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}`,
    type({ name: "string", systemPrompt: "string" }),
    input,
    "PUT",
  );
}

const AgentCapabilitiesWriteResponse = type({
  skills: "string[]",
  "model?": "string",
});

/** Sets the model a definition resolves against, through the guided
 * capability-add route — which re-checks the name against the tenant's
 * live catalog, so a model this bench cannot actually reach is refused
 * rather than written. */
export function setAgentModel(
  tenantId: string,
  definitionId: string,
  canonicalName: string,
): Promise<{ readonly model?: string }> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}/capabilities`,
    AgentCapabilitiesWriteResponse,
    { kind: "model", canonicalName },
  );
}

/** Un-pins a definition's model, returning it to the bench default. Its own
 * verb rather than `setAgentModel("")`: "no model" is not a name the
 * capability route's inventory check could ever accept. */
export function clearAgentModel(
  tenantId: string,
  definitionId: string,
): Promise<{ readonly model?: string }> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}/capabilities/model`,
    AgentCapabilitiesWriteResponse,
    {},
    "DELETE",
  );
}

/** Archives (`stopped`) or restores (`deployed`) a definition. Nothing is
 * deleted either way — an archived agent keeps its row, its asset, and its
 * history, and simply stops appearing anywhere a person can launch it. */
export function setAgentDefinitionStatus(
  tenantId: string,
  definitionId: string,
  status: "deployed" | "stopped",
): Promise<{ readonly status: string }> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}/status`,
    type({ id: "string", status: "string" }),
    { status },
    "PUT",
  );
}

const DefinitionSkillsMap = type({ skills: { "[string]": "string[]" } });

/** Every attached-skill list for the given definitions, keyed by definition
 * id. Call sites treat failure as its own outcome (`skillsError`) rather than
 * coercing to `{}` — empty attachments and a failed read are different. */
export function listAgentSkills(
  tenantId: string,
  definitionIds: readonly string[],
): Promise<Record<string, readonly string[]>> {
  if (definitionIds.length === 0) return Promise.resolve({});
  const ids = encodeURIComponent(definitionIds.join(","));
  return getJSON(
    `/api/tenants/${tenantId}/agent-definitions/skills?ids=${ids}`,
    DefinitionSkillsMap,
  ).then((page) => page.skills);
}

/** Replaces one definition's attached skills wholesale — an empty array
 * detaches every skill, never a partial patch. */
export function updateAgentSkills(
  tenantId: string,
  definitionId: string,
  skills: readonly string[],
): Promise<readonly string[]> {
  return postJSON(
    `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}/skills`,
    type({ skills: "string[]" }),
    { skills },
    "PUT",
  ).then((body) => body.skills);
}

export type AgentDirectoryData = {
  readonly tenantId: string;
  readonly definitions: readonly AgentDefinition[];
  readonly instances: readonly AgentInstance[];
  readonly models: readonly CatalogModel[];
  /** Attached skills per definition id. Missing entries read as "none". */
  readonly definitionSkills: Record<string, readonly string[]>;
  /** Set when the model catalog failed independently; definitions and
   * instances still load so the page stays usable. */
  readonly modelsError?: string;
  /** Set when the attached-skills batch failed independently; definitions
   * and instances still load. Distinct from an empty `definitionSkills`
   * map — failure must never read as "no skills attached". */
  readonly skillsError?: string;
};

type ModelsOutcome =
  | { readonly ok: true; readonly models: readonly CatalogModel[] }
  | { readonly ok: false; readonly message: string };

type SkillsOutcome =
  | {
      readonly ok: true;
      readonly definitionSkills: Record<string, readonly string[]>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Loads a bench's agent directory. Definitions and instances are required;
 * the model catalog and each definition's attached skills are best-effort
 * so either failing alone never blanks the page. Failures surface as
 * `modelsError` / `skillsError` rather than silent empty collections.
 * `instances` comes from `listTopLevelRuns`, which already excludes every
 * folded run (workbench host, invited agent) server-side — see
 * `@corbits/folded-runs`'s `scope-routes.ts` — so this page never has to
 * derive that exclusion itself from a tenant's workbenches.
 */
export async function loadAgentDirectory(
  tenantId: string,
): Promise<AgentDirectoryData> {
  const [definitions, instances, modelsOutcome] = await Promise.all([
    listAgentDefinitions(tenantId),
    listTopLevelRuns(tenantId),
    listCatalogModels(tenantId).then(
      (models): ModelsOutcome => ({ ok: true, models }),
      (cause: unknown): ModelsOutcome => ({
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  ]);

  const skillsOutcome = await listAgentSkills(
    tenantId,
    definitions.map((definition) => definition.id),
  ).then(
    (definitionSkills): SkillsOutcome => ({ ok: true, definitionSkills }),
    (cause: unknown): SkillsOutcome => ({
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  );

  return {
    tenantId,
    definitions,
    instances,
    models: modelsOutcome.ok ? modelsOutcome.models : [],
    definitionSkills: skillsOutcome.ok ? skillsOutcome.definitionSkills : {},
    ...(modelsOutcome.ok ? {} : { modelsError: modelsOutcome.message }),
    ...(skillsOutcome.ok ? {} : { skillsError: skillsOutcome.message }),
  };
}

/**
 * Loads a bench's full agent directory. One query owns definitions +
 * instances + models + skills (models and skills are best-effort inside
 * `loadAgentDirectory`, surfacing `modelsError` / `skillsError`) so the
 * page keeps a single loading/error envelope. Pass no reloadKey —
 * invalidate `tenantKeys.agentDirectory(tenantId)` after create.
 */
export function useAgentDirectory(
  tenantId: string | undefined,
): APIQuery<AgentDirectoryData> {
  const result = useQuery({
    queryKey:
      tenantId === undefined
        ? (["tenant", "none", "agents", "directory"] as const)
        : tenantKeys.agentDirectory(tenantId),
    enabled: tenantId !== undefined,
    queryFn: async () => {
      if (tenantId === undefined) {
        throw new Error("tenantId required when agent directory is enabled");
      }
      try {
        return await loadAgentDirectory(tenantId);
      } catch (cause) {
        if (cause instanceof ApiQueryError && cause.status === 401) {
          throw new UnauthenticatedError();
        }
        throw cause;
      }
    },
  });
  return toAPIQuery(result);
}
