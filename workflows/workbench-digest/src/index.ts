// The workbench-digest workflow: a single-step definition meant to be
// deployed against a workbench's own timeline address so its reply
// posts a deterministic summary line — the trigger's own message count
// and timestamp — back into the workbench, the same way a workbench
// host's reply becomes a workbench mail post (see
// `packages/chat/src/workbench-workflow.ts` and `platform-adapter.ts`'s
// `connectorReplyContent` handling). Fired on a 09:00 UTC schedule
// (`WORKBENCH_DIGEST_SCHEDULE_CRON`). This definition's only job is to
// relay an already-deterministic digest line back out verbatim, so
// nothing about the reply's content is left to the model.
//
// Zero inference cost: like `@corbits/heartbeat-workflow`, this
// definition is deployed with its `inferencePreferences` pinned to the
// hub's `noop-inference` endpoint (see
// `packages/chat/src/noop-inference.ts` and
// `packages/seeding/src/seed.ts`'s `NOOP_MODEL_SOURCE`). Under that
// pin the turn completes instantly against a constant, empty reply —
// by design, `noop-inference` never produces real text (see that
// file's header comment) — so this deployment proves the scheduling
// and workbench-mail-posting paths stay alive at zero cost, without
// posting visible digest text. Pin `inferencePreferences` at a real
// catalog model instead to get an actual, human-visible digest line
// posted on every trigger, at that model's ordinary per-turn cost.

import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export const WORKBENCH_DIGEST_WORKFLOW_ID = "wf_workbench_digest";
export const WORKBENCH_DIGEST_STEP_ID = "workbench-digest";
export const WORKBENCH_DIGEST_SCHEDULE_CRON = "0 9 * * *";

export const WORKBENCH_DIGEST_SYSTEM_PROMPT =
  "You post a single deterministic summary line into a workbench. The " +
  "message you receive is already the exact summary line to post — " +
  "reply with its exact text: nothing added, nothing removed, no " +
  "commentary, no formatting of your own.";

/**
 * Everything the definition needs that is per-deployment data.
 * Inference preferences and the per-turn timeout are resolved at
 * deploy time; the schedule trigger is fixed on the definition.
 */
export interface WorkbenchDigestWorkflowInput {
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the workbench-digest definition. Exactly one step, matching the
 * shape every other definition in this repo commits to.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call would then hang a
 * run forever. Tools are never inlined on the definition: they arrive
 * as packages on the deploy, keeping the definition pure data.
 */
export function buildWorkbenchDigestWorkflow(
  input: WorkbenchDigestWorkflowInput,
): WorkflowDefinition {
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildWorkbenchDigestWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: WORKBENCH_DIGEST_WORKFLOW_ID,
    trigger: { type: "schedule", cron: WORKBENCH_DIGEST_SCHEDULE_CRON },
    steps: {
      "workbench-digest": step({
        agent: defineAgent({
          id: WORKBENCH_DIGEST_STEP_ID,
          description:
            "Relays an already-computed deterministic summary line " +
            "back into the workbench it is deployed against",
          systemPrompt: WORKBENCH_DIGEST_SYSTEM_PROMPT,
          tools: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
        }),
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
export function serializeWorkbenchDigestWorkflow(
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
