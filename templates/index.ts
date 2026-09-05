// Workbench definitions: the single description of what "pick a kind of
// workbench" actually creates — its default agents, routines, tools,
// plugins, and the ordered onboarding walkthrough a person works
// through once the room exists.
//
// `@corbits/workflows/catalog`'s `WORKFLOW_CATALOG` describes ONE
// workflow at a time — what it does, what it needs connected, what its
// trigger carries. A definition is the layer above: a named workbench
// worth having, assembled out of several of those workflows. The three
// shipped definitions (one per subdirectory here) are the bench
// library's templates; a *template* is a shipped definition, not a
// second kind of thing.
//
// Everything here is pure data. Creating a workbench from a definition
// is a host concern (`apps/web`'s picker starts the flow, `./instantiate`
// resolves it); this module is the single description both the picker
// and the creator read, so neither hand-types an asset name, a cron, a
// connector id, or a step of onboarding copy.
//
// Blocks are referenced by asset name AND version. A definition names
// the exact `workflows/<name>/package.json` version it was designed
// against, so bumping a workflow is a deliberate edit here rather than
// a silent change in what it creates.

import { type } from "arktype";

/** One workflow a template installs, pinned to the version it was
 * designed against. `assetName` matches a `WORKFLOW_CATALOG` entry. */
export const WorkbenchTemplateBlock = type({
  assetName: "string > 0",
  version: "/^[0-9]+\\.[0-9]+\\.[0-9]+$/",
});
export type WorkbenchTemplateBlock = typeof WorkbenchTemplateBlock.infer;

/**
 * One routine a template creates on install. `cron` is a 5-field
 * expression in the grammar `@corbits/workflows` schedule/cron speaks —
 * the authority on whether one is valid and when it fires; the shape
 * check here only catches a malformed literal at module load.
 */
export const WorkbenchTemplateRoutine = type({
  /** Stable key an open input can point at. Unique within a template. */
  key: "/^[a-z][a-z0-9-]*$/",
  /** Which block runs on this schedule. */
  blockAssetName: "string > 0",
  /** What the person sees this routine called. */
  label: "string > 0",
  cron: "/^\\S+ \\S+ \\S+ \\S+ \\S+$/",
  /** One honest line: why this runs on a clock at all. */
  why: "string > 0",
});
export type WorkbenchTemplateRoutine = typeof WorkbenchTemplateRoutine.infer;

/**
 * One agent a person can address in the created workbench. `handle` is
 * what they type to reach it. `blockAssetName` names the workflow behind
 * it when the agent is a lens over one of the definition's own blocks
 * (the code-review reviewers); it is absent for an agent that is a
 * standalone chat agent installed straight through the agent-directory
 * create path (Scout, Jimmy) with no block of its own to reference.
 */
export const WorkbenchDefinitionAgent = type({
  handle: "/^[a-z][a-z0-9-]*$/",
  displayName: "string > 0",
  "blockAssetName?": "string > 0",
  /** One honest line: what this agent is for. */
  role: "string > 0",
});
export type WorkbenchDefinitionAgent = typeof WorkbenchDefinitionAgent.infer;

/**
 * One workflow a template fires from an inbound webhook rather than a
 * clock — the PR-review trigger a code-review template needs, as opposed
 * to `WorkbenchTemplateRoutine`'s cron-scheduled kind. `triggerFieldKey`
 * names the block's own `WorkflowCatalogEntry.triggerFields` entry the
 * webhook payload fills — see `@corbits/workflows/catalog`'s
 * `WorkflowTriggerField`. Creating the live `webhook_trigger` row itself
 * (`@corbits/webhook-triggers`) needs a repo to scope it to, which only
 * exists once the person has answered the template's own open input for
 * it — this is the spec a create flow resolves against that answer, not
 * the row.
 */
export const WorkbenchTemplateWebhookTrigger = type({
  /** Stable key an open input can point at. Unique within a template. */
  key: "/^[a-z][a-z0-9-]*$/",
  /** Which block this webhook launches a run of. */
  blockAssetName: "string > 0",
  /** What the person sees this trigger called. */
  label: "string > 0",
  /** One honest line: why this fires on a webhook instead of a clock. */
  why: "string > 0",
  triggerFieldKey: "/^[a-zA-Z][a-zA-Z0-9]*$/",
});
export type WorkbenchTemplateWebhookTrigger =
  typeof WorkbenchTemplateWebhookTrigger.infer;

/**
 * One answer the template cannot supply for the person — the questions
 * the create flow asks before anything runs. Exactly one of
 * `appliesToRoutine` / `appliesToWebhookTrigger` names the trigger this
 * input's answer feeds: a cron-scheduled routine, or a webhook trigger
 * spec.
 */
export const WorkbenchTemplateOpenInput = type({
  key: "/^[a-zA-Z][a-zA-Z0-9]*$/",
  label: "string > 0",
  "placeholder?": "string",
  help: "string > 0",
  required: "boolean",
  "appliesToRoutine?": "/^[a-z][a-z0-9-]*$/",
  "appliesToWebhookTrigger?": "/^[a-z][a-z0-9-]*$/",
});
export type WorkbenchTemplateOpenInput =
  typeof WorkbenchTemplateOpenInput.infer;

/**
 * One step in a definition's onboarding walkthrough, in the order a
 * person works through it. This is the *definition-level* step — the
 * full ordered walkthrough a template describes. `@corbits/chat`'s own
 * `WorkbenchOnboardingStep` is the narrower wire-level body a host
 * posts into a room to raise one card; the two are different types and
 * neither is derived from the other.
 */
export const WorkbenchOnboardingStep = type({
  kind: "'connect-plugin'",
  connectorId: "string > 0",
  title: "string > 0",
  why: "string > 0",
})
  .or({ kind: "'pick-github-repos'", title: "string > 0", why: "string > 0" })
  .or({
    kind: "'start-webhook-trigger'",
    webhookTriggerKey: "/^[a-z][a-z0-9-]*$/",
    title: "string > 0",
    why: "string > 0",
  });
export type WorkbenchOnboardingStep = typeof WorkbenchOnboardingStep.infer;

/**
 * The full definition, as parsed back off a trust boundary — the bench
 * library row a hub seeded (see `@corbits/artifacts-hub`'s template
 * library) travels over HTTP before a picker instantiates from it, so
 * it re-enters through this schema, never through `as`.
 */
export const WorkbenchDefinitionSchema = type({
  id: "/^[a-z][a-z0-9-]*$/",
  title: "string > 0",
  promise: "string > 0",
  blocks: WorkbenchTemplateBlock.array(),
  plugins: { required: "string[]", optional: "string[]" },
  tools: "string[]",
  routines: WorkbenchTemplateRoutine.array(),
  webhookTriggers: WorkbenchTemplateWebhookTrigger.array(),
  agents: WorkbenchDefinitionAgent.array(),
  openInputs: WorkbenchTemplateOpenInput.array(),
  onboardingSteps: WorkbenchOnboardingStep.array(),
});

export type WorkbenchDefinition = {
  readonly id: string;
  /** What the picker row calls it. */
  readonly title: string;
  /** The picker row's one-line promise, in the reader's language. */
  readonly promise: string;
  readonly blocks: readonly WorkbenchTemplateBlock[];
  /**
   * Connector ids (see `@corbits/connections`' `CONNECTOR_REGISTRY` and
   * `MCP_PRESETS`): `required` is what this definition cannot work
   * without, in the order the walkthrough asks for them; `optional`
   * makes it better and never gates the create.
   */
  readonly plugins: {
    readonly required: readonly string[];
    readonly optional: readonly string[];
  };
  /** Tool-package names this definition's agents need — package names
   * only, never `{name, version}` pins: the pinned version lives with
   * the agent package that owns the tool. */
  readonly tools: readonly string[];
  readonly routines: readonly WorkbenchTemplateRoutine[];
  /** Webhook-fired triggers this definition installs — empty for a
   * clock-only definition like GTM. */
  readonly webhookTriggers: readonly WorkbenchTemplateWebhookTrigger[];
  readonly agents: readonly WorkbenchDefinitionAgent[];
  readonly openInputs: readonly WorkbenchTemplateOpenInput[];
  /** The ordered walkthrough a freshly created workbench runs — connect
   * the plugin, pick what it works on, start the trigger. */
  readonly onboardingSteps: readonly WorkbenchOnboardingStep[];
};

export { GTM_TEMPLATE } from "./gtm";
export { CODE_REVIEW_TEMPLATE } from "./code-review";
export { DUE_DILIGENCE_TEMPLATE } from "./due-diligence";
export {
  instantiateWorkbenchTemplate,
  type ParticipantAgentRequest,
  type WorkbenchTemplateInstantiationPorts,
  type WorkbenchTemplateInstantiationResult,
} from "./instantiate";
export {
  jimmyAgentRequest,
  scoutAgentRequest,
} from "./participant-agent-requests";
export {
  TemplateReposSettingsPatch,
  TemplateSettingsPatch,
  templateReposSettingsPatch,
  templateSettingsPatch,
} from "./settings";
export {
  WorkflowTriggerField,
  WORKFLOW_CATALOG,
  isAutomatableWorkflowName,
  isConversationalWorkflowName,
  deliveryWorkbenchRequiredForWorkflowName,
  workflowCatalogEntry,
  workflowDisplayName,
  validateTriggerFieldsAtCreate,
  type WorkflowCatalogEntry,
  type TriggerFieldsValidation,
} from "@corbits/workflows/catalog";

import { GTM_TEMPLATE } from "./gtm";
import { CODE_REVIEW_TEMPLATE } from "./code-review";
import { DUE_DILIGENCE_TEMPLATE } from "./due-diligence";

export const WORKBENCH_TEMPLATES: readonly WorkbenchDefinition[] = [
  GTM_TEMPLATE,
  CODE_REVIEW_TEMPLATE,
  DUE_DILIGENCE_TEMPLATE,
];

const templateById = new Map(
  WORKBENCH_TEMPLATES.map((template) => [template.id, template]),
);

export function workbenchTemplate(id: string): WorkbenchDefinition | undefined {
  return templateById.get(id);
}

/**
 * Every asset name a definition names — its blocks, and the block behind
 * each routine and agent. A caller checking a definition against
 * `WORKFLOW_CATALOG` walks this rather than three separate arrays.
 */
export function templateBlockAssetNames(
  definition: WorkbenchDefinition,
): readonly string[] {
  return definition.blocks.map((block) => block.assetName);
}

/** The shipped definitions as bench-library seed entries — the ONE
 * serialization every seeder uses (`apps/hub`'s boot seed and the eval
 * harness's scratch-hub seed), so the two can never drift. */
export function workbenchTemplateLibraryEntries(): readonly {
  readonly id: string;
  readonly content: string;
}[] {
  return WORKBENCH_TEMPLATES.map((template) => ({
    id: template.id,
    content: serializeWorkbenchDefinition(template),
  }));
}

export function serializeWorkbenchDefinition(
  definition: WorkbenchDefinition,
): string {
  return JSON.stringify(definition, null, 2);
}

/**
 * Parses a seeded library row's content back into a definition, running
 * the same cross-reference checks module load runs on the shipped
 * constants. Throws on anything malformed — an unreadable library row
 * is a seeding defect to surface, never a shape to limp past.
 */
export function parseWorkbenchDefinition(data: unknown): WorkbenchDefinition {
  const raw = typeof data === "string" ? JSON.parse(data) : data;
  const parsed = WorkbenchDefinitionSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`workbench definition failed to parse: ${parsed.summary}`);
  }
  assertValid(parsed);
  return parsed;
}

function assertValid(definition: WorkbenchDefinition): void {
  const blockNames = new Set(templateBlockAssetNames(definition));
  const parsedBlocks = WorkbenchTemplateBlock.array()(definition.blocks);
  if (parsedBlocks instanceof type.errors) {
    throw new Error(
      `workbench definition "${definition.id}" has an invalid blocks shape: ${parsedBlocks.summary}`,
    );
  }
  const parsedRoutines = WorkbenchTemplateRoutine.array()(definition.routines);
  if (parsedRoutines instanceof type.errors) {
    throw new Error(
      `workbench definition "${definition.id}" has an invalid routines shape: ${parsedRoutines.summary}`,
    );
  }
  const parsedAgents = WorkbenchDefinitionAgent.array()(definition.agents);
  if (parsedAgents instanceof type.errors) {
    throw new Error(
      `workbench definition "${definition.id}" has an invalid agents shape: ${parsedAgents.summary}`,
    );
  }
  const parsedInputs = WorkbenchTemplateOpenInput.array()(
    definition.openInputs,
  );
  if (parsedInputs instanceof type.errors) {
    throw new Error(
      `workbench definition "${definition.id}" has an invalid openInputs shape: ${parsedInputs.summary}`,
    );
  }
  const parsedWebhookTriggers = WorkbenchTemplateWebhookTrigger.array()(
    definition.webhookTriggers,
  );
  if (parsedWebhookTriggers instanceof type.errors) {
    throw new Error(
      `workbench definition "${definition.id}" has an invalid webhookTriggers shape: ${parsedWebhookTriggers.summary}`,
    );
  }
  const parsedSteps = WorkbenchOnboardingStep.array()(
    definition.onboardingSteps,
  );
  if (parsedSteps instanceof type.errors) {
    throw new Error(
      `workbench definition "${definition.id}" has an invalid onboardingSteps shape: ${parsedSteps.summary}`,
    );
  }
  if (new Set(definition.tools).size !== definition.tools.length) {
    throw new Error(
      `workbench definition "${definition.id}" names the same tool package more than once`,
    );
  }
  const routineKeys = new Set(
    definition.routines.map((routine) => routine.key),
  );
  for (const routine of definition.routines) {
    if (!blockNames.has(routine.blockAssetName)) {
      throw new Error(
        `workbench definition "${definition.id}" routine "${routine.key}" runs "${routine.blockAssetName}", which the definition does not install`,
      );
    }
  }
  const webhookTriggerKeys = new Set(
    definition.webhookTriggers.map((trigger) => trigger.key),
  );
  for (const trigger of definition.webhookTriggers) {
    if (!blockNames.has(trigger.blockAssetName)) {
      throw new Error(
        `workbench definition "${definition.id}" webhook trigger "${trigger.key}" fires "${trigger.blockAssetName}", which the definition does not install`,
      );
    }
  }
  for (const agent of definition.agents) {
    if (
      agent.blockAssetName !== undefined &&
      !blockNames.has(agent.blockAssetName)
    ) {
      throw new Error(
        `workbench definition "${definition.id}" agent "${agent.handle}" is backed by "${agent.blockAssetName}", which the definition does not install`,
      );
    }
  }
  for (const input of definition.openInputs) {
    const appliesToCount =
      Number(input.appliesToRoutine !== undefined) +
      Number(input.appliesToWebhookTrigger !== undefined);
    if (appliesToCount !== 1) {
      throw new Error(
        `workbench definition "${definition.id}" input "${input.key}" must apply to exactly one of a routine or a webhook trigger`,
      );
    }
    if (
      input.appliesToRoutine !== undefined &&
      !routineKeys.has(input.appliesToRoutine)
    ) {
      throw new Error(
        `workbench definition "${definition.id}" input "${input.key}" applies to routine "${input.appliesToRoutine}", which the definition does not create`,
      );
    }
    if (
      input.appliesToWebhookTrigger !== undefined &&
      !webhookTriggerKeys.has(input.appliesToWebhookTrigger)
    ) {
      throw new Error(
        `workbench definition "${definition.id}" input "${input.key}" applies to webhook trigger "${input.appliesToWebhookTrigger}", which the definition does not create`,
      );
    }
  }
  assertOnboardingWalkthrough(definition);
}

/**
 * The walkthrough is ordered, so its checks are ordered too: a step can
 * only ask for something an earlier step made possible, and a required
 * plugin with no step to connect it is a definition that promises setup
 * it never asks for.
 */
function assertOnboardingWalkthrough(definition: WorkbenchDefinition): void {
  const declaredPlugins = new Set([
    ...definition.plugins.required,
    ...definition.plugins.optional,
  ]);
  const connectedSoFar = new Set<string>();
  const startedTriggerKeys = new Set<string>();
  let pickedRepos = false;

  for (const step of definition.onboardingSteps) {
    if (step.kind === "connect-plugin") {
      if (!declaredPlugins.has(step.connectorId)) {
        throw new Error(
          `workbench definition "${definition.id}" onboarding connects "${step.connectorId}", which is not one of its plugins`,
        );
      }
      connectedSoFar.add(step.connectorId);
      continue;
    }
    if (step.kind === "pick-github-repos") {
      if (!connectedSoFar.has("github")) {
        throw new Error(
          `workbench definition "${definition.id}" asks for repos before its onboarding connects "github"`,
        );
      }
      pickedRepos = true;
      continue;
    }
    if (!webhookTriggerKeyExists(definition, step.webhookTriggerKey)) {
      throw new Error(
        `workbench definition "${definition.id}" onboarding starts webhook trigger "${step.webhookTriggerKey}", which the definition does not create`,
      );
    }
    if (startedTriggerKeys.has(step.webhookTriggerKey)) {
      throw new Error(
        `workbench definition "${definition.id}" onboarding starts webhook trigger "${step.webhookTriggerKey}" more than once`,
      );
    }
    if (!pickedRepos) {
      throw new Error(
        `workbench definition "${definition.id}" starts webhook trigger "${step.webhookTriggerKey}" before its onboarding picks repos`,
      );
    }
    startedTriggerKeys.add(step.webhookTriggerKey);
  }

  for (const connectorId of definition.plugins.required) {
    if (!connectedSoFar.has(connectorId)) {
      throw new Error(
        `workbench definition "${definition.id}" requires plugin "${connectorId}" but its onboarding never asks anyone to connect it`,
      );
    }
  }
  for (const trigger of definition.webhookTriggers) {
    if (!startedTriggerKeys.has(trigger.key)) {
      throw new Error(
        `workbench definition "${definition.id}" webhook trigger "${trigger.key}" is never started by an onboarding step`,
      );
    }
  }
}

function webhookTriggerKeyExists(
  definition: WorkbenchDefinition,
  key: string,
): boolean {
  return definition.webhookTriggers.some((trigger) => trigger.key === key);
}

for (const definition of WORKBENCH_TEMPLATES) {
  assertValid(definition);
}
