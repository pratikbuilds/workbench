// The Reviews-room PR thread (CL-6342 screen 3, plus screen 4's turn
// states). Per the mock's own spec note, a thread is a bordered container
// inside the one timeline -- never a separate page or a master-detail
// split -- and a reviewer reply uses the same flat avatar-plus-body row as
// any other message, so a pull-request thread and a plain conversation
// read as the same medium. This view only renders that container; wiring
// it into the live timeline against real workbench data is the next slice,
// so every piece here is pure and props-driven, the same contract
// `ConnectGithubBlockView` uses.
//
// `Avatar` and `Markdown` are the two message-row pieces this file reuses
// rather than reinventing: `Avatar` is `@corbits/react-ui`'s own initials
// avatar, and `Markdown` is chat-ui's existing safe-subset renderer, the
// same one `TextBubble` uses in timeline.tsx. `TextBubble` itself isn't
// reusable here -- it resolves a reply's identity from `ParticipantRecord`/
// `CurrentUser` lookups that only exist once a thread is wired to a real
// workbench, and importing it back out of timeline.tsx would be circular
// (timeline.tsx already imports the block registry). The role badge
// ("Host"/"Reviewer") is local for the same reason: it's PR-thread-specific
// copy, not the generic "Agent" badge `AgentBadge` renders elsewhere.
// Flagging both `Avatar`+role-badge row and the status chip below as
// candidates for a shared react-ui primitive once a second surface needs
// the same shape.

import { Avatar, Badge, Button } from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Fragment } from "react";

import { CorbitAvatar, avatarClassForPrincipal } from "./avatar";
import { Markdown } from "./markdown";
import { CHAT_STRINGS } from "./strings";

export type PrThreadRole = "host" | "reviewer" | "human";

export type PrThreadStatus =
  | { readonly kind: "reviewed" }
  | { readonly kind: "reading" }
  | { readonly kind: "waiting-on-you" };

export type PrThreadFixLineKind = "context" | "removed" | "added";

export type PrThreadFixLine = {
  readonly kind: PrThreadFixLineKind;
  readonly text: string;
};

export type PrThreadSuggestedFix = {
  readonly file: string;
  readonly lines: readonly PrThreadFixLine[];
  readonly onCopy: () => void;
  readonly onOpenOnGithub: () => void;
};

export type PrThreadTrace = {
  readonly stepCount: number;
  readonly seconds: number;
  readonly onViewWork: () => void;
};

export type PrThreadReply = {
  readonly id: string;
  readonly sender: string;
  readonly role: PrThreadRole;
  readonly time: string;
  readonly text: string;
  readonly trace?: PrThreadTrace;
  readonly suggestedFix?: PrThreadSuggestedFix;
};

export type PrThreadFailedTurn = {
  readonly afterReplyId: string;
  readonly sender: string;
  readonly repo: string;
  readonly onRetry: () => void;
  readonly onWhatHappened: () => void;
  /** Overrides the PR-review copy (`prThreadFailedTitle`/`-Sub`, both
   * scoped to "review"/"repo" language) for a non-PR consumer of this
   * same strip — the general chat timeline's own failed-turn notice
   * (CL-6332), which has neither. `repo` stays required so every
   * existing PR-thread caller is untouched; these two just take
   * priority over it when present. */
  readonly titleText?: string;
  readonly subText?: string;
};

export type PrThreadNextReviewer = {
  readonly initials: string;
  readonly label: string;
};

export type PrThreadFooter =
  | {
      readonly kind: "settled";
      readonly repo: string;
      readonly postedAt: string;
      readonly onViewOnGithub: () => void;
    }
  | {
      readonly kind: "live";
      readonly nextReviewers: readonly PrThreadNextReviewer[];
      readonly currentReviewer: string;
    };

export type PrThreadViewProps = {
  readonly prNumber: number;
  readonly title: string;
  readonly repo: string;
  readonly author: string;
  readonly status: PrThreadStatus;
  readonly replies: readonly PrThreadReply[];
  readonly failedTurn?: PrThreadFailedTurn;
  readonly footer: PrThreadFooter;
};

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const second =
    parts.length > 1 ? (parts[1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
  return `${first}${second}`.toUpperCase();
}

function statusChip(status: PrThreadStatus) {
  const byKind: Record<
    PrThreadStatus["kind"],
    { readonly label: string; readonly tone: BadgeTone; readonly live: boolean }
  > = {
    reviewed: {
      label: CHAT_STRINGS.prThreadStatusReviewed,
      tone: "success",
      live: false,
    },
    reading: {
      label: CHAT_STRINGS.prThreadStatusReading,
      tone: "neutral",
      live: true,
    },
    "waiting-on-you": {
      label: CHAT_STRINGS.prThreadStatusWaitingOnYou,
      tone: "danger",
      live: false,
    },
  };
  return byKind[status.kind];
}

function StatusChip({ status }: { readonly status: PrThreadStatus }) {
  const { label, tone, live } = statusChip(status);
  return (
    <Badge tone={tone} className="chat-pr-status">
      {live && <span className="chat-pr-status-pulse" aria-hidden="true" />}
      {label}
    </Badge>
  );
}

function RoleBadge({ role }: { readonly role: PrThreadRole }) {
  if (role === "human") return null;
  return (
    <span className="chat-pr-role-badge" data-role={role}>
      {role === "host"
        ? CHAT_STRINGS.prThreadHostBadge
        : CHAT_STRINGS.prThreadReviewerBadge}
    </span>
  );
}

function TraceButton({ trace }: { readonly trace: PrThreadTrace }) {
  return (
    <Button
      type="button"
      variant="link"
      className="chat-pr-trace"
      onClick={trace.onViewWork}
    >
      {CHAT_STRINGS.prThreadViewWork(trace.stepCount, trace.seconds)}
    </Button>
  );
}

function SuggestedFixBlock({ fix }: { readonly fix: PrThreadSuggestedFix }) {
  return (
    <div className="chat-pr-fix">
      <div className="chat-pr-fix-head">
        <span>{CHAT_STRINGS.prThreadSuggestedFixLabel}</span>
        <span className="chat-pr-fix-file">{fix.file}</span>
      </div>
      <div className="chat-pr-fix-code">
        <pre>
          {fix.lines.map((line, index) => (
            <span
              key={`${fix.file}-${index}`}
              className="chat-pr-fix-line"
              data-kind={line.kind}
            >
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      </div>
      <div className="chat-pr-fix-actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={fix.onCopy}
        >
          {CHAT_STRINGS.prThreadCopyAction}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={fix.onOpenOnGithub}
        >
          {CHAT_STRINGS.prThreadOpenOnGithubAction}
        </Button>
      </div>
    </div>
  );
}

function ReplyRow({ reply }: { readonly reply: PrThreadReply }) {
  const isHuman = reply.role === "human";
  // No stable reviewer id reaches this pure view (see the file header) —
  // the reviewer's own display name is already the identity this row
  // shows, so it doubles as the hash seed for a deterministic per-person
  // fill (same reviewer, same color, on every reply and every reload).
  return (
    <div className="chat-pr-reply">
      {isHuman ? (
        <Avatar
          initials={initialsFromName(reply.sender)}
          label={reply.sender}
          tone="neutral"
          size="lg"
          className={avatarClassForPrincipal(reply.sender)}
        />
      ) : (
        <CorbitAvatar
          ariaLabel={reply.sender}
          size="lg"
          className="sender-avatar"
        />
      )}
      <div className="chat-pr-reply-body">
        <div className="chat-pr-reply-head">
          <span className="chat-pr-reply-sender">{reply.sender}</span>
          <RoleBadge role={reply.role} />
          <span className="chat-pr-reply-time">{reply.time}</span>
        </div>
        <div className="chat-pr-reply-text">
          <Markdown text={reply.text} />
        </div>
        {reply.suggestedFix !== undefined && (
          <SuggestedFixBlock fix={reply.suggestedFix} />
        )}
        {reply.trace !== undefined && <TraceButton trace={reply.trace} />}
      </div>
    </div>
  );
}

export function PrFailedTurnStrip({
  failedTurn,
}: {
  readonly failedTurn: PrThreadFailedTurn;
}) {
  return (
    <div className="chat-pr-failed" role="status">
      <span className="chat-pr-failed-text">
        <strong>
          {failedTurn.titleText ??
            CHAT_STRINGS.prThreadFailedTitle(failedTurn.sender)}
        </strong>
        <span className="chat-pr-failed-sub">
          {failedTurn.subText ??
            CHAT_STRINGS.prThreadFailedSub(failedTurn.repo)}
        </span>
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={failedTurn.onRetry}
      >
        {CHAT_STRINGS.prThreadRetryAction}
      </Button>
      <Button
        type="button"
        variant="link"
        className="chat-pr-failed-what-happened"
        onClick={failedTurn.onWhatHappened}
      >
        {CHAT_STRINGS.prThreadWhatHappenedAction}
      </Button>
    </div>
  );
}

function ThreadFooter({ footer }: { readonly footer: PrThreadFooter }) {
  if (footer.kind === "settled") {
    return (
      <footer className="chat-pr-foot">
        <span className="chat-pr-foot-text">
          {CHAT_STRINGS.prThreadSettledFooter(footer.repo, footer.postedAt)}
        </span>
        <Button
          type="button"
          variant="link"
          className="chat-pr-foot-link"
          onClick={footer.onViewOnGithub}
        >
          {CHAT_STRINGS.prThreadViewOnGithub}
        </Button>
      </footer>
    );
  }
  return (
    <footer className="chat-pr-foot">
      <span className="chat-pr-wait-avatars" aria-hidden="true">
        {footer.nextReviewers.map((reviewer) => (
          <CorbitAvatar
            key={reviewer.label}
            ariaLabel={reviewer.label}
            size="sm"
          />
        ))}
      </span>
      <span className="chat-pr-foot-text">
        {CHAT_STRINGS.prThreadNextReviewers(
          footer.nextReviewers.map((reviewer) => reviewer.label),
          footer.currentReviewer,
        )}
      </span>
    </footer>
  );
}

export function PrThreadView({
  prNumber,
  title,
  repo,
  author,
  status,
  replies,
  failedTurn,
  footer,
}: PrThreadViewProps) {
  return (
    <article className="chat-pr-thread">
      <header className="chat-pr-thread-head">
        <span className="chat-pr-thread-pr">
          #{prNumber} {title}
        </span>
        <span className="chat-pr-thread-repo">
          {repo} · {author}
        </span>
        <span className="chat-pr-thread-status">
          <StatusChip status={status} />
        </span>
      </header>
      <div className="chat-pr-thread-body">
        {replies.map((reply) => (
          <Fragment key={reply.id}>
            <ReplyRow reply={reply} />
            {failedTurn !== undefined &&
              failedTurn.afterReplyId === reply.id && (
                <PrFailedTurnStrip failedTurn={failedTurn} />
              )}
          </Fragment>
        ))}
      </div>
      <ThreadFooter footer={footer} />
    </article>
  );
}

export function PrQueuedStrip({
  prNumber,
  repo,
}: {
  readonly prNumber: number;
  readonly repo: string;
}) {
  return (
    <div className="chat-pr-queued">
      <span className="chat-pr-queue-bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{CHAT_STRINGS.prThreadQueued(prNumber, repo)}</span>
    </div>
  );
}
