// Deploy-layer metadata for every seeded workflow package: display name,
// whether it's schedulable as a routine, where its result actually lands
// (a channel vs. the creator's Inbox only), required connections, and
// optional trigger-input fields. Interchange's `defineWorkflow` has no
// automatable/display-name concept of its own.
//
// `assetName`/`displayName`/`automatable` are read straight off each
// `workflows/*/package.json`'s `corbits.workflow` block via a static JSON
// import below — resolved at build time (Vite, tsc, and Bun all support
// `resolveJsonModule`), never at runtime, so this stays importable from
// the browser bundle. There is nothing left to keep "in lockstep": the
// package.json block IS the value this module reads, not a copy of it.
// The remaining fields (`conversational`, `deliveryMode`, `whatItDoes`,
// `requiredConnections`, `exampleOutput`, `typicalDuration`,
// `triggerFields`) have no npm-visible home of their own — they exist
// only here, so there is no second copy for them to drift from.
import { type } from "arktype";

import echoPkg from "../../../workflows/echo/package.json";
import codeReviewPkg from "../../../workflows/code-review/package.json";
import assistantPkg from "../../../workflows/assistant/package.json";
import heartbeatPkg from "../../../workflows/heartbeat/package.json";
import workbenchDigestPkg from "../../../workflows/workbench-digest/package.json";
import granolaCallPkg from "../../../workflows/granola-call/package.json";
import processGranolaCallPkg from "../../../workflows/process-granola-call/package.json";
import morningBriefPkg from "../../../workflows/morning-brief/package.json";
import painPointCollateralPkg from "../../../workflows/pain-point-collateral/package.json";
import collateralGenerationPkg from "../../../workflows/collateral-generation/package.json";
import redditOpportunityScannerPkg from "../../../workflows/reddit-opportunity-scanner/package.json";
import last30DaysResearchPkg from "../../../workflows/last-30-days-research/package.json";
import diligenceBriefPkg from "../../../workflows/diligence-brief/package.json";
import exaTopicWatchPkg from "../../../workflows/exa-topic-watch/package.json";
import attioTaskAgentPkg from "../../../workflows/attio-task-agent/package.json";

const CorbitsWorkflowBlock = type({
  assetName: "string > 0",
  displayName: "string > 0",
  automatable: "boolean",
});
type CorbitsWorkflowBlock = typeof CorbitsWorkflowBlock.infer;

/** Reads one workflow package's `corbits.workflow` block — the only
 * source of truth for `assetName`/`displayName`/`automatable`. Throws on
 * a malformed block rather than seeding a broken catalog entry. */
function workflowBlock(pkg: {
  readonly corbits?: { readonly workflow?: unknown };
}): CorbitsWorkflowBlock {
  const parsed = CorbitsWorkflowBlock(pkg.corbits?.workflow);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid corbits.workflow block: ${parsed.summary}`);
  }
  return parsed;
}

/**
 * One named field a mail trigger reads by name — the create-time UI's only
 * source of truth for what a workflow's trigger actually expects (see each
 * workflow's own system prompt / intake tool for the underlying contract
 * this mirrors, e.g. `workflows/last-30-days-research/src/index.ts`'s
 * "the trigger carries a `topic` and an optional `focus`", or
 * `workflows/pain-point-collateral/src/intake-tool.ts`'s `IntakeArgs`).
 * `key` is the exact field name a trigger payload carries — never
 * relabeled or humanized before it reaches the workflow.
 */
export const WorkflowTriggerField = type({
  key: "/^[a-zA-Z][a-zA-Z0-9]*$/",
  // Explicit, never defaulted: `"text"` renders a plain input and
  // accepts any non-empty string; `"agent"` renders a picker of
  // taskable agent definitions and its value must resolve to a real
  // taskable definition at create time.
  kind: "'text' | 'agent'",
  label: "string > 0",
  "placeholder?": "string",
  required: "boolean",
  "default?": "string",
  "help?": "string",
});
export type WorkflowTriggerField = typeof WorkflowTriggerField.infer;

export type WorkflowCatalogEntry = {
  readonly assetName: string;
  readonly displayName: string;
  /** Schedulable as a Routine. False for conversational agents / chat hosts. */
  readonly automatable: boolean;
  /**
   * A real chat partner a person can open a DM with and converse
   * freely — as opposed to a mail-triggered utility whose only sane
   * input is its declared trigger contract (a topic, a transcript, a
   * scheduler-computed digest line, …). `automatable` alone can't tell
   * these apart: several utilities (`echo`, `last-30-days-research`,
   * `pain-point-collateral`, …) are non-automatable on-demand runs, not
   * conversational agents. Only the seeded `assistant`/Myra definition
   * is `true` today; every other catalog entry — the whole reason this
   * catalog exists — is a workflow utility, never `true`.
   */
  readonly conversational: boolean;
  /**
   * Where a run's result actually lands — the honest end-to-end
   * contract a routine's "Deliver results to" step depends on. Every
   * entry states this plainly, whether or not it is automatable:
   * `"workbench"` posts into the picked delivery workbench's thread —
   * every catalog entry today; `"inbox"` never posts to a workbench at
   * all — its result reaches only the creator's Inbox, so a create/run
   * flow for it must never collect or require a deliveryWorkbenchId that
   * would otherwise be silently discarded.
   */
  readonly deliveryMode: "workbench" | "inbox";
  /** One honest sentence: what this workflow actually does. No metrics, no hype. */
  readonly whatItDoes: string;
  /**
   * Connector ids this workflow's tool packages call — either a native
   * connector (`@corbits/connections/registry`'s `CONNECTOR_REGISTRY`)
   * or an MCP preset slug a person connects under Plugins
   * (`@corbits/connections/mcp-presets`' `MCP_PRESETS`), which is the
   * only way some integrations (Attio) are reachable here at all. Empty
   * for workflows with no external connector dependency.
   */
  readonly requiredConnections: readonly string[];
  /** A short, honest one-line readout of what a run actually produces —
   * capitalized, no trailing period, same shape across every entry. */
  readonly exampleOutput: string;
  /** A short, honestly-hedged hint — never fabricated precision. */
  readonly typicalDuration: string;
  /**
   * Named trigger inputs a person can fill in at create time (the routine
   * create stepper) or on a manual run — omitted entirely for workflows
   * whose trigger carries no human-supplied content (see each entry's own
   * comment for why). Order is display order.
   */
  readonly triggerFields?: readonly WorkflowTriggerField[];
};

/**
 * Every known workbench workflow package, keyed by the asset name seed
 * deploys under. Agent definitions created at runtime are never listed
 * here, so they cannot pass the automatable filter by accident.
 */
export const WORKFLOW_CATALOG: readonly WorkflowCatalogEntry[] = [
  {
    ...workflowBlock(echoPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Replies with the exact text it received — a wiring check for the mail-triggered contract, not a real assistant.",
    requiredConnections: [],
    exampleOutput: "Echoed back: Testing 1 2 3",
    typicalDuration: "a few seconds",
  },
  {
    ...workflowBlock(codeReviewPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Reads a pull request's diff, reviews it for correctness, architecture, and release risk, and posts one review back on the pull request.",
    requiredConnections: ["github"],
    exampleOutput: "One review posted: 1 blocking, 2 worth fixing, 1 for later",
    typicalDuration: "a minute or two",
    triggerFields: [
      {
        key: "pullRequestUrl",
        kind: "text",
        label: "Pull request URL",
        placeholder: "https://github.com/owner/repo/pull/123",
        required: true,
        help: "The pull request to review. A GitHub webhook fills this in on its own for every new pull request.",
      },
    ],
  },
  {
    ...workflowBlock(assistantPkg),
    conversational: true,
    deliveryMode: "workbench",
    whatItDoes:
      "A general-purpose assistant for the workspace — answers questions, drafts text, and reasons through problems in conversation.",
    requiredConnections: [],
    exampleOutput: "Drafted a short, polite decline you can send as-is",
    typicalDuration: "varies with the conversation",
  },
  {
    ...workflowBlock(heartbeatPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Completes immediately on every trigger with no real reply — a lightweight target for testing scheduling and mail triggers.",
    requiredConnections: [],
    exampleOutput: "Completed at the trigger time, no reply content",
    typicalDuration: "a few seconds",
  },
  {
    ...workflowBlock(workbenchDigestPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Relays a scheduler-computed digest line straight into a workbench, unchanged — the digest content itself comes entirely from its trigger.",
    requiredConnections: [],
    exampleOutput: "Digest of 12 messages since yesterday · last post 9:41am",
    typicalDuration: "a few seconds",
  },
  {
    ...workflowBlock(granolaCallPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Polls Granola for recent calls and starts one process-granola-call run per call that doesn't yet have published notes.",
    requiredConnections: ["granola"],
    exampleOutput: "Checked 10 calls, started 2 new process-granola-call runs",
    typicalDuration: "a few seconds",
  },
  {
    ...workflowBlock(processGranolaCallPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Fetches one call's transcript and publishes five-section working notes — Participants, Summary, Pain points, Decisions, Action items — grounded in the transcript.",
    requiredConnections: ["granola"],
    exampleOutput:
      "Participants, summary, and action items from the call transcript",
    typicalDuration: "1-2 minutes",
  },
  {
    ...workflowBlock(morningBriefPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Pulls the sender's recent Granola calls and Linear issues and writes a three-section daily brief: what happened, what needs attention, and suggested next actions.",
    requiredConnections: ["granola", "linear"],
    exampleOutput:
      "Brief covering 2 calls, 3 issue updates, one blocked review",
    typicalDuration: "under a minute",
  },
  {
    ...workflowBlock(painPointCollateralPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Extracts a customer's real pain points from a call transcript and drafts one piece of targeted collateral, held for approval before it's finalized.",
    requiredConnections: ["granola"],
    exampleOutput: "Drafted a one-pager on the onboarding-speed pain point",
    typicalDuration: "a few minutes, plus the time to approve",
    // Neither field is required on its own: the workflow's intake tool
    // (workflows/pain-point-collateral/src/intake-tool.ts) accepts a
    // pasted transcript OR a Granola note id — transcript wins if both are
    // given, and neither given is a valid "teach me what to send" path,
    // not an error. Both are worth collecting at create/run time even
    // though neither is required: a manual run with no input at all would
    // just re-teach the same instructions the workflow already gives.
    triggerFields: [
      {
        key: "transcript",
        kind: "text",
        label: "Transcript",
        placeholder: "Paste the call transcript",
        required: false,
        help: "Or leave blank and give a Granola note id below.",
      },
      {
        key: "noteId",
        kind: "text",
        label: "Granola note ID",
        placeholder: "note_abc123",
        required: false,
        help: "Used only if no transcript is pasted above.",
      },
    ],
  },
  {
    ...workflowBlock(collateralGenerationPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Drafts marketing collateral across picked content types from Granola notes, Linear issues, or pasted text, with a swipe review on every draft and one approval on the final set.",
    requiredConnections: ["granola", "linear"],
    exampleOutput:
      "Drafts ready to review: LinkedIn post, blog, Twitter thread",
    typicalDuration: "several minutes, plus review and approval time",
  },
  {
    ...workflowBlock(redditOpportunityScannerPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Scores Reddit posts as outreach opportunities for a target website, after a review of the search plan and one approval on the final list.",
    requiredConnections: ["scrapecreators"],
    exampleOutput: "Ranked 6 opportunities, 2 scored 5/5 on buying signals",
    typicalDuration: "a few minutes, plus review and approval time",
  },
  {
    ...workflowBlock(last30DaysResearchPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Researches a topic over the last 30 days across web search and GitHub, and writes a cited report with sourced findings.",
    requiredConnections: ["exa"],
    exampleOutput: "Cited report: 3 new competing launches this month",
    typicalDuration: "1-2 minutes",
    // Mirrors workflows/last-30-days-research/src/index.ts's system prompt
    // exactly: "the trigger carries a `topic` and an optional `focus`" —
    // topic is required (the prompt refuses to invent one), focus narrows
    // which angle to chase and is skippable.
    triggerFields: [
      {
        key: "topic",
        kind: "text",
        label: "Topic",
        placeholder: "AI coding agents",
        required: true,
        help: "What to research over the last 30 days.",
      },
      {
        key: "focus",
        kind: "text",
        label: "Focus",
        placeholder: "Competing launches",
        required: false,
        help: "Optional — narrows which angle of the topic to chase.",
      },
    ],
  },
  {
    ...workflowBlock(diligenceBriefPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Researches a company across web search and firm memory, and writes a cited diligence brief across five fixed sections, held for approval before it's saved.",
    requiredConnections: ["exa"],
    exampleOutput:
      "Diligence brief: 5 sections, 2 flagged as insufficient evidence",
    typicalDuration: "1-2 minutes, plus review and approval time",
    // Mirrors workflows/diligence-brief/src/index.ts's system prompt
    // exactly: "the trigger carries a `company` and an optional `focus`" —
    // company is required (the prompt refuses to draft with no subject),
    // focus narrows which angle to dig into and is skippable.
    triggerFields: [
      {
        key: "company",
        kind: "text",
        label: "Company",
        placeholder: "Acme Corp",
        required: true,
        help: "The company this brief is about.",
      },
      {
        key: "focus",
        kind: "text",
        label: "Focus",
        placeholder: "Founder track record",
        required: false,
        help: "Optional — narrows which angle to dig into.",
      },
    ],
  },
  {
    ...workflowBlock(exaTopicWatchPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Searches the live web for one topic each run and publishes a short digest of what moved, held for approval before it's saved.",
    requiredConnections: ["exa"],
    exampleOutput: "Weekly digest: 4 takeaways, 2 worth a closer look",
    typicalDuration: "a minute or two, plus the time to approve",
    // Mirrors workflows/exa-topic-watch/src/index.ts's system prompt: the
    // trigger carries a `topic` and nothing else, and the prompt refuses
    // to invent or widen one, so it is the single required field.
    triggerFields: [
      {
        key: "topic",
        kind: "text",
        label: "Topic",
        placeholder: "AI coding agents for go-to-market",
        required: true,
        help: "What to watch on the web each run.",
      },
    ],
  },
  {
    ...workflowBlock(attioTaskAgentPkg),
    conversational: false,
    deliveryMode: "workbench",
    whatItDoes:
      "Works one Attio task: reads the record and the surrounding context, drafts what the task needs, and writes back to Attio only once you approve it.",
    requiredConnections: ["attio"],
    exampleOutput:
      "Two drafts ready to review, plus a CRM note awaiting your OK",
    typicalDuration: "a few minutes, plus review and approval time",
    // Mirrors workflows/attio-task-agent/src/index.ts's system prompt:
    // the trigger names the task by id, or names whose task list to look
    // in. Neither is required on its own — with neither, the run lists
    // the open tasks it can see and asks which one, which is a valid
    // start, not an error.
    triggerFields: [
      {
        key: "taskId",
        kind: "text",
        label: "Attio task ID",
        placeholder: "The task to work",
        required: false,
        help: "Or leave blank and name whose tasks to look at below.",
      },
      {
        key: "assignee",
        kind: "text",
        label: "Assignee",
        placeholder: "Whose task list to look in",
        required: false,
        help: "Used only if no task ID is given above.",
      },
    ],
  },
];

for (const entry of WORKFLOW_CATALOG) {
  if (entry.triggerFields === undefined) continue;
  const parsed = WorkflowTriggerField.array()(entry.triggerFields);
  if (parsed instanceof type.errors) {
    throw new Error(
      `workflow-catalog entry "${entry.assetName}" has an invalid ` +
        `triggerFields shape: ${parsed.summary}`,
    );
  }
}

const byAssetName = new Map(
  WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]),
);

export function isAutomatableWorkflowName(name: string): boolean {
  return byAssetName.get(name)?.automatable === true;
}

/**
 * Whether a workflow definition name is fit to offer as a DM/chat target
 * (the sidebar's agent rows, a taskable-agent picker, …) rather than a
 * triggered automation utility. A name absent from this catalog is an
 * agent-directory-created definition — "Agent definitions created at
 * runtime are never listed here" (see `WORKFLOW_CATALOG`'s own comment) —
 * and is always conversational; a name present here is conversational
 * only when its entry says so (`assistant`/Myra today).
 */
export function isConversationalWorkflowName(name: string): boolean {
  const entry = byAssetName.get(name);
  return entry === undefined || entry.conversational;
}

/**
 * Whether a routine on this workflow needs a `deliveryWorkbenchId` at
 * all — `false` only for a known `"inbox"`-delivering entry (see
 * `WorkflowCatalogEntry.deliveryMode`). An unknown name defaults `true`
 * (workbench required): the safe, prior-behavior default when a workflow
 * isn't catalog-known at all.
 */
export function deliveryWorkbenchRequiredForWorkflowName(
  name: string,
): boolean {
  return byAssetName.get(name)?.deliveryMode !== "inbox";
}

/** The full catalog entry for an asset name, or `undefined` if it isn't
 * a known workflow — the demo-card fields (`whatItDoes`, `exampleOutput`,
 * etc.) live here alongside the display name. */
export function workflowCatalogEntry(
  name: string,
): WorkflowCatalogEntry | undefined {
  return byAssetName.get(name);
}

/**
 * Friendly label for a workflow definition. Prefer the catalog display
 * name, then a non-empty description, then a humanized asset name — never
 * a raw definition id.
 */
export function workflowDisplayName(
  name: string,
  description?: string | null,
): string {
  const entry = byAssetName.get(name);
  if (entry !== undefined) return entry.displayName;
  if (description !== undefined && description !== null) {
    const trimmed = description.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return humanizeAssetName(name);
}

function humanizeAssetName(name: string): string {
  return name
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export type TriggerFieldsValidation =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * The create-time boundary check for a routine's stored `input`
 * (CL-6358): inputs bind at USE, never at creation, so a required
 * field with no value at all in `input` is never a create-time
 * rejection — the seeded last-30-days-research preset's whole reason
 * for existing is a required "Topic" left open until someone actually
 * runs it. Only a value the caller explicitly provided gets checked,
 * and only for basic shape (a non-empty string) — a key present but
 * blank is a caller bug, not an open input, and still rejected.
 * `kind: "agent"` resolution (does a provided value name a real
 * taskable definition) is a separate, still-eager check a host layers
 * on top (`apps/hub/src/index.ts`'s `routineInputValid`) since it
 * needs a tenant DB lookup this function can't do. Fire-time
 * validation (a host's own launcher definition checks) remains the
 * authoritative required-field gate.
 */
export function validateTriggerFieldsAtCreate(
  fields: readonly WorkflowTriggerField[],
  input: Record<string, unknown>,
): TriggerFieldsValidation {
  for (const field of fields) {
    if (!(field.key in input)) continue;
    const value = input[field.key];
    if (typeof value !== "string" || value.trim() === "") {
      return {
        ok: false,
        message: `"${field.label}" must not be blank`,
      };
    }
  }
  return { ok: true };
}
