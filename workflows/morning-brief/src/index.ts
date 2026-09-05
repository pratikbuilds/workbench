// The morning-brief workflow: a single-step, mail-triggered definition
// whose agent pulls the caller's recent activity across connected
// sources and writes it up as one calm, scannable brief. Ported from
// the OG gtm-workbench's `heartbeat` workflow (CL-5993) — renamed to
// avoid colliding with this repo's own zero-cost `heartbeat` catalog-
// test fixture, which is an unrelated definition.
//
// Structural difference from the OG: the OG split brief assembly
// across several bespoke tools (`heartbeat_merge_brief_sources`,
// `heartbeat_format_brief_title`, `heartbeat_format_brief_document`,
// `heartbeat_format_brief_notify`) that existed only to serve this one
// workflow. Everything that specific to morning-brief — the section
// structure, the per-source degradation copy — is folded directly into
// this definition's system prompt instead: a workflow-owned constant,
// not a workflow-shaped tool package. Only the genuinely reusable
// integrations (Granola, Linear) stay external tool packages
// (`@corbits/granola-tools`, `@corbits/linear-tools`), the same way
// every other tool a workbench agent uses arrives as a package pinned
// at deploy time — never inlined on the definition (see the boundary
// test in `test/boundary.test.ts`).
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.
//
// Approval mechanics and persistence: see `finalize-tool.ts`'s header
// comment for the exact suspend/resume path and how a finalize call
// persists the brief as a Library artifact. In short —
// `morning_brief_finalize` is declared `approval: "ask"`, the platform's
// native tool-approval gate, so calling it suspends the run, creates a
// real `approval` row (visible in the inbox via `@corbits/approvals`),
// and only executes once a human approves it. This closes the gap the
// OG's plain markdown reply left open: every run now ends in a
// persisted, chip-visible artifact — a real brief, or (on the no-data
// path) an honest teaching payload — never silence.

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type { CredentialBinding } from "@intx/types";

import { MORNING_BRIEF_FINALIZE_TOOL_NAME } from "./finalize-tool";

export const MORNING_BRIEF_WORKFLOW_ID = "wf_morning_brief";
export const MORNING_BRIEF_STEP_ID = "morning-brief";

// Fixed section structure, matching the OG brief's shape. Kept as a
// single named export so a future consumer (e.g. a delivery-card
// renderer that wants to recognise these headings) reads the same
// three strings the prompt commits the model to, rather than
// re-deriving them from prose.
export const MORNING_BRIEF_SECTIONS = [
  "What happened",
  "What needs attention today",
  "Suggested next actions",
] as const;

// Sources this deployment can actually reach today, each backed by a
// real, pinnable tool package. Attio and Vercel have no workbench tool
// package yet (CL-5993's survey found neither corbits/Interchange
// integration exists) — they are named in the prompt as honestly
// "not connected" rather than silently omitted, so the brief's shape
// stays stable as sources come online: adding Attio later means giving
// it a tool package and a line here, never restructuring the brief.
export const MORNING_BRIEF_WIRED_SOURCES = ["Granola", "Linear"] as const;
export const MORNING_BRIEF_PENDING_SOURCES = ["Attio", "Vercel"] as const;

/**
 * Tool packages this definition pins (CL-5999). `@intx/agent`'s
 * `defineAgent` does not yet accept a `toolPackagePins` field on its
 * authoring-time config — it is vendored, read-only source for this
 * change — so the agent below is built directly against
 * `AgentDefinition`'s own type, which already carries the field. The
 * deploy path (`@intx/workflow-deploy`, `@intx/hub-sessions`,
 * `@corbits/folded-runs`) already resolves `toolPackagePins` into a
 * tool closure at launch time; this is the declaration side of that
 * existing pipeline.
 */
export const MORNING_BRIEF_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/granola-tools", version: "0.0.4" },
  { name: "@corbits/linear-tools", version: "0.0.4" },
];

/**
 * Binds `@corbits/granola-tools`' and `@corbits/linear-tools`' declared
 * handles to their tenant-owned credentials (CL-6028); see
 * `workflows/granola-call/src/index.ts`'s sibling constant for the full
 * rationale.
 */
export const MORNING_BRIEF_CREDENTIAL_BINDINGS: readonly CredentialBinding[] = [
  {
    package: "@corbits/granola-tools",
    handle: "granola",
    provider: "granola",
    locator: "tenant",
  },
  {
    package: "@corbits/linear-tools",
    handle: "linear",
    provider: "linear",
    locator: "tenant",
  },
];

export const MORNING_BRIEF_SYSTEM_PROMPT = [
  "You write a short daily brief summarizing the sender's recent " +
    "activity, for the sender to read at the start of their day.",
  "Use the granola_list_recent_notes and linear_list_recent_issues " +
    "tools (when available) to pull what actually happened — recent " +
    "Granola call notes and recently updated Linear issues. Call each " +
    "at most once per source.",
  "A tool call that comes back as an error (missing credential, " +
    "failed request) means that source is not connected right now — " +
    'note it plainly (e.g. "Linear: not connected") and move on. ' +
    "Never fail the brief because one source is unavailable, and never " +
    "invent activity for a source you could not reach.",
  `Attio and Vercel have no workbench integration yet: always list ` +
    `them as "not connected" rather than a real section — never ` +
    `fabricate CRM or deployment activity for them.`,
  "Structure the reply as markdown with exactly these three section " +
    `headings, in order: "${MORNING_BRIEF_SECTIONS[0]}", ` +
    `"${MORNING_BRIEF_SECTIONS[1]}", "${MORNING_BRIEF_SECTIONS[2]}". ` +
    "Keep it calm and scannable: short bullet points, no filler, no " +
    "restating the tool output verbatim.",
  "If every source is not connected, say that plainly at the top " +
    '("no connected sources to report from today") instead of ' +
    "presenting empty or padded sections as if there were real content.",
  `Finalizing: once you have written the brief, call ` +
    `\`${MORNING_BRIEF_FINALIZE_TOOL_NAME}\` exactly once with ` +
    `outcome "brief", a short title (e.g. "Morning brief — <today's ` +
    'date>"), and the full markdown brief as content. This call ' +
    "requires a human's approval before it completes. Always finalize, " +
    "even when every source is not connected: in that case, still call " +
    `\`${MORNING_BRIEF_FINALIZE_TOOL_NAME}\` once with outcome ` +
    '"status-note", a teaching title (e.g. "Morning brief — no ' +
    'connected sources yet"), and content that honestly explains what ' +
    "the brief would have looked for (recent Granola call notes, " +
    "recently updated Linear issues), names the missing connectors by " +
    "id (`granola`, `linear`), and tells the reader how to connect " +
    "them. Never end a run without finalizing — a plain reply with no " +
    "artifact is not an acceptable outcome, even on the no-data path.",
  "If the finalize call succeeds, present the finalized brief as your " +
    "reply exactly as written, with no commentary about the approval " +
    "mechanism itself. If the call is denied, reply with one calm, " +
    "plain sentence that the brief was not approved and no action was " +
    "taken; never present a denial as an error, and never apologize as " +
    "if something broke.",
].join("\n\n");

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox; a native
 * ScheduleTrigger on the definition launches this workflow on a clock
 * and is independent of this field, matching how every other
 * workflow package in this catalog is authored.
 */
export interface MorningBriefWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the morning-brief definition. Exactly one step, matching the
 * shape every other definition in this repo commits to: a single
 * reasoning-with-tools turn that calls each source tool at most once
 * and writes the brief, rather than a multi-step DAG of bespoke
 * formatting tools.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call would then hang a
 * run forever. Tools are never inlined on the definition: they arrive
 * as packages on the deploy (`@corbits/granola-tools`,
 * `@corbits/linear-tools`), keeping the definition pure data.
 */
export function buildMorningBriefWorkflow(
  input: MorningBriefWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildMorningBriefWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildMorningBriefWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: MORNING_BRIEF_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    credentialBindings: MORNING_BRIEF_CREDENTIAL_BINDINGS,
    steps: {
      "morning-brief": step({
        agent: {
          id: MORNING_BRIEF_STEP_ID,
          description:
            "Pulls recent activity across the sender's connected " +
            "sources and writes it up as a short daily brief",
          systemPrompt: MORNING_BRIEF_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: MORNING_BRIEF_TOOL_PACKAGE_PINS,
        } satisfies AgentDefinition,
        timeout: input.turnTimeoutMs,
      }),
    },
  });
}

/**
 * Serializes a definition to the JSON a workflow asset carries. The
 * definition must survive the asset round-trip byte-faithfully, so
 * anything JSON would silently drop or mangle — functions, undefined,
 * symbols, bigints, non-finite numbers, class instances — is a loud
 * error naming the offending path instead of a corrupted asset.
 */
export function serializeMorningBriefWorkflow(
  definition: WorkflowDefinition,
): string {
  assertJsonPortable(definition, "definition");
  return JSON.stringify(definition);
}

function assertJsonPortable(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${path} is a non-finite number; JSON drops it`);
      }
      return;
    case "object":
      break;
    default:
      throw new Error(
        `${path} is a ${typeof value}, which does not survive JSON ` +
          "serialization",
      );
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertJsonPortable(element, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `${path} is a non-plain object; JSON would flatten it lossily`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}

export {
  MORNING_BRIEF_FINALIZE_TOOL,
  MORNING_BRIEF_FINALIZE_TOOL_NAME,
  MORNING_BRIEF_FINALIZE_DESCRIPTION,
  buildArtifactPayload,
} from "./finalize-tool";
export type { ArtifactPayload, FinalizeArgs } from "./finalize-tool";
