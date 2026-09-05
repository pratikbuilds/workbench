// The one workflow-run-authenticated surface `ask_user` reaches:
// `@corbits/chat`'s `createWorkflowParticipantRoutes`'
// `POST .../participants/messages` — the generic "post a message into my
// own channel" route the same bundle family (`@corbits/agent-directory-tools`)
// already reaches for `participants/invite`. Same auth-header shape, same
// error-handling pattern as `@corbits/agent-directory-tools`'s `client.ts`.
import { createHash } from "node:crypto";
import { type } from "arktype";

export interface AskUserClientConfig {
  readonly hubChatUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface AskUserQuestion {
  readonly question: string;
  readonly subtitle?: string;
  readonly options: readonly string[];
  readonly allowFreeText?: boolean;
  /**
   * Stable id for this card. When omitted, `postQuestion` mints one.
   * `ask_user` always supplies `questionIdForCall(call.id)` so a retry of
   * the same tool call re-posts the same id — the participants/messages
   * route treats that as a no-op and returns the existing card (CL-7248).
   */
  readonly questionId?: string;
}

function authHeaders(config: AskUserClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

/** Pulls `error.userMessage` out of the canonical hub envelope
 * (`{error: {code, userMessage, refId}}`), if `body` matches that shape —
 * same shape `@corbits/agent-directory-tools`' client reads. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (
    error === null ||
    typeof error !== "object" ||
    !("userMessage" in error)
  ) {
    return undefined;
  }
  const userMessage = (error as { userMessage: unknown }).userMessage;
  return typeof userMessage === "string" ? userMessage : undefined;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorMessageFrom(body) ?? fallback;
}

/** Thrown when the caller's run has no channel of its own to post into —
 * the workflow-participant route's "not a participant of any channel" 404. */
export class NoOwnChannelError extends Error {}

const PostedMessageResponse = type({ id: "string", createdAt: "string" });

/**
 * Derives the question card's `questionId` from a tool-call id. The call
 * id is assigned by the runtime, not the model, so it is stable across a
 * crash-retry of the same `ask_user` invocation — hashing it into the
 * `q_<hex32>` shape `postQuestion` otherwise mints keeps a retried call
 * re-posting the same card without trusting model-supplied input.
 */
export function questionIdForCall(callId: string): string {
  return `q_${createHash("sha256").update(callId).digest("hex").slice(0, 32)}`;
}

/**
 * Posts a `question` block into the caller's own channel. Uses a caller-
 * supplied `questionId` when present (never trusts the model to supply a
 * stable, collision-free id — `ask_user` derives it from the tool-call id)
 * and otherwise mints one here. Returns the id: the block-response route
 * persists (and later relays, as an ordinary reply message) an answer keyed
 * on this same id as `blockId` — a question block's `blockId` IS its
 * `questionId`, the same way a poll's is its `pollId`
 * (`packages/chat/src/schema.ts`'s `block_responses` table comment).
 * `@intx/hub-common`'s `generateId` is a closed enum of platform id kinds
 * (vendored, read-only source) with no "question" entry, so a minted id is
 * `q_`-prefixed the same way `packages/chat/src/threads.ts`'s `thr_` ids are.
 *
 * Re-posting the same `questionId` into the same workbench is a no-op:
 * the participants/messages route returns the existing card rather than
 * inserting a second one, so a crash between this post and the tool call
 * returning cannot orphan a duplicate on retry.
 */
export async function postQuestion(
  config: AskUserClientConfig,
  question: AskUserQuestion,
): Promise<{ readonly messageId: string; readonly questionId: string }> {
  const doFetch = config.fetchImpl ?? fetch;
  const questionId =
    question.questionId ?? `q_${crypto.randomUUID().replace(/-/g, "")}`;
  const response = await doFetch(
    `${config.hubChatUrl}/api/workflow-chat/participants/messages`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        parts: [
          {
            kind: "block",
            block: {
              type: "question",
              data: {
                questionId,
                question: question.question,
                ...(question.subtitle !== undefined
                  ? { subtitle: question.subtitle }
                  : {}),
                options: question.options,
                ...(question.allowFreeText !== undefined
                  ? { allowFreeText: question.allowFreeText }
                  : {}),
              },
            },
          },
        ],
      }),
    },
  );
  if (response.status === 404) {
    throw new NoOwnChannelError(
      await readErrorMessage(
        response,
        "The caller has no channel of its own to post into",
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Posting the question failed: ${await readErrorMessage(
        response,
        `${response.status} ${response.statusText}`,
      )}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = PostedMessageResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Post-message response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return { messageId: parsed.id, questionId };
}
