// Composable, pure scoring functions over a recorded `Turn` (see
// ../types.ts) — the same `{score, pass, reason}` contract for a
// deterministic check and an LLM-judge check alike. No hub, no
// network, no clock in any scorer but `judge`, so every one of these
// is unit-testable on hand-built transcripts (see scorers.test.ts)
// without booting the real stack.

import { callEvalModel } from "../model-call.ts";
import type { ScorerContext, ScorerResult, ToolCall, Turn } from "../types.ts";
import {
  BUILD_TOOLS,
  GITHUB_POST_PR_REVIEW_TOOL,
  MEMORY_ADD_TOOL,
  ROUTINE_CREATE_TOOL,
} from "./tool-names.ts";

function allToolCalls(transcript: readonly Turn[]): ToolCall[] {
  return transcript.flatMap((turn) => turn.toolCalls);
}

function toolCallsUpTo(
  transcript: readonly Turn[],
  turnIndex: number,
): ToolCall[] {
  return transcript.slice(0, turnIndex).flatMap((turn) => turn.toolCalls);
}

function result(
  name: string,
  pass: boolean,
  reason: string,
  score = pass ? 1 : 0,
): ScorerResult {
  return { name, pass, reason, score };
}

/** Fails if the current step's reply asks more than `max` questions
 * (counted as '?' occurrences) — the interview step's "≤4 plain
 * questions in ONE message" rule. */
export function asksQuestions(options: { max: number }) {
  return function asksQuestionsScorer(ctx: ScorerContext): ScorerResult {
    const reply = ctx.transcript[ctx.turnIndex]?.replyText ?? "";
    const count = (reply.match(/\?/g) ?? []).length;
    return result(
      "asksQuestions",
      count > 0 && count <= options.max,
      `reply asked ${String(count)} question(s), max ${String(options.max)}`,
    );
  };
}

/** Fails if any of `tools` was called on the current step — used to
 * assert the interview step builds nothing yet (e.g.
 * `noToolCalls(["create_agent"])`). */
export function noToolCalls(tools: readonly string[]) {
  return function noToolCallsScorer(ctx: ScorerContext): ScorerResult {
    const called = (ctx.transcript[ctx.turnIndex]?.toolCalls ?? []).filter(
      (call) => tools.includes(call.name),
    );
    return result(
      "noToolCalls",
      called.length === 0,
      called.length === 0
        ? `none of [${tools.join(", ")}] called on this step`
        : `called on this step: ${called.map((c) => c.name).join(", ")}`,
    );
  };
}

/** Fails if any of `BUILD_TOOLS` (create_agent) was called in a step
 * before `interviewAnsweredAtStep` — the owner's rule that the
 * interview (step 1) must land before any building (step 4) starts. */
export function noBuildBeforeAnswers(interviewAnsweredAtStep: number) {
  return function noBuildBeforeAnswersScorer(ctx: ScorerContext): ScorerResult {
    const early = toolCallsUpTo(
      ctx.transcript,
      Math.min(interviewAnsweredAtStep, ctx.turnIndex + 1),
    );
    const buildTools: readonly string[] = BUILD_TOOLS;
    const premature = early.filter((call) => buildTools.includes(call.name));
    return result(
      "noBuildBeforeAnswers",
      premature.length === 0,
      premature.length === 0
        ? "no build tool called before the interview step"
        : `build tool(s) called early: ${premature.map((c) => c.name).join(", ")}`,
    );
  };
}

/** Passes once every named tool has been called somewhere in the
 * transcript up to and including the current step. */
export function namesRequiredTools(tools: readonly string[]) {
  return function namesRequiredToolsScorer(ctx: ScorerContext): ScorerResult {
    const called = new Set(
      allToolCalls(ctx.transcript.slice(0, ctx.turnIndex + 1)).map(
        (call) => call.name,
      ),
    );
    const missing = tools.filter((tool) => !called.has(tool));
    return result(
      "namesRequiredTools",
      missing.length === 0,
      missing.length === 0
        ? `all required tools called: ${tools.join(", ")}`
        : `missing tool call(s): ${missing.join(", ")}`,
    );
  };
}

/** Passes once a memory_add call's arguments (JSON-stringified) contain
 * every one of `keys` as a substring — proof something recognizable
 * was actually written, not just that the tool fired. */
export function memoryWritten(keys: readonly string[]) {
  return function memoryWrittenScorer(ctx: ScorerContext): ScorerResult {
    const writes = allToolCalls(
      ctx.transcript.slice(0, ctx.turnIndex + 1),
    ).filter((call) => call.name === MEMORY_ADD_TOOL && !call.isError);
    const blob = JSON.stringify(writes.map((w) => w.arguments));
    const missing = keys.filter((key) => !blob.includes(key));
    return result(
      "memoryWritten",
      writes.length > 0 && missing.length === 0,
      writes.length === 0
        ? "no successful memory_add call yet"
        : missing.length === 0
          ? `memory_add recorded all of: ${keys.join(", ")}`
          : `memory_add missing: ${missing.join(", ")}`,
    );
  };
}

/**
 * Passes if create_agent succeeded and the result shows the specialist's
 * own chat was minted or reopened. Creating an agent now opens that
 * agent's 1:1 — invite-into-the-current-workbench wording is ignored,
 * not required. A definition-created signal plus either an own-chat id
 * (`workbenchId` / `chatId` / a `created` field) or explicit minted-chat
 * wording is enough, so this still scores after invite-into-current
 * fields disappear from the tool result. Copy that says the definition
 * was created but its own chat could not be opened is a fail — the
 * minted-chat wording would otherwise match `/own chats?/`.
 */
const DEFINITION_CREATED_SIGNAL =
  /Created\s+"|use this id for routines\/dispatch:|"id"\s*:/i;

const MINTED_OWN_CHAT_SIGNAL =
  /workbenchId|chatId|chat_id|"created"\s*:|own chats?|minted|reopened/i;

const COULD_NOT_OPEN_OWN_CHAT_SIGNAL = /could not open its own chats?/i;

function createAgentMintedOwnChat(call: ToolCall): boolean {
  return (
    !call.isError &&
    !COULD_NOT_OPEN_OWN_CHAT_SIGNAL.test(call.result) &&
    DEFINITION_CREATED_SIGNAL.test(call.result) &&
    MINTED_OWN_CHAT_SIGNAL.test(call.result)
  );
}

export function agentCreatedInWorkbench() {
  return function agentCreatedInWorkbenchScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const creates = allToolCalls(
      ctx.transcript.slice(0, ctx.turnIndex + 1),
    ).filter((call) => call.name === "create_agent");
    const minted = creates.filter(createAgentMintedOwnChat);
    return result(
      "agentCreatedInWorkbench",
      creates.length > 0 && minted.length === creates.length,
      creates.length === 0
        ? "no create_agent call yet"
        : minted.length === creates.length
          ? `${String(creates.length)} agent(s) created, all with their own chat`
          : `${String(creates.length - minted.length)} of ${String(creates.length)} created agent(s) show no minted own chat in their result`,
    );
  };
}

/** Passes once routine_create succeeded with a trigger of the given
 * `kind` ("daily" | "weekly" | "cron" | "webhook"). */
export function routineCreated(options: { trigger: string }) {
  return function routineCreatedScorer(ctx: ScorerContext): ScorerResult {
    const creates = allToolCalls(
      ctx.transcript.slice(0, ctx.turnIndex + 1),
    ).filter((call) => call.name === ROUTINE_CREATE_TOOL && !call.isError);
    const matching = creates.filter((call) => {
      const trigger = call.arguments["trigger"];
      return (
        typeof trigger === "object" &&
        trigger !== null &&
        (trigger as Record<string, unknown>)["kind"] === options.trigger
      );
    });
    return result(
      "routineCreated",
      matching.length > 0,
      matching.length > 0
        ? `routine_create succeeded with trigger.kind="${options.trigger}"`
        : creates.length === 0
          ? "no successful routine_create call yet"
          : `routine_create ran but no call used trigger.kind="${options.trigger}"`,
    );
  };
}

/** Fails if routine_create was called before `okAtStep` — the owner's
 * rule that a routine is only ever created after explicit human OK
 * (step 6). */
export function routineCreatedOnlyAfterOk(okAtStep: number) {
  return function routineCreatedOnlyAfterOkScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const early = toolCallsUpTo(
      ctx.transcript,
      Math.min(okAtStep, ctx.turnIndex + 1),
    ).filter((call) => call.name === ROUTINE_CREATE_TOOL);
    return result(
      "routineCreatedOnlyAfterOk",
      early.length === 0,
      early.length === 0
        ? "no routine_create call before the OK step"
        : `routine_create called ${String(early.length)} time(s) before the OK step`,
    );
  };
}

const APPROVAL_PHRASES = [
  "go ahead",
  "do it",
  "sounds good",
  "yes",
  "approved",
  "approve",
  "ok",
  "okay",
  "sure",
  "run it",
];

function turnHasApproval(human: string): boolean {
  const lower = human.toLowerCase();
  return APPROVAL_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Fails if any of `tools` was called before some earlier (or the same)
 * step's human message carried a recognizable go-ahead phrase — i.e.
 * every call to a gated tool must be preceded by an explicit approval.
 * This is a proxy: the harness has no view into a real approval-UI
 * click, so "approval" here means the human's own words said yes.
 */
export function approvalGated(tools: readonly string[]) {
  return function approvalGatedScorer(ctx: ScorerContext): ScorerResult {
    const transcript = ctx.transcript.slice(0, ctx.turnIndex + 1);
    let approvedByStep = -1;
    for (const [index, turn] of transcript.entries()) {
      if (turnHasApproval(turn.human)) {
        approvedByStep = index;
        break;
      }
    }
    const violations: string[] = [];
    for (const [index, turn] of transcript.entries()) {
      const gatedCalls = turn.toolCalls.filter((call) =>
        tools.includes(call.name),
      );
      if (
        gatedCalls.length > 0 &&
        (approvedByStep === -1 || index < approvedByStep)
      ) {
        violations.push(
          `step ${String(index)}: ${gatedCalls.map((c) => c.name).join(", ")}`,
        );
      }
    }
    return result(
      "approvalGated",
      violations.length === 0,
      violations.length === 0
        ? `no gated tool (${tools.join(", ")}) ran before an approval`
        : `gated tool ran before approval — ${violations.join("; ")}`,
    );
  };
}

/**
 * Scores the current step's reply against a plain-English rubric using
 * a live model as judge. Reads `EVAL_PROVIDER_API_KEY`; when unset,
 * this returns a `skipped` result instead of ever attempting a network
 * call, so a keyless CI run never depends on this scorer passing or
 * failing. `judgeCall` is an injectable seam for tests — defaults to a
 * small Anthropic Messages API call when a key is present.
 */
export function judge(
  rubric: string,
  judgeCall?: (prompt: string) => Promise<{ pass: boolean; reason: string }>,
) {
  return async function judgeScorer(ctx: ScorerContext): Promise<ScorerResult> {
    const key = process.env["EVAL_PROVIDER_API_KEY"];
    if (key === undefined || key === "") {
      return {
        name: "judge",
        score: 1,
        pass: true,
        skipped: true,
        reason: "skipped: EVAL_PROVIDER_API_KEY not set",
      };
    }
    const reply = ctx.transcript[ctx.turnIndex]?.replyText ?? "";
    const prompt =
      `Rubric: ${rubric}\n\nReply to judge:\n${reply}\n\n` +
      'Answer with exactly one line: "PASS: <why>" or "FAIL: <why>".';
    const run =
      judgeCall ??
      (async (p: string) => {
        const { text } = await callEvalModel(p, key);
        return { pass: text.trim().startsWith("PASS"), reason: text.trim() };
      });
    const { pass, reason } = await run(prompt);
    return { name: "judge", score: pass ? 1 : 0, pass, reason };
  };
}

// --- CL-6322 §8.2 scorers -------------------------------------------
//
// Every scorer below grades "what Myra actually built" (plan.md §8.1
// item 1), not what a tool call merely asked for, against the product
// that actually shipped: the code-review template instantiated from
// the seeded library (CL-6344/#140), per-repo grants + webhook
// triggers minted at repo selection (CL-6345/#142's start-reviewing),
// and one aggregated comment-only review per PR posted free under the
// grant by `github_post_pr_review` (CL-6340/#62) — never
// N per-reviewer `create_agent`-shaped posts. `WorldSnapshot` still
// has no `reviewComments` or `runs` field (CL-6322 Phase 1), so the
// two scorers needing those skip, naming that gap.

function worldSnapshotFieldMissing(name: string, needs: string): ScorerResult {
  return {
    name,
    score: 1,
    pass: true,
    skipped: true,
    reason:
      `skipped: WorldSnapshot has no ${needs} field — no Target populates it; ` +
      "blocked on extending WorldSnapshot/snapshotWorld (see types.ts, targets/world-snapshot.ts)",
  };
}

/** Passes once the world snapshot's `github` connection is live — i.e.
 * the connection went through `@corbits/connections`, not a
 * hand-rolled token stashed some other way. */
export function githubConnectedViaConnectionsLayer() {
  return function githubConnectedViaConnectionsLayerScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const github = ctx.world.connections.find(
      (connection) => connection.slug === "github",
    );
    const connected = github?.live === true;
    return result(
      "githubConnectedViaConnectionsLayer",
      connected,
      connected
        ? "github connection reads live=true from the world snapshot"
        : `github connection not live in the world snapshot (found: ${JSON.stringify(github)})`,
    );
  };
}

/** Passes once every named reviewer handle has a materialized agent
 * definition AND the tenant's deployed code-review workflow definition
 * carries a GitHub-shaped tool-package pin. This is the shipped
 * install shape (CL-6344): `instantiateWorkbenchTemplate` creates the
 * reviewer roster as prompt-only agent definitions, while the GitHub
 * reach lives on the one `code-review` workflow the template's blocks
 * install — the reviewers themselves never carry a github pin. */
export function agentDefinitionsHaveToolGrants(handles: readonly string[]) {
  return function agentDefinitionsHaveToolGrantsScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const definitions = ctx.world.agentDefinitions;
    const missing = handles.filter(
      (handle) => !definitions.some((definition) => definition.name === handle),
    );
    const codeReviewPinned = definitions.some(
      (definition) =>
        /code.?review/i.test(definition.name) &&
        definition.toolPackagePins.some((pin) => /github/i.test(pin)),
    );
    const pass = missing.length === 0 && codeReviewPinned;
    return result(
      "agentDefinitionsHaveToolGrants",
      pass,
      pass
        ? `all of [${handles.join(", ")}] are materialized and the code-review definition carries a github-shaped tool pin`
        : missing.length > 0
          ? `missing a materialized definition for: ${missing.join(", ")}`
          : "no deployed code-review definition carries a github-shaped tool pin",
    );
  };
}

/** Passes once the snapshot carries an enabled `webhook_trigger` row —
 * the shipped per-repo trigger CL-6345's start-reviewing mints (one
 * per selected repo, bound to the deployed code-review definition),
 * not a chat-driven `routine_create` with a webhook trigger kind. */
export function triggerIsWebhookPerPr() {
  return function triggerIsWebhookPerPrScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const live = ctx.world.webhookTriggers.find((trigger) => trigger.enabled);
    return result(
      "triggerIsWebhookPerPr",
      live !== undefined,
      live !== undefined
        ? `webhook trigger ${live.id} ("${live.name}") is enabled against definition ${live.workflowDefinitionId}`
        : "no enabled webhook_trigger row in the snapshot — start-reviewing never ran",
    );
  };
}

/** Passes once every named reviewer handle posted at least one review
 * comment, and every posted comment carries its own child run id — the
 * per-turn/per-reviewer run tracing CL-6322 Phase 1.3 (`onTrigger`
 * adoption) is meant to produce. `WorldSnapshot` has no
 * `reviewComments` field today, so this always skips naming that gap. */
export function reviewCommentsAttributable(handles: readonly string[]) {
  return function reviewCommentsAttributableScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    void ctx;
    void handles;
    return worldSnapshotFieldMissing(
      "reviewCommentsAttributable",
      "reviewComments",
    );
  };
}

/** Passes once every successful `github_post_pr_review` call is
 * structurally sound in the shipped aggregated-review shape (CL-6340
 * #62): a non-empty markdown `body`, a `headSha` anchoring the review,
 * and every inline comment carrying `path`/`line`/`body` — with at
 * least one GitHub `suggestion` fence somewhere in the review, the
 * form `aggregateReview` renders a reviewer's `suggestedFix` into. */
export function suggestedFixesStructurallyValid() {
  return function suggestedFixesStructurallyValidScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const calls = allToolCalls(
      ctx.transcript.slice(0, ctx.turnIndex + 1),
    ).filter(
      (call) => call.name === GITHUB_POST_PR_REVIEW_TOOL && !call.isError,
    );
    if (calls.length === 0) {
      return result(
        "suggestedFixesStructurallyValid",
        false,
        `no successful ${GITHUB_POST_PR_REVIEW_TOOL} call yet — the fired ` +
          "PR event never produced a posted review",
      );
    }
    const problems: string[] = [];
    let sawSuggestionFence = false;
    for (const [index, call] of calls.entries()) {
      const body = call.arguments["body"];
      const headSha = call.arguments["headSha"];
      if (typeof body !== "string" || body.trim() === "") {
        problems.push(`call ${String(index)}: empty body`);
      }
      if (typeof headSha !== "string" || headSha.trim() === "") {
        problems.push(`call ${String(index)}: missing headSha`);
      }
      const comments = call.arguments["comments"];
      const commentList = Array.isArray(comments) ? comments : [];
      for (const [commentIndex, comment] of commentList.entries()) {
        const entry = comment as Record<string, unknown>;
        if (
          typeof entry["path"] !== "string" ||
          typeof entry["line"] !== "number" ||
          typeof entry["body"] !== "string"
        ) {
          problems.push(
            `call ${String(index)} comment ${String(commentIndex)}: missing path/line/body`,
          );
        }
      }
      const allText = [
        typeof body === "string" ? body : "",
        ...commentList.map((comment) =>
          String((comment as Record<string, unknown>)["body"] ?? ""),
        ),
      ].join("\n");
      if (allText.includes("```suggestion")) sawSuggestionFence = true;
    }
    if (!sawSuggestionFence) {
      problems.push("no ```suggestion fence in any posted review");
    }
    return result(
      "suggestedFixesStructurallyValid",
      problems.length === 0,
      problems.length === 0
        ? `all ${String(calls.length)} posted review(s) are structurally valid with at least one suggestion fence`
        : problems.join("; "),
    );
  };
}

/**
 * Encodes the owner's ruling on where the approval boundary sits for
 * an outward GitHub action: posting a review comment is FREE under a
 * valid per-repo grant (must NOT wait on a human approval phrase), but
 * a merge-class action (opening/landing a merge, not reviewing) DOES
 * park behind one — the same contract `approvalGated` already proves
 * for `routine_create`, applied here to `mergeTool`. Two assertions,
 * one scorer, because they're the same ruling read two ways: passes
 * once (a) every successful `github_post_pr_review` call targets a
 * pull request under the granted `repo` and its aggregated body names
 * at least one of `attributionMarkers` (the reviewer lens names
 * `aggregateReview` renders into the "What each reviewer looked at"
 * section — the audit-attribution the shipped one-review shape
 * carries), with no approval-phrase requirement, and (b) any
 * `mergeTool` call found only ever follows an approval phrase. No
 * merge-class tool exists in `@corbits/github-tools` today (posting is
 * comment-only by design), so (b) is vacuously satisfied until one
 * ships.
 */
export function outwardGitHubActionsRespectGrantBoundary(
  repo: string,
  mergeTool: string,
  attributionMarkers: readonly string[],
) {
  return function outwardGitHubActionsRespectGrantBoundaryScorer(
    ctx: ScorerContext,
  ): ScorerResult {
    const transcript = ctx.transcript.slice(0, ctx.turnIndex + 1);
    const postCalls = allToolCalls(transcript).filter(
      (call) => call.name === GITHUB_POST_PR_REVIEW_TOOL && !call.isError,
    );
    if (postCalls.length === 0) {
      return result(
        "outwardGitHubActionsRespectGrantBoundary",
        false,
        `no successful ${GITHUB_POST_PR_REVIEW_TOOL} call yet — the fired ` +
          "PR event never produced a posted review",
      );
    }
    const repoPrefix = `https://github.com/${repo}/pull/`;
    const offRepo = postCalls.filter((call) => {
      const url = call.arguments["pullRequestUrl"];
      return typeof url !== "string" || !url.startsWith(repoPrefix);
    });
    const unattributed = postCalls.filter((call) => {
      const body = call.arguments["body"];
      if (typeof body !== "string") return true;
      return !attributionMarkers.some((marker) => body.includes(marker));
    });

    let approvedByStep = -1;
    for (const [index, turn] of transcript.entries()) {
      if (turnHasApproval(turn.human)) {
        approvedByStep = index;
        break;
      }
    }
    const mergedBeforeApproval: string[] = [];
    for (const [index, turn] of transcript.entries()) {
      const gated = turn.toolCalls.filter((call) => call.name === mergeTool);
      if (
        gated.length > 0 &&
        (approvedByStep === -1 || index < approvedByStep)
      ) {
        mergedBeforeApproval.push(`step ${String(index)}`);
      }
    }

    const pass =
      offRepo.length === 0 &&
      unattributed.length === 0 &&
      mergedBeforeApproval.length === 0;
    return result(
      "outwardGitHubActionsRespectGrantBoundary",
      pass,
      pass
        ? `all ${String(postCalls.length)} review(s) posted free under the ${repo} grant with reviewer attribution in the body, and no ${mergeTool} call ran before approval`
        : `${String(offRepo.length)} post(s) outside the ${repo} grant, ${String(unattributed.length)} with no reviewer attribution in the body, ${mergeTool} ran before approval at: ${mergedBeforeApproval.join(", ") || "none"}`,
    );
  };
}

/** Passes once every run is inspectable after the fact — the whole run,
 * including each reviewer's own per-PR pass (plan.md §8.2 item 7).
 * `WorldSnapshot` has no `runs` field today, so this always skips
 * naming that gap. */
export function wholeRunInspectable() {
  return function wholeRunInspectableScorer(ctx: ScorerContext): ScorerResult {
    void ctx;
    return worldSnapshotFieldMissing("wholeRunInspectable", "runs");
  };
}
