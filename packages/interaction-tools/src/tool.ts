// The `ask_user` tool: poses an interview question in-thread as an
// interactive `question` block (`@corbits/chat`'s `blocks.ts`) instead of
// prose bullet options, then ends the turn. A Workbench agent is an
// unbounded interactive step — every inbound mail is its next turn — so
// "ask a person" is native as "post the question and stop," not a
// structural park: the person's answer, posted as an ordinary reply in the
// same channel (`packages/chat/src/routes.ts`'s block-response route,
// which sends it as a plain message), arrives as the next turn's own
// inbound message, not as this call's result.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import { reportError } from "@corbits/error-sink";

import { postQuestion, questionIdForCall } from "./client";
import type { AskUserClientConfig } from "./client";

export const ASK_USER_TOOL = "ask_user";

export interface AskUserEnv extends BaseEnv {
  readonly hubChatUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const AskUserInput = type({
  question: "string > 0",
  "subtitle?": "string",
  options: "2 <= string[] <= 6",
  "allowFreeText?": "boolean",
});
type AskUserInput = typeof AskUserInput.infer;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: AskUserEnv): AskUserClientConfig {
  return {
    hubChatUrl: env.hubChatUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

/**
 * `ask_user`'s `run`: posts the question card, then answers the call with a
 * short instruction telling the model to end its turn — the person's answer
 * is not this call's result, it is the next turn's inbound message. No gate,
 * no correlation id, no park: a Workbench agent's next mail is already its
 * next turn, so posting and stopping IS "asking a person" here.
 *
 * `postQuestion` stamps `questionIdForCall(call.id)` (derived from the
 * tool-call id, not minted per attempt) on the outbound question card, so a
 * crash-retry of the same call re-posts the same id and the write path
 * returns the existing card rather than a duplicate (CL-7248).
 */
async function runAskUser(
  env: AskUserEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = AskUserInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`${ASK_USER_TOOL} received invalid input: ${parsed.summary}`),
    );
  }

  try {
    await postQuestion(clientConfig(env), {
      ...parsed,
      questionId: questionIdForCall(call.id),
    });
  } catch (err) {
    reportError(err, {
      operation: "ask_user_post_question",
      agentId: env.address,
    });
    return errorResult(call.id, err);
  }

  return {
    callId: call.id,
    isError: false,
    content:
      "Question posted to the user. Do not wait for a reply here or call " +
      "another tool for it: end this turn now. The user's answer will " +
      "arrive as your next inbound message, not as this call's result.",
  };
}

/**
 * The `@corbits/interaction-tools` bundle factory: one tool, `ask_user`,
 * for posing an enumerable-option interview question as an in-thread card
 * instead of a prose list. No approval gate — showing a question is not an
 * external side effect — and no `message_response` gate either: the call
 * posts and returns immediately, ending the turn.
 */
export const interactionTools = defineTool<AskUserEnv>({
  id: "@corbits/interaction-tools/ask-user",
  requires: ["hubChatUrl", "sidecarToken", "address"],
  definitions: [{ name: ASK_USER_TOOL }],
  factory: (env) => ({
    definitions: [
      {
        name: ASK_USER_TOOL,
        description:
          "Asks the user a single interview question with lettered " +
          "options, rendered as an interactive card in the conversation " +
          "instead of a prose list. Use this whenever interviewing the " +
          "user with a small set of enumerable options (2-6), rather " +
          "than writing the options out as text. Ends your turn once " +
          "posted: the user's answer arrives as your next message, not " +
          "as this call's result.",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question's title, e.g. the interview prompt.",
            },
            subtitle: {
              type: "string",
              description: "Optional supporting context shown under the title.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 6,
              description: "2-6 answer options, rendered as lettered choices.",
            },
            allowFreeText: {
              type: "boolean",
              description:
                'Whether to also show a "Type your own answer" field. ' +
                "Defaults to false.",
            },
          },
          required: ["question", "options"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      if (call.name === ASK_USER_TOOL) {
        return runAskUser(env, call);
      }
      return Promise.resolve(
        errorResult(
          call.id,
          new Error(`@corbits/interaction-tools: unknown tool "${call.name}"`),
        ),
      );
    },
  }),
});
