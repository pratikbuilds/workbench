// The message composer: a plain textarea (Enter sends, Shift+Enter breaks
// the line), an accessible file picker for attachments, disabled while
// empty, with an @-mention popover listing the active workbench's agent
// participants. Kept local and simple rather than adopting the library's
// `ChatInput` — that component is built around the agent-chat `ChatMessage`
// model (working/stop) this surface does not use, and its send affordance
// does not compose with an inline mention popover.

import { Avatar, Button } from "@corbits/react-ui";
import {
  ArrowUp,
  CircleNotch,
  Microphone,
  Paperclip,
  Stop,
  X,
} from "@corbits/icons";
import { reportError } from "@corbits/error-sink";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

import { CorbitAvatar, avatarClassForPrincipal } from "./avatar";
import type { Part, ParticipantRecord } from "./api";
import type { AgentDisplayNames } from "./agent-display-names";
import {
  activeMentionQuery,
  filterMentionOptions,
  insertMention,
  mentionOptionsFromWorkbench,
} from "./mentions";
import type {
  BringInAgentDefinition,
  BringInMember,
  MentionCandidate,
  MentionInviteIntent,
  MentionOption,
  MentionQuery,
} from "./mentions";
import {
  SLASH_COMMANDS,
  activeSlashQuery,
  filterSlashCommands,
} from "./slash-commands";
import type { SlashCommandSpec, SlashQuery } from "./slash-commands";
import { CHAT_STRINGS } from "./strings";

/** A file the user picked in the composer, already base64-encoded for the wire. */
export type ComposerAttachment = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly data: string;
};

export type ComposerSendPayload = {
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  /** Every "Bring in…" candidate picked since the draft was last sent —
   * the send path invites each one before posting the message itself
   * (see `packages/chat/src/routes.ts`'s `MessageInviteEntry`). Omitted
   * (or empty) when nothing was picked from that group. */
  readonly invite?: readonly MentionInviteIntent[];
};

/** Imperative seam a host can grab a ref to, so content from outside the
 * composer's own tree — the profile card's Mention action (CL-5914) or
 * hover-edit of a previous prompt — can land in the active draft. */
export type ComposerHandle = {
  readonly insertText: (text: string) => void;
  readonly setText: (text: string) => void;
};

/** Splice `insertion` in at `caret`, pure and independent of any DOM state
 * so it unit-tests the same way `insertMention` does. */
export function insertTextAtCaret(
  value: string,
  caret: number,
  insertion: string,
): { readonly text: string; readonly caret: number } {
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const text = `${before}${insertion}${after}`;
  return { text, caret: before.length + insertion.length };
}

export type SpeechRecognitionAlternativeLike = {
  readonly transcript: string;
};

export type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly 0: SpeechRecognitionAlternativeLike;
};

export type SpeechRecognitionEventLike = {
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
};

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function isSpeechRecognitionCtor(
  value: unknown,
): value is SpeechRecognitionCtor {
  return typeof value === "function";
}

/** Browser `SpeechRecognition` / `webkitSpeechRecognition`, or null. */
export function speechRecognitionConstructor(
  global: object = globalThis,
): SpeechRecognitionCtor | null {
  if ("SpeechRecognition" in global) {
    const ctor = Reflect.get(global, "SpeechRecognition");
    if (isSpeechRecognitionCtor(ctor)) return ctor;
  }
  if ("webkitSpeechRecognition" in global) {
    const ctor = Reflect.get(global, "webkitSpeechRecognition");
    if (isSpeechRecognitionCtor(ctor)) return ctor;
  }
  return null;
}

function speechRecognitionErrorCode(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  if (!("error" in event)) return null;
  const { error } = event;
  if (typeof error !== "string") return null;
  return error;
}

function isBenignSpeechRecognitionError(code: string): boolean {
  return code === "aborted" || code === "no-speech";
}

function detachDictation(rec: SpeechRecognitionLike) {
  rec.onresult = null;
  rec.onerror = null;
  rec.onend = null;
}

export function transcriptFromSpeechResults(
  results: ArrayLike<SpeechRecognitionResultLike>,
): string {
  let text = "";
  for (const result of Array.from(results)) {
    if (result.length === 0) continue;
    text += result[0].transcript;
  }
  return text;
}

/**
 * Drop a recognition transcript between `prefix` and `suffix`, inserting a
 * space when the join would otherwise glue two words together.
 */
export function spliceDictationTranscript(
  prefix: string,
  suffix: string,
  transcript: string,
): { readonly text: string; readonly caret: number } {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    return { text: `${prefix}${suffix}`, caret: prefix.length };
  }
  const head =
    prefix.length === 0 || /\s$/u.test(prefix)
      ? `${prefix}${trimmed}`
      : `${prefix} ${trimmed}`;
  const text =
    suffix.length === 0 || /^\s/u.test(suffix)
      ? `${head}${suffix}`
      : `${head} ${suffix}`;
  return { text, caret: head.length };
}

/**
 * The B2 fix, isolated as a pure rule: a successful send clears the draft;
 * a failed one keeps exactly what the user had typed so nothing is lost.
 */
export function draftAfterSend(
  previousValue: string,
  succeeded: boolean,
): string {
  return succeeded ? "" : previousValue;
}

/**
 * Same rule for selected files: clear the attachment list only after a
 * successful send so a failed post does not force the user to re-pick files.
 */
export function attachmentsAfterSend(
  previous: readonly ComposerAttachment[],
  succeeded: boolean,
): readonly ComposerAttachment[] {
  return succeeded ? [] : previous;
}

/**
 * Build the wire `Part[]` for a composer send. Empty trimmed text is omitted;
 * each attachment becomes a `FilePart` carrying inline base64 `data`.
 */
export function partsForSend(
  text: string,
  attachments: readonly ComposerAttachment[],
): Part[] {
  const parts: Part[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    parts.push({ kind: "text", text: trimmed });
  }
  for (const file of attachments) {
    parts.push({
      kind: "file",
      name: file.name,
      mediaType: file.mediaType,
      data: file.data,
    });
  }
  return parts;
}

export function canSendComposer(
  text: string,
  attachments: readonly ComposerAttachment[],
): boolean {
  return text.trim().length > 0 || attachments.length > 0;
}

/**
 * Client-side attachment ceilings, kept under the platform's decoded-byte
 * limits (10 MiB per file / 30 MiB total) so a pick fails in the composer
 * rather than after a failed post.
 */
export const COMPOSER_ATTACHMENT_LIMITS = {
  maxCount: 5,
  maxPerFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 15 * 1024 * 1024,
} as const;

export type ComposerAttachmentLimits = {
  readonly maxCount: number;
  readonly maxPerFileBytes: number;
  readonly maxTotalBytes: number;
};

/** Size metadata available before FileReader runs (File.size). */
export type AttachmentPickCandidate = {
  readonly name: string;
  readonly size: number;
};

export type AttachmentValidationError =
  | { readonly kind: "count"; readonly max: number; readonly attempted: number }
  | {
      readonly kind: "perFile";
      readonly name: string;
      readonly size: number;
      readonly max: number;
    }
  | { readonly kind: "total"; readonly total: number; readonly max: number };

/**
 * Validate a multi-file pick against count, per-file, and total size limits
 * before any FileReader work. Failures are all-or-nothing for the pick.
 */
export function validateAttachmentPick(
  existingCount: number,
  existingTotalBytes: number,
  candidates: readonly AttachmentPickCandidate[],
  limits: ComposerAttachmentLimits = COMPOSER_ATTACHMENT_LIMITS,
): AttachmentValidationError | null {
  if (candidates.length === 0) return null;
  const attempted = existingCount + candidates.length;
  if (attempted > limits.maxCount) {
    return { kind: "count", max: limits.maxCount, attempted };
  }
  let addedBytes = 0;
  for (const file of candidates) {
    if (file.size > limits.maxPerFileBytes) {
      return {
        kind: "perFile",
        name: file.name,
        size: file.size,
        max: limits.maxPerFileBytes,
      };
    }
    addedBytes += file.size;
  }
  const total = existingTotalBytes + addedBytes;
  if (total > limits.maxTotalBytes) {
    return { kind: "total", total, max: limits.maxTotalBytes };
  }
  return null;
}

/** Decoded byte length of a standard base64 payload (padding-aware). */
export function base64DecodedByteLength(data: string): number {
  if (data.length === 0) return 0;
  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;
  return (data.length * 3) / 4 - padding;
}

export function attachmentBytesOnComposer(
  attachments: readonly ComposerAttachment[],
): number {
  let total = 0;
  for (const file of attachments) {
    total += base64DecodedByteLength(file.data);
  }
  return total;
}

function formatLimitMiB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function attachmentValidationMessage(
  error: AttachmentValidationError,
): string {
  switch (error.kind) {
    case "count":
      return CHAT_STRINGS.composerAttachmentCountError(error.max);
    case "perFile":
      return CHAT_STRINGS.composerAttachmentPerFileError(
        error.name,
        formatLimitMiB(error.max),
      );
    case "total":
      return CHAT_STRINGS.composerAttachmentTotalError(
        formatLimitMiB(error.max),
      );
  }
}

/** ArrowUp/Enter stay blocked while a send or file read is in flight. */
export function canSendComposerAction(
  text: string,
  attachments: readonly ComposerAttachment[],
  state: { readonly sending: boolean; readonly preparing: boolean },
): boolean {
  if (state.sending || state.preparing) return false;
  return canSendComposer(text, attachments);
}

/**
 * Whether the composer offers a Stop affordance (CL-7201) — a stand-in
 * for "is there a turn to cancel," reported by the host from its own
 * `isAwaitingReply` signal (the whole in-flight phase, including after
 * tokens have started streaming — not the tokenless `isPendingReply`
 * pulse). Deliberately independent of `sending`/
 * `preparing`: a follow-up message can still be typed and queued while a
 * turn runs (`turn-queue.ts` batches it), so Stop and Send coexist
 * rather than one gating the other.
 */
export function canStopComposer(state: { readonly running: boolean }): boolean {
  return state.running;
}

/** Attach stays blocked while a send or file read is in flight. */
export function canAttachComposer(state: {
  readonly sending: boolean;
  readonly preparing: boolean;
}): boolean {
  return !state.sending && !state.preparing;
}

/**
 * The send button's three visual states: `"empty"` (nothing to send —
 * muted and disabled), `"ready"` (content waiting — primary-orange and
 * enabled), `"sending"` (a send is in flight — primary but disabled, with
 * a spinner in place of the send glyph). Kept as a pure function of the
 * same inputs `canSendComposerAction` already reasons over, so the two
 * never drift on what counts as "there's something to send".
 */
export type ComposerSendVisualState = "empty" | "ready" | "sending";

export function composerSendVisualState(
  text: string,
  attachments: readonly ComposerAttachment[],
  state: { readonly sending: boolean },
): ComposerSendVisualState {
  if (state.sending) return "sending";
  return canSendComposer(text, attachments) ? "ready" : "empty";
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("expected a data URL from FileReader"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("failed to read attachment"));
    reader.readAsDataURL(file);
  });
}

let attachmentSeq = 0;

function nextAttachmentId(): string {
  attachmentSeq += 1;
  return `att_${attachmentSeq}`;
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    readonly agents: readonly MentionCandidate[];
    /** Every participant record (agent or human) the mention popover's
     * "Bring in…" group de-dupes against — omitted candidates are
     * already in the workbench. Defaults to empty. */
    readonly participants?: readonly ParticipantRecord[];
    /** Resolved agent display names (CL-6424) — the popover rows show
     * these, never raw handle slugs. */
    readonly agentDisplayNames?: AgentDisplayNames;
    /** Workspace members not yet in this workbench — the "Bring in…"
     * group's person half. Defaults to empty (no group rendered). */
    readonly members?: readonly BringInMember[];
    /** Invitable agent definitions — the "Bring in…" group's agent
     * half. Defaults to empty (no group rendered). */
    readonly invitableAgents?: readonly BringInAgentDefinition[];
    /**
     * Bring-in members/invitable queries failed — show this instead of an
     * honest-looking empty "No matches" / missing bring-in roster
     * (CL-6839). Null/omitted means those queries succeeded or are idle.
     */
    readonly bringInLoadError?: string | null;
    /** Resolves to whether the send succeeded; the composer decides draft/attachment cleanup from that. */
    readonly onSend: (payload: ComposerSendPayload) => Promise<boolean>;
    /** `/invite` — opens the invite-agent dialog. */
    readonly onInviteAgent: () => void;
    /** `/agents` — opens this workbench's settings, Agents section. */
    readonly onOpenAgentsSettings: () => void;
    /** `/routine` — opens the New Routine panel with this workbench
     * pre-bound as its destination. */
    readonly onCreateRoutineInSpace: () => void;
    /** Defaults to the generic workbench copy — a chat passes one naming its counterpart. */
    readonly placeholder?: string;
    /** Whether a turn is currently running for this workbench (CL-7201) —
     * typically the host's own `isAwaitingReply(streamingReply)`. Absent
     * or `false` renders no Stop affordance at all. */
    readonly running?: boolean;
    /**
     * Cancels the running turn — `POST .../turns/cancel`. Required
     * whenever `running` can be `true`; the composer never guesses at
     * how to stop a turn on its own. May return a promise: a rejection
     * re-enables the button immediately (the request itself failed —
     * network, a denied grant — not merely a slow cancel, so there is
     * no reason to make the person wait for `running` to change before
     * they can try again).
     */
    readonly onStop?: () => void | Promise<unknown>;
  }
>(function Composer(
  {
    agents,
    participants = [],
    members = [],
    invitableAgents = [],
    bringInLoadError = null,
    agentDisplayNames,
    onSend,
    onInviteAgent,
    onOpenAgentsSettings,
    onCreateRoutineInSpace,
    placeholder = CHAT_STRINGS.composerPlaceholder,
    running = false,
    onStop,
  },
  ref,
) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(
    [],
  );
  const [pendingInvites, setPendingInvites] = useState<
    readonly MentionInviteIntent[]
  >([]);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // CL-7201: guards Stop against a double-click firing two cancel
  // requests. A second cancel is harmless server-side (compare-and-set),
  // but there is no reason to send it. Resets once the host reports the
  // turn is no longer running -- not on a timer, since a slow cancel
  // (CL-7230's ceiling) must stay disabled rather than re-arm early.
  const [stopping, setStopping] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachGenerationRef = useRef(0);
  // `sending` is React state, set only after `onSend` has already been
  // awaited into — two calls to `performSend` inside one synchronous tick
  // (an Enter keydown and a click both firing before a render lands) would
  // both read `sending === false` and both post. This ref is set the
  // instant a send starts, synchronously ahead of any render, so a second
  // call in the same tick is turned away (CL-7198).
  const sendInFlightRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictatePrefixRef = useRef("");
  const dictateSuffixRef = useRef("");
  const [listening, setListening] = useState(false);
  const [dictateAvailable] = useState(
    () => speechRecognitionConstructor() !== null,
  );

  function stopDictation() {
    const rec = recognitionRef.current;
    if (rec === null) return;
    setListening(false);
    rec.stop();
  }

  function abortDictation() {
    const rec = recognitionRef.current;
    if (rec === null) return;
    recognitionRef.current = null;
    setListening(false);
    detachDictation(rec);
    try {
      rec.abort();
    } catch {
      // report-error-ignore: abort() after user Stop is InvalidStateError
      // once recognition has already ended.
    }
  }

  function applyDictationTranscript(transcript: string) {
    const next = spliceDictationTranscript(
      dictatePrefixRef.current,
      dictateSuffixRef.current,
      transcript,
    );
    setValue(next.text);
    syncComposerSuggestState(next.text, next.caret);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  function startDictation() {
    abortDictation();
    const Ctor = speechRecognitionConstructor();
    if (Ctor === null) return;
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? value.length;
    dictatePrefixRef.current = value.slice(0, caret);
    dictateSuffixRef.current = value.slice(caret);
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      applyDictationTranscript(transcriptFromSpeechResults(event.results));
    };
    rec.onerror = (event) => {
      const code = speechRecognitionErrorCode(event);
      if (code === null || !isBenignSpeechRecognitionError(code)) {
        reportError(event, { operation: "composer.dictate" });
      }
      if (recognitionRef.current === rec) {
        recognitionRef.current = null;
        setListening(false);
      }
    };
    rec.onend = () => {
      if (recognitionRef.current !== rec) return;
      setListening(false);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (cause) {
      reportError(cause, { operation: "composer.dictate.start" });
      recognitionRef.current = null;
    }
  }

  function toggleDictation() {
    if (listening) {
      stopDictation();
      return;
    }
    startDictation();
  }

  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);

  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec === null) return;
      detachDictation(rec);
      recognitionRef.current = null;
      rec.abort();
    };
  }, []);

  /** Auto-grow: the textarea reports its own content height, so the
   * measurement resets to the CSS-declared min-height before reading
   * `scrollHeight` — otherwise a shrinking draft would get stuck at its
   * tallest-ever height. Growth caps out at the CSS max-height, where
   * `overflow-y` takes over for scrolling. */
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  function syncComposerSuggestState(text: string, caret: number) {
    setHelpOpen(false);
    const openSlash = activeSlashQuery(text, caret);
    if (openSlash !== null) {
      setSlash(openSlash);
      setSlashHighlight(0);
      setMention(null);
      return;
    }
    setSlash(null);
    const openMention = activeMentionQuery(text, caret);
    setMention(openMention);
    setHighlight(0);
  }

  useImperativeHandle(
    ref,
    () => ({
      insertText: (text: string) => {
        abortDictation();
        const textarea = textareaRef.current;
        const caret = textarea?.selectionStart ?? value.length;
        const result = insertTextAtCaret(value, caret, text);
        setValue(result.text);
        requestAnimationFrame(() => {
          textarea?.focus();
          textarea?.setSelectionRange(result.caret, result.caret);
        });
      },
      setText: (text: string) => {
        abortDictation();
        attachGenerationRef.current += 1;
        setValue(text);
        setMention(null);
        setSlash(null);
        setHelpOpen(false);
        setPendingInvites([]);
        setAttachments([]);
        setErrorMessage(null);
        setPreparing(false);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          textarea?.focus();
          textarea?.setSelectionRange(text.length, text.length);
        });
      },
    }),
    [value],
  );

  const mentionOptions: readonly MentionOption[] =
    mention !== null
      ? filterMentionOptions(
          mentionOptionsFromWorkbench(
            participants,
            members,
            invitableAgents,
            agentDisplayNames,
          ),
          mention.query,
        )
      : [];
  const slashCandidates =
    slash !== null ? filterSlashCommands(slash.query) : [];
  const busy = { sending, preparing };
  const canSend = canSendComposerAction(value, attachments, busy);
  const canAttach = canAttachComposer(busy);
  const sendVisualState = composerSendVisualState(value, attachments, {
    sending,
  });

  /**
   * Fires the send and tracks its flight for the button's spinner —
   * nothing here decides what the timeline shows on success or failure.
   * The host owns that: it adds an optimistic pending bubble the instant
   * the payload leaves the composer, then resolves or fails it in place,
   * so a failed send never comes back here to repopulate the draft —
   * recovering the text is the pending bubble's own Discard action.
   */
  async function performSend(payload: ComposerSendPayload): Promise<void> {
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setErrorMessage(null);
    try {
      await onSend(payload);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  function runSlashCommand(command: SlashCommandSpec) {
    switch (command.id) {
      case "invite":
        onInviteAgent();
        return;
      case "agents":
        onOpenAgentsSettings();
        return;
      case "routine":
        onCreateRoutineInSpace();
        return;
      case "summarize":
        void summarizeThread();
        return;
      case "help":
        setHelpOpen(true);
        return;
    }
  }

  function chooseSlash(command: SlashCommandSpec) {
    setValue("");
    setSlash(null);
    setSlashHighlight(0);
    runSlashCommand(command);
  }

  /** The mock's own honest macro: no server-side "/summarize" exists, so
   * this addresses the workbench's actual first agent participant the same
   * way a person would type the mention by hand. */
  async function summarizeThread() {
    const target = agents[0];
    if (target === undefined) {
      setErrorMessage(CHAT_STRINGS.composerSummarizeNoAgentError);
      return;
    }
    if (sending || preparing) return;
    await performSend({
      text: `@${target.handle} summarize this thread`,
      attachments: [],
    });
  }

  /**
   * Splices the picked candidate's handle into the draft exactly as
   * before; a bring-in pick (one carrying `invite`) additionally records
   * its invite intent (de-duplicated by kind+id) so `send()` carries it
   * through to the server's pre-invite step.
   */
  function pickMention(option: MentionOption) {
    const textarea = textareaRef.current;
    if (mention === null || textarea === null) return;
    const caret = textarea.selectionStart;
    const result = insertMention(
      value,
      caret,
      mention,
      option.candidate.handle,
    );
    setValue(result.text);
    setMention(null);
    if (option.invite !== undefined) {
      const invite = option.invite;
      setPendingInvites((current) => {
        const key =
          invite.kind === "agent"
            ? `agent:${invite.definitionId}`
            : `person:${invite.principalId}`;
        const alreadyPending = current.some(
          (pending) =>
            (pending.kind === "agent"
              ? `agent:${pending.definitionId}`
              : `person:${pending.principalId}`) === key,
        );
        return alreadyPending ? current : [...current, invite];
      });
    }
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.caret, result.caret);
    });
  }

  function resetFileInput() {
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = "";
    }
  }

  async function addFiles(fileList: FileList | null) {
    if (fileList === null || fileList.length === 0) return;
    if (!canAttachComposer({ sending, preparing })) return;

    const files = Array.from(fileList);
    const generation = attachGenerationRef.current;
    const validation = validateAttachmentPick(
      attachments.length,
      attachmentBytesOnComposer(attachments),
      files.map((file) => ({ name: file.name, size: file.size })),
    );
    if (validation !== null) {
      setErrorMessage(attachmentValidationMessage(validation));
      resetFileInput();
      return;
    }

    setPreparing(true);
    setErrorMessage(null);
    try {
      const next: ComposerAttachment[] = [];
      for (const file of files) {
        const data = await readFileAsBase64(file);
        next.push({
          id: nextAttachmentId(),
          name: file.name,
          mediaType:
            file.type.length > 0 ? file.type : "application/octet-stream",
          data,
        });
      }
      // All-or-nothing: only commit once every file in the pick has read.
      if (attachGenerationRef.current !== generation) return;
      setAttachments((previous) => [...previous, ...next]);
    } catch {
      if (attachGenerationRef.current !== generation) return;
      setErrorMessage(CHAT_STRINGS.composerAttachmentReadError);
    } finally {
      if (attachGenerationRef.current === generation) {
        setPreparing(false);
      }
      resetFileInput();
    }
  }

  function removeAttachment(id: string) {
    setAttachments((previous) => previous.filter((file) => file.id !== id));
  }

  /**
   * The draft leaves the box the instant it's handed off, win or lose —
   * the host's optimistic pending bubble is now the one place that text
   * lives until the send actually resolves. A failure never repopulates
   * this box; the bubble's Discard action is the only way text comes
   * back here (see `ComposerHandle.insertText`, the same seam the
   * profile card's Mention action uses).
   */
  async function send() {
    if (!canSendComposerAction(value, attachments, { sending, preparing })) {
      return;
    }
    abortDictation();
    const payload: ComposerSendPayload =
      pendingInvites.length > 0
        ? { text: value, attachments, invite: pendingInvites }
        : { text: value, attachments };
    setValue("");
    setAttachments([]);
    setMention(null);
    setPendingInvites([]);
    await performSend(payload);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (helpOpen && event.key === "Escape") {
      event.preventDefault();
      setHelpOpen(false);
      return;
    }
    if (slash !== null && slashCandidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashHighlight((index) => (index + 1) % slashCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashHighlight(
          (index) =>
            (index - 1 + slashCandidates.length) % slashCandidates.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = slashCandidates[slashHighlight];
        if (chosen !== undefined) chooseSlash(chosen);
        return;
      }
      if (event.key === "Escape") {
        setSlash(null);
        return;
      }
    }
    if (mention !== null && mentionOptions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((index) => (index + 1) % mentionOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight(
          (index) =>
            (index - 1 + mentionOptions.length) % mentionOptions.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = mentionOptions[highlight];
        if (chosen !== undefined) pickMention(chosen);
        return;
      }
      if (event.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    void addFiles(event.target.files);
  }

  function handleStop() {
    if (stopping || onStop === undefined) return;
    setStopping(true);
    // CL-7201 (Critique finding): a rejected stop request is a FAILED
    // cancel, not a slow one -- the `useEffect` above only re-enables
    // once the host reports `running` has gone false, which never
    // happens for a request that never reached the server. Without
    // this catch the button stayed disabled for the rest of the turn's
    // life with no way to retry.
    Promise.resolve(onStop()).catch(() => setStopping(false));
  }

  return (
    <div className="chat-composer">
      {slash !== null && (
        <div className="chat-mention-popover chat-popover-enter" role="listbox">
          {slashCandidates.length === 0 ? (
            <div className="chat-mention-empty">
              {CHAT_STRINGS.composerSlashEmpty}
            </div>
          ) : (
            slashCandidates.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === slashHighlight}
                className="chat-mention-option"
                data-highlighted={index === slashHighlight}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseSlash(command);
                }}
              >
                <span className="chat-mention-handle">{command.name}</span>
                <span className="chat-mention-label">
                  {command.description}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      {slash === null && mention !== null && (
        <div className="chat-mention-popover chat-popover-enter" role="listbox">
          {mentionOptions.length === 0 ? (
            <div
              className="chat-mention-empty"
              {...(bringInLoadError !== null ? { role: "alert" as const } : {})}
            >
              {bringInLoadError ?? CHAT_STRINGS.mentionEmpty}
            </div>
          ) : (
            <div className="chat-mention-list">
              {bringInLoadError !== null ? (
                <div className="chat-mention-empty" role="alert">
                  {bringInLoadError}
                </div>
              ) : null}
              {mentionOptions.map((option, index) => {
                const prev = mentionOptions[index - 1];
                const showSection =
                  index === 0 || prev?.section !== option.section;
                const isAgent = option.section === "agents";
                return (
                  <div key={`${option.section}:${option.candidate.id}`}>
                    {showSection ? (
                      <div className="chat-mention-group-label">
                        {option.section === "agents"
                          ? CHAT_STRINGS.mentionAgentsGroupLabel
                          : CHAT_STRINGS.mentionPeopleGroupLabel}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlight}
                      className="chat-mention-option"
                      data-highlighted={index === highlight}
                      data-mention-section={option.section}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        pickMention(option);
                      }}
                    >
                      {isAgent ? (
                        <CorbitAvatar
                          ariaLabel={option.candidate.label}
                          size="sm"
                          className="mention-avatar"
                        />
                      ) : (
                        <Avatar
                          initials={option.candidate.label}
                          label={option.candidate.label}
                          tone="neutral"
                          size="sm"
                          className={`mention-avatar ${avatarClassForPrincipal(option.candidate.id)}`}
                        />
                      )}
                      <span className="chat-mention-meta">
                        <span className="chat-mention-name">
                          {option.candidate.label}
                        </span>
                        <span className="chat-mention-handle">
                          @{option.candidate.handle}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {helpOpen && (
        <div
          className="chat-mention-popover chat-slash-help chat-popover-enter"
          role="note"
        >
          <div className="chat-slash-help-title">
            {CHAT_STRINGS.composerHelpTitle}
          </div>
          {SLASH_COMMANDS.map((command) => (
            <div key={command.id} className="chat-mention-option">
              <span className="chat-mention-handle">{command.name}</span>
              <span className="chat-mention-label">{command.description}</span>
            </div>
          ))}
          <div className="chat-slash-help-footer">
            <span className="chat-slash-help-note">
              {CHAT_STRINGS.composerHelpNote}
            </span>
            <button
              type="button"
              className="chat-slash-help-close"
              onMouseDown={(event) => {
                event.preventDefault();
                setHelpOpen(false);
              }}
            >
              {CHAT_STRINGS.composerHelpClose}
            </button>
          </div>
        </div>
      )}
      <div className="chat-composer-row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="chat-composer-file-input"
          onChange={handleFileChange}
          tabIndex={-1}
          aria-hidden="true"
        />
        {attachments.length > 0 && (
          <ul
            className="chat-composer-attachments"
            aria-label={CHAT_STRINGS.composerAttachmentsLabel}
          >
            {attachments.map((file) => (
              <li key={file.id} className="chat-composer-attachment">
                <span className="chat-composer-attachment-name">
                  {file.name}
                </span>
                <button
                  type="button"
                  className="chat-composer-attachment-remove"
                  aria-label={CHAT_STRINGS.composerRemoveAttachment(file.name)}
                  onClick={() => removeAttachment(file.id)}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          className="chat-composer-input"
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            setValue(event.target.value);
            syncComposerSuggestState(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          readOnly={listening}
          rows={1}
        />
        <div className="chat-composer-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="chat-composer-icon-button"
            disabled={!canAttach}
            onClick={() => fileInputRef.current?.click()}
            aria-label={CHAT_STRINGS.composerAttach}
          >
            <Paperclip />
          </Button>
          <span
            className="chat-composer-keyboard-hint"
            data-visible={focused && value.trim().length > 0}
            aria-hidden={!(focused && value.trim().length > 0)}
          >
            {CHAT_STRINGS.composerKeyboardHint}
          </span>
          <div className="chat-composer-submit-actions">
            {dictateAvailable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="chat-composer-icon-button chat-composer-mic"
                data-listening={listening ? "true" : "false"}
                aria-pressed={listening}
                disabled={sending || preparing}
                onClick={toggleDictation}
                aria-label={
                  listening
                    ? CHAT_STRINGS.composerDictateStop
                    : CHAT_STRINGS.composerDictate
                }
                title={
                  listening
                    ? CHAT_STRINGS.composerDictateStop
                    : CHAT_STRINGS.composerDictate
                }
              >
                <Microphone aria-hidden="true" />
              </Button>
            ) : null}
            {canStopComposer({ running }) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="chat-composer-icon-button"
                disabled={stopping}
                onClick={handleStop}
                aria-label={CHAT_STRINGS.composerStop}
                title={CHAT_STRINGS.composerStop}
              >
                <Stop aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant={sendVisualState === "empty" ? "ghost" : "primary"}
              size="sm"
              className="chat-composer-icon-button"
              disabled={!canSend}
              data-send-state={sendVisualState}
              onClick={() => void send()}
              aria-label={
                sending
                  ? CHAT_STRINGS.composerSending
                  : CHAT_STRINGS.composerSend
              }
              title={
                sending
                  ? CHAT_STRINGS.composerSending
                  : CHAT_STRINGS.composerSend
              }
            >
              {sendVisualState === "sending" ? (
                <CircleNotch
                  className="chat-composer-send-spinner"
                  aria-hidden="true"
                />
              ) : (
                <ArrowUp aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      </div>
      <div
        className="chat-composer-status"
        aria-live="polite"
        aria-atomic="true"
      >
        {preparing ? CHAT_STRINGS.composerPreparing : null}
      </div>
      {errorMessage !== null && (
        <div className="chat-composer-error" role="alert">
          {errorMessage}
        </div>
      )}
    </div>
  );
});
