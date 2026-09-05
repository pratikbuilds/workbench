// Column 4: the optional canvas. Collapsed, it takes no space at all — the
// main pane gets the width back — and open, it hosts targeted auxiliary
// content: profile cards, and (CL-5938) typed artifact renderers opened
// from a chat artifact chip or the Library page. Primary workbench
// conversation lives in the main stage, not here.
//
// CL-5958 phase 1 added a co-viewer cursor overlay on top of the
// read-only renderer, driven by `@corbits/presence/client` in
// `app-shell.tsx` and handed down here as plain `PresenceCursor` data.
// Phase 2 adds real co-editing for text-kind artifacts: when the host
// hands down a `doc` (a `Y.Doc` already synced over presence) alongside
// `artifact.canEdit`, the pane renders `@corbits/artifact-ui`'s
// `ArtifactTextEditor` instead of the read-only `ArtifactRenderer`. Every
// other kind, and every artifact without a `doc`, stays exactly as
// read-only as phase 1 left it — this module still never imports
// `@corbits/presence` itself, only plain data and a `Y.Doc` handle.
//
// The collapse/expand motion lives entirely in `shell.css` as a CSS
// transition on `transform`/`opacity` (plus width, so the main pane
// actually reflows) triggered by the `data-open` attribute — never a JS
// animation — so rapid toggling is inherently interruptible: the browser
// just reverses whichever transition is already in flight, there is no
// queue to get stuck. `prefers-reduced-motion` is handled the same way, in
// CSS, by shortening the transition to near-zero.

import {
  Button,
  EmptyState,
  ProfileCard,
  toast,
  type ProfileCardAction,
  // vendor noun: channel — @corbits/react-ui's own `ProfileCardChannel`,
  // published from a separate repo, not part of this rename.
  type ProfileCardChannel,
} from "@corbits/react-ui";
import {
  ArtifactRenderer,
  ArtifactTextEditor,
  type ArtifactSaveState,
} from "@corbits/artifact-ui";
import type { ProfileSubject, SharedWorkbenchSummary } from "@corbits/chat-ui";
import {
  ArrowsIn,
  ArrowsOut,
  ArrowSquareOut,
  CaretLeft,
  UserCircle,
  X,
} from "@corbits/icons";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type * as Y from "yjs";

import { useBench } from "../bench-context";
import type { PresenceConnection } from "../presence/use-presence-room";
import { workbenchPath } from "../workbench-path";
import { ensureProfileDm, loadSharedWorkbenches } from "../profile-relations";
import type {
  CanvasArtifactContent,
  RoutinePanelSubject,
} from "./canvas-availability";
import { useInsertIntoComposer } from "./composer-insertion";

/**
 * One co-viewer's cursor, in the artifact pane's own fractional coordinate
 * space (`x`/`y` in `[0, 1]` of the pane's content box) so it survives a
 * pane resize between the moment it was published and the moment it
 * renders. Plain data — the same reasoning as `PresenceMember` in
 * `@corbits/chat-ui`: this module never depends on `@corbits/presence`.
 */
export interface PresenceCursor {
  readonly principalId: string;
  readonly displayName: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
}

export function CanvasColumn({
  open,
  profile,
  artifact,
  focus,
  onClose,
  onToggleFocus,
  onNavigate,
  presenceCursors,
  onCursorMove,
  artifactDoc,
  artifactSaveState,
  onArtifactTyping,
  presenceConnection = "ok",
}: {
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly artifact: CanvasArtifactContent | null;
  readonly routine: RoutinePanelSubject | null;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
  readonly onNavigate: (path: string) => void;
  /** Co-viewers currently looking at `artifact`, if any — see `PresenceCursor`. */
  readonly presenceCursors?: readonly PresenceCursor[];
  /** Fired with the pointer's fractional position over the artifact body
   * (see `PresenceCursor`'s own doc) as it moves — the host publishes it
   * through `@corbits/presence/client`. */
  readonly onCursorMove?: (x: number, y: number) => void;
  /** The shared `Y.Doc` for a "doc"-kind `artifact`, already synced over
   * presence. Its presence alone decides whether the pane shows the
   * live-updating `ArtifactTextEditor` at all (vs. the static
   * `ArtifactRenderer`) — `artifact.canEdit` separately decides whether
   * that editor accepts keystrokes or is itself read-only. Absent for
   * every other renderer kind, and briefly absent for a "doc" artifact
   * whose presence connection hasn't handed over a doc yet. */
  readonly artifactDoc?: Y.Doc;
  /** The honest save-state line for `artifactDoc` — see `ArtifactSaveState`. */
  readonly artifactSaveState?: ArtifactSaveState;
  /** Fired on local typing start/stop in the text editor, for the host to publish through presence's `typing` awareness field. */
  readonly onArtifactTyping?: (typing: boolean) => void;
  /** Quiet reconnecting caption when presence has failed more than once. */
  readonly presenceConnection?: PresenceConnection;
}) {
  // `inert` rather than `aria-hidden`: a collapsed column has to be out of
  // both the accessibility tree and the tab order, and `aria-hidden` alone
  // only does the first — a focusable descendant inside an `aria-hidden`
  // subtree is an ARIA violation, and the browser moves focus out of an
  // `inert` subtree for us when it closes.
  return (
    <div
      className="shell-canvas-column"
      data-open={open}
      data-focus={focus}
      inert={!open}
    >
      <div className="shell-canvas-inner">
        {profile !== null ? (
          <ProfileCanvasPane
            profile={profile}
            focus={focus}
            onClose={onClose}
            onToggleFocus={onToggleFocus}
            onNavigate={onNavigate}
          />
        ) : artifact !== null ? (
          <ArtifactCanvasPane
            artifact={artifact}
            focus={focus}
            onClose={onClose}
            onToggleFocus={onToggleFocus}
            {...(presenceCursors !== undefined ? { presenceCursors } : {})}
            {...(onCursorMove !== undefined ? { onCursorMove } : {})}
            {...(artifactDoc !== undefined ? { artifactDoc } : {})}
            {...(artifactSaveState !== undefined ? { artifactSaveState } : {})}
            {...(onArtifactTyping !== undefined ? { onArtifactTyping } : {})}
            presenceConnection={presenceConnection}
          />
        ) : (
          <EmptyState
            icon={<UserCircle />}
            title="Nothing open"
            description="Profiles and artifacts open here when you need them."
          />
        )}
      </div>
    </div>
  );
}

/**
 * Open-or-create the DM with `profile` and land on it. `tenantId === null`
 * (bench not resolved yet) has nothing to message against — an honest toast,
 * matching `mentionAction`'s pattern, rather than a silent no-op. The panel
 * only closes once the DM is actually resolved: `setPending` drives the
 * button's in-flight label so a slow create isn't mistaken for nothing
 * having happened.
 */
function messageAction(
  tenantId: string | null,
  profile: ProfileSubject,
  onNavigate: (path: string) => void,
  onClose: () => void,
  setPending: (pending: boolean) => void,
): () => void {
  return () => {
    if (tenantId === null) {
      toast(`Open a workbench to message @${profile.handle}`);
      return;
    }
    setPending(true);
    void ensureProfileDm(tenantId, profile).then((result) => {
      setPending(false);
      if (result.kind === "ready") {
        onNavigate(workbenchPath(result.workbenchId));
        onClose();
      } else {
        toast(result.message);
      }
    });
  };
}

/** Insert `@handle` into whichever workbench's composer is on screen — an
 * honest "nothing to mention into" toast when none is (CL-5914: no workbench
 * open, or the settings surface is showing instead of a conversation). */
function mentionAction(
  profile: ProfileSubject,
  insertIntoComposer: (text: string) => boolean,
): () => void {
  return () => {
    const inserted = insertIntoComposer(`@${profile.handle} `);
    if (!inserted) {
      toast(`Open a conversation to mention @${profile.handle}`);
    }
  };
}

/** Shared header row for every canvas pane: an optional leading back
 * control, an optional title, an optional pane-specific `trailing` slot,
 * and — for the panes that use them — the mock's focus-cycle control and
 * its explicit close. `onBack` and the focus/close controls are mutually
 * exclusive in practice (a pane is either master-detail-driven, like the
 * routine pane, or focus/close-driven, like profile and artifact), but
 * both are optional so this one component covers every canvas pane's
 * header rather than each pane hand-rolling its own. */
export function CanvasPaneHeader({
  title,
  onBack,
  focus,
  onClose,
  onToggleFocus,
  previewSrc,
  trailing,
  className,
}: {
  readonly title?: string;
  /** Present for the routine pane's master-detail chrome: a back chevron
   * in place of the focus/close controls profile and artifact use. */
  readonly onBack?: () => void;
  readonly focus?: boolean;
  readonly onClose?: () => void;
  readonly onToggleFocus?: () => void;
  /** When set (an `"html"`-kind artifact with a resolved preview route),
   * adds an "Open in new tab" action pointed at the same sandboxed URL the
   * pane's iframe already loads. */
  readonly previewSrc?: string;
  /** Extra trailing content specific to one pane (the routine list's
   * "Runs" shortcut, or the editor's save-state label), rendered before
   * any shared focus/close controls. */
  readonly trailing?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={
        className === undefined
          ? "shell-canvas-pane-header"
          : `shell-canvas-pane-header ${className}`
      }
    >
      <div className="shell-canvas-pane-heading">
        {onBack !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            aria-label="Back"
            title="Back"
          >
            <CaretLeft />
          </Button>
        ) : null}
        {title !== undefined ? (
          <span className="shell-canvas-pane-title">{title}</span>
        ) : null}
      </div>
      <div className="shell-canvas-pane-actions">
        {trailing}
        {previewSrc !== undefined ? (
          <Button variant="ghost" size="sm" asChild>
            <a href={previewSrc} target="_blank" rel="noreferrer">
              <ArrowSquareOut aria-hidden="true" />
              Open in new tab
            </a>
          </Button>
        ) : null}
        {onToggleFocus !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleFocus}
            aria-label={focus === true ? "Exit focus" : "Focus"}
            title={focus === true ? "Exit focus" : "Focus"}
          >
            {focus === true ? <ArrowsIn /> : <ArrowsOut />}
          </Button>
        ) : null}
        {onClose !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function profileActions(
  profile: ProfileSubject,
  tenantId: string | null,
  onClose: () => void,
  onNavigate: (path: string) => void,
  insertIntoComposer: (text: string) => boolean,
  messagePending: boolean,
  setMessagePending: (pending: boolean) => void,
): readonly ProfileCardAction[] {
  const message: ProfileCardAction = {
    id: "message",
    label: messagePending ? "Messaging…" : "Message",
    tone: "primary",
    onClick: messageAction(
      tenantId,
      profile,
      onNavigate,
      onClose,
      setMessagePending,
    ),
  };
  const mention: ProfileCardAction = {
    id: "mention",
    label: "Mention",
    tone: "outline",
    onClick: () => {
      mentionAction(profile, insertIntoComposer)();
      onClose();
    },
  };

  // Pause has no backing API today (CL-5884 follow-up: no workflow-run
  // pause endpoint exists anywhere in the hub) — omitted rather than left
  // as a no-op that pretends to do something.
  if (profile.kind === "agent") {
    // No "Edit agent" hop here: `ProfileSubject` (chat-ui's
    // `profile-subject.ts`) carries only address/handle/displayName, never
    // a workbench id, so this card has no way to resolve the agent's own
    // workbench settings. The global `/settings/agents` tab this used to
    // target is gone — rather than hop to a dead route, the action is
    // dropped until a subject carries enough context to land somewhere real.
    return [
      message,
      mention,
      {
        id: "view-runs",
        label: "View runs",
        tone: "outline",
        onClick: () => {
          onClose();
          onNavigate("/insights");
        },
      },
    ];
  }

  // No "Grants" hop here: settings-ui's Grants section has no deep-link
  // filter to land on this person's rules specifically, and a profile
  // card action that lands on the unfiltered, everyone's-rules list is
  // worse than not offering it — same reasoning the agent branch above
  // uses to drop "Edit agent".
  return [
    message,
    mention,
    {
      id: "view-activity",
      label: "View activity",
      tone: "outline",
      onClick: () => {
        onClose();
        onNavigate("/insights");
      },
    },
  ];
}

function toProfileCardWorkbenches(
  workbenches: readonly SharedWorkbenchSummary[],
): readonly ProfileCardChannel[] {
  return workbenches.map((workbench) => ({
    id: workbench.id,
    name: workbench.title,
    href: workbenchPath(workbench.id),
  }));
}

/** Shared workbenches between the viewer and `profile` (CL-5919) — refetched
 * whenever the open profile changes, dropped if a later change races past
 * an in-flight fetch. Pinned skills are intentionally never populated: no
 * agent carries any real skill-attachment data yet (tracked in CL-5991), so
 * showing them would be fabricated, not deferred. */
function useSharedWorkbenches(
  tenantId: string | null,
  viewerPrincipalId: string | null,
  profile: ProfileSubject,
): readonly SharedWorkbenchSummary[] {
  const [workbenches, setWorkbenches] = useState<
    readonly SharedWorkbenchSummary[]
  >([]);

  useEffect(() => {
    setWorkbenches([]);
    if (tenantId === null || viewerPrincipalId === null) return;
    let cancelled = false;
    void loadSharedWorkbenches(tenantId, viewerPrincipalId, profile).then(
      (result) => {
        if (!cancelled) setWorkbenches(result);
      },
      () => {
        if (!cancelled) setWorkbenches([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId, viewerPrincipalId, profile.address]);

  return workbenches;
}

function ProfileCanvasPane({
  profile,
  focus,
  onClose,
  onToggleFocus,
  onNavigate,
}: {
  readonly profile: ProfileSubject;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const insertIntoComposer = useInsertIntoComposer();
  const [messagePending, setMessagePending] = useState(false);
  // A new subject means any in-flight "Messaging…" belonged to the last one.
  useEffect(() => {
    setMessagePending(false);
  }, [profile.address]);
  const sharedWorkbenches = useSharedWorkbenches(
    selectedTenantId,
    selectedPrincipalId,
    profile,
  );

  return (
    <div className="shell-profile-pane">
      <CanvasPaneHeader
        focus={focus}
        onClose={onClose}
        onToggleFocus={onToggleFocus}
      />
      <ProfileCard
        name={profile.displayName}
        subtitle={`@${profile.handle}`}
        initials={profile.initials}
        statusLabel={profile.kind === "agent" ? "Agent" : "Member"}
        avatarTone={profile.kind === "agent" ? "agent" : "neutral"}
        actions={profileActions(
          profile,
          selectedTenantId,
          onClose,
          onNavigate,
          insertIntoComposer,
          messagePending,
          setMessagePending,
        )}
        sharedChannels={toProfileCardWorkbenches(sharedWorkbenches)}
      />
    </div>
  );
}

/**
 * Whether this render shows `ArtifactTextEditor` instead of the static
 * `ArtifactRenderer`: the artifact has to be a text kind AND have an
 * actual synced `Y.Doc` — before the presence connection hands one over,
 * even a `canEdit` artifact renders through the static (but honestly
 * inert) renderer rather than an editor bound to nothing. Whether the
 * resulting pane is interactive is `artifact.canEdit`, checked
 * separately: a viewer without write access still gets the live-updating
 * `ArtifactTextEditor` in its own `readOnly` mode (requirement: read-only
 * viewers see live updates too, not just a stale fetch), just with
 * keystrokes ignored.
 */
function showsTextEditor(
  artifact: CanvasArtifactContent,
  doc: Y.Doc | undefined,
): doc is Y.Doc {
  return artifact.rendererKind === "doc" && doc !== undefined;
}

function ArtifactCanvasPane({
  artifact,
  focus,
  onClose,
  onToggleFocus,
  presenceCursors = [],
  onCursorMove,
  artifactDoc,
  artifactSaveState = { kind: "read-only" },
  onArtifactTyping,
  presenceConnection = "ok",
}: {
  readonly artifact: CanvasArtifactContent;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
  readonly presenceCursors?: readonly PresenceCursor[];
  readonly onCursorMove?: (x: number, y: number) => void;
  readonly artifactDoc?: Y.Doc;
  readonly artifactSaveState?: ArtifactSaveState;
  readonly onArtifactTyping?: (typing: boolean) => void;
  readonly presenceConnection?: PresenceConnection;
}) {
  const showEditor = showsTextEditor(artifact, artifactDoc);
  return (
    <div className="shell-artifact-pane">
      <CanvasPaneHeader
        title={artifact.title}
        focus={focus}
        onClose={onClose}
        onToggleFocus={onToggleFocus}
        {...(artifact.previewSrc !== undefined
          ? { previewSrc: artifact.previewSrc }
          : {})}
        {...(presenceConnection === "degraded"
          ? {
              trailing: (
                <span
                  className="shell-artifact-presence-status"
                  aria-live="polite"
                >
                  Reconnecting…
                </span>
              ),
            }
          : {})}
      />
      <div
        className="shell-artifact-pane-body"
        onPointerMove={
          onCursorMove === undefined
            ? undefined
            : (event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                if (bounds.width === 0 || bounds.height === 0) return;
                onCursorMove(
                  (event.clientX - bounds.left) / bounds.width,
                  (event.clientY - bounds.top) / bounds.height,
                );
              }
        }
      >
        {showEditor ? (
          <ArtifactTextEditor
            doc={artifactDoc}
            title={artifact.title}
            readOnly={!artifact.canEdit}
            saveState={artifactSaveState}
            {...(onArtifactTyping !== undefined
              ? { onLocalTyping: onArtifactTyping }
              : {})}
          />
        ) : (
          <ArtifactRenderer
            rendererKind={artifact.rendererKind}
            title={artifact.title}
            content={artifact.content}
            {...(artifact.unavailableReason !== undefined
              ? { unavailableReason: artifact.unavailableReason }
              : {})}
            {...(artifact.previewSrc !== undefined
              ? { previewSrc: artifact.previewSrc }
              : {})}
          />
        )}
        {presenceCursors.length > 0 ? (
          <div className="shell-artifact-cursor-layer" aria-hidden="true">
            {presenceCursors.map((cursor) => (
              <div
                key={cursor.principalId}
                className="shell-artifact-cursor"
                style={{
                  left: `${cursor.x * 100}%`,
                  top: `${cursor.y * 100}%`,
                  color: cursor.color,
                }}
              >
                <span className="shell-artifact-cursor-dot" />
                <span className="shell-artifact-cursor-label">
                  {cursor.displayName}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
