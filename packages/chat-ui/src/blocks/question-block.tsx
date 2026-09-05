// The interview-question card an agent posts through `ask_user`
// (`@corbits/interaction-tools`): a title, an optional subtitle, lettered
// options as buttons, and an optional free-text field. Clicking an option
// (or submitting free text) posts the answer through the same
// `/blocks/:blockId/responses` round-trip the poll/form cards use, and the
// route additionally relays it into the workbench as this principal's own
// message (see `packages/chat/src/routes.ts`) -- the card itself never
// asserts a resolved answer; it always re-reads `own` from the server,
// same anti-spoof rule every other block card follows. A question `own`
// carries `notifiedAt`: null means the answer is on file but notify never
// landed, so the card keeps a retry (including after remount) rather than
// collapsing as if the agent had already been reached.

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { QuestionBlockData } from "@corbits/chat/blocks";
import { Check } from "@corbits/icons";

import { CHAT_STRINGS } from "../strings";
import { BlockCard } from "./block-card";
import type {
  BlockResponseActions,
  BlockResponseQuery,
} from "./block-responses";

function ownAnswer(query: BlockResponseQuery): {
  readonly answer: string;
  readonly optionIndex?: number;
  readonly notifiedAt?: string | null;
} | null {
  if (query.kind !== "ready" || query.own === null) return null;
  if (query.own.kind !== "question") return null;
  return {
    answer: query.own.answer,
    ...(query.own.optionIndex !== undefined
      ? { optionIndex: query.own.optionIndex }
      : {}),
    ...(query.own.notifiedAt !== undefined
      ? { notifiedAt: query.own.notifiedAt }
      : {}),
  };
}

function notifyNeverLanded(answered: ReturnType<typeof ownAnswer>): boolean {
  return answered !== null && answered.notifiedAt === null;
}

function answeredValue(
  answered: NonNullable<ReturnType<typeof ownAnswer>>,
): string {
  return answered.optionIndex !== undefined
    ? `${CHAT_STRINGS.optionLetter(answered.optionIndex)}. ${answered.answer}`
    : answered.answer;
}

function AnsweredSummary({
  answered,
  notifyFailed,
}: {
  readonly answered: NonNullable<ReturnType<typeof ownAnswer>>;
  readonly notifyFailed: boolean;
}) {
  return (
    <div className="chat-block-question-answered" data-answered="true">
      {!notifyFailed && (
        <span className="chat-block-question-check" aria-hidden="true">
          <Check />
        </span>
      )}
      <div>
        <p className="chat-block-question-answered-label">
          {CHAT_STRINGS.blockQuestionAnsweredLabel}
        </p>
        <p className="chat-block-question-answered-value">
          {answeredValue(answered)}
        </p>
      </div>
    </div>
  );
}

function StaticOptions({ data }: { readonly data: QuestionBlockData }) {
  return (
    <div className="chat-block-choices" role="group">
      {data.options.map((option, index) => (
        <button
          key={option}
          type="button"
          className="chat-block-choice chat-block-question-choice"
          disabled
        >
          <span className="chat-block-question-letter" aria-hidden="true">
            {CHAT_STRINGS.optionLetter(index)}
          </span>
          {option}
        </button>
      ))}
    </div>
  );
}

export function QuestionBlockView({
  data,
  messageId,
  actions,
}: {
  readonly data: QuestionBlockData;
  readonly messageId?: string;
  readonly actions?: BlockResponseActions;
}) {
  const [query, setQuery] = useState<BlockResponseQuery>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");

  useEffect(() => {
    if (actions === undefined || messageId === undefined) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    setError(null);
    actions.getResponses(messageId, data.questionId).then((result) => {
      if (!cancelled) setQuery(result);
    });
    return () => {
      cancelled = true;
    };
  }, [actions, messageId, data.questionId]);

  if (actions === undefined || messageId === undefined) {
    return (
      <BlockCard title={data.question}>
        {data.subtitle !== undefined && (
          <p className="chat-block-text chat-block-question-subtitle">
            {data.subtitle}
          </p>
        )}
        <StaticOptions data={data} />
      </BlockCard>
    );
  }

  function submitAnswer(answer: string, optionIndex?: number) {
    if (actions === undefined || messageId === undefined) return;
    if (submitting || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    actions
      .submitQuestion(messageId, data.questionId, answer, optionIndex)
      .then(async (result) => {
        const next = await actions.getResponses(messageId, data.questionId);
        setQuery(next);
        if (result.kind === "submitted") return;
        // Persist failure leaves no `own`; notify_failed leaves `own` with
        // `notifiedAt: null`. The card derives retry from that GET, not from
        // this submit result — the result only picks the error copy.
        setError(
          ownAnswer(next) !== null
            ? CHAT_STRINGS.blockQuestionNotifyFailed
            : CHAT_STRINGS.blockQuestionAnswerError,
        );
      })
      .finally(() => {
        submittingRef.current = false;
        setSubmitting(false);
      });
  }

  function onFreeTextSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = freeText.trim();
    if (trimmed.length === 0) return;
    submitAnswer(trimmed);
  }

  const loading = query.kind === "loading";
  const answered = ownAnswer(query);
  const notifyFailed = notifyNeverLanded(answered);

  if (answered !== null) {
    return (
      <BlockCard title={data.question}>
        <AnsweredSummary answered={answered} notifyFailed={notifyFailed} />
        {notifyFailed && (
          <>
            <p className="chat-block-text" role="alert">
              {error ?? CHAT_STRINGS.blockQuestionNotifyFailed}
            </p>
            <div className="chat-block-actions">
              <button
                type="button"
                className="chat-block-question-freetext-submit"
                data-question-retry=""
                disabled={submitting}
                onClick={() =>
                  answered.optionIndex !== undefined
                    ? submitAnswer(answered.answer, answered.optionIndex)
                    : submitAnswer(answered.answer)
                }
              >
                {submitting
                  ? CHAT_STRINGS.blockQuestionSubmitting
                  : CHAT_STRINGS.blockQuestionRetry}
              </button>
            </div>
          </>
        )}
      </BlockCard>
    );
  }

  return (
    <BlockCard title={data.question}>
      {data.subtitle !== undefined && (
        <p className="chat-block-text chat-block-question-subtitle">
          {data.subtitle}
        </p>
      )}
      <div
        className="chat-block-choices"
        role="group"
        aria-label={data.question}
      >
        {data.options.map((option, index) => (
          <button
            key={option}
            type="button"
            className="chat-block-choice chat-block-question-choice"
            disabled={loading || submitting}
            onClick={() => submitAnswer(option, index)}
          >
            <span className="chat-block-question-letter" aria-hidden="true">
              {CHAT_STRINGS.optionLetter(index)}
            </span>
            {option}
          </button>
        ))}
      </div>
      {data.allowFreeText === true && (
        <form
          className="chat-block-question-freetext"
          onSubmit={onFreeTextSubmit}
        >
          <label htmlFor={`question-freetext-${data.questionId}`}>
            {CHAT_STRINGS.blockQuestionFreeTextLabel}
          </label>
          <input
            id={`question-freetext-${data.questionId}`}
            type="text"
            value={freeText}
            placeholder={CHAT_STRINGS.blockQuestionFreeTextPlaceholder}
            disabled={loading || submitting}
            onChange={(event) => setFreeText(event.target.value)}
          />
          <button
            type="submit"
            className="chat-block-question-freetext-submit"
            disabled={loading || submitting || freeText.trim().length === 0}
          >
            {submitting
              ? CHAT_STRINGS.blockQuestionSubmitting
              : CHAT_STRINGS.blockQuestionSubmit}
          </button>
        </form>
      )}
      {error !== null && (
        <p className="chat-block-text" role="alert">
          {error}
        </p>
      )}
    </BlockCard>
  );
}
