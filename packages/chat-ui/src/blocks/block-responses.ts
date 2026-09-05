// The in-chat poll/form cards' one seam to `@corbits/chat`'s response
// routes. `@corbits/chat-ui` owns no session, so it never fetches or
// mutates responses itself -- the host supplies this port, mirroring how
// `ApprovalActions` threads the approve card's round-trip through
// `ChatWorkspace`/`WorkbenchTimeline` down to the card.
//
// A poll's live tally and a form's "already submitted" state are always
// re-read from this port after every vote/submit -- never assumed from the
// optimistic UI update or, worse, from the block's own agent-authored data
// (the same anti-spoof rule the approve card follows: tallies and "you
// voted" state are facts about stored responses, never facts an agent gets
// to assert in the message it wrote).

export type PollResponsePayload = {
  readonly kind: "poll";
  readonly choiceIds: readonly string[];
};

export type FormResponsePayload = {
  readonly kind: "form";
  readonly values: Readonly<Record<string, string>>;
};

export type QuestionResponsePayload = {
  readonly kind: "question";
  readonly answer: string;
  readonly optionIndex?: number;
  /**
   * ISO timestamp once the asking agent was notified, or `null` when
   * the answer is on file but notify never landed. Omitted only in
   * tests that are not exercising the retry path — treat missing as
   * already notified.
   */
  readonly notifiedAt?: string | null;
};

export type BlockResponsePayload =
  PollResponsePayload | FormResponsePayload | QuestionResponsePayload;

/**
 * The live read behind a poll/form card. `own` is this signed-in
 * principal's own response and nothing else's -- a poll's `tally` is the
 * one place another principal's participation is visible at all, and only
 * as an anonymous count.
 */
export type BlockResponseQuery =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly tally: Readonly<Record<string, number>>;
      readonly total: number;
      readonly own: BlockResponsePayload | null;
    }
  | { readonly kind: "forbidden" }
  | { readonly kind: "error"; readonly message: string };

export type BlockResponseSubmitResult =
  | { readonly kind: "submitted" }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

export type BlockResponseActions = {
  /** The live tally/own-response read for one block instance, addressed by
   * the message it lives in plus its own `pollId`/`formId` -- the same
   * (messageId, blockId) scope the server keys responses by, so a vote can
   * never be read back against the wrong message's block. */
  readonly getResponses: (
    messageId: string,
    blockId: string,
  ) => Promise<BlockResponseQuery>;
  /** Casts (or changes) this principal's vote. */
  readonly submitPoll: (
    messageId: string,
    blockId: string,
    choiceIds: readonly string[],
  ) => Promise<BlockResponseSubmitResult>;
  /** Submits (or resubmits) this principal's form response. */
  readonly submitForm: (
    messageId: string,
    blockId: string,
    values: Readonly<Record<string, string>>,
  ) => Promise<BlockResponseSubmitResult>;
  /** Submits this principal's answer to a question -- the chosen option's
   * label (or free text) plus, for a lettered option, its index. */
  readonly submitQuestion: (
    messageId: string,
    blockId: string,
    answer: string,
    optionIndex?: number,
  ) => Promise<BlockResponseSubmitResult>;
};
