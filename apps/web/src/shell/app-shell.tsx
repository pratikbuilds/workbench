// The app frame: one sidebar (the workbench list and shared chrome — see
// `sidebar.tsx`), the main pane a route renders into, and the optional
// canvas. Every route in `../routes.tsx` mounts inside this same frame —
// there is no per-route shell variant and no sidebar collapse. The
// conversation lives in the main stage; the canvas is auxiliary (profiles
// and similar) and opens on use, then closes internally.
//
// Canvas state is NOT owned here — it has to be visible to the command
// palette too (a sibling of this component, not a descendant — see
// `shell-chrome-provider.tsx`), so `ShellChromeProvider` owns it above both
// and this component only reads it through the same hooks page code
// already uses.

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Y from "yjs";
import type { ArtifactSaveState } from "@corbits/artifact-ui";

import { WorkbenchLoadingState } from "@corbits/chat-ui";

import { usePendingApprovalCount } from "../pending-approvals";
import { useBench } from "../bench-context";
import { useNavigate } from "../navigation";
import { usePresenceRoom } from "../presence/use-presence-room";
import { APP_ROUTES, matchesRoute } from "../routes";
import type { SessionUser } from "../session";
import { StageTopBar } from "./stage-top-bar";
import { useScrollReset } from "@corbits/shell-layout";
import {
  useCanvasColumnArtifact,
  useCanvasColumnAvailable,
  useCanvasColumnFocus,
  useCanvasColumnOpen,
  useCanvasColumnProfile,
  useCanvasColumnRoutine,
  useCloseCanvas,
  useToggleCanvasFocus,
} from "./canvas-availability";
import { ProviderHealthBanner } from "./provider-health-banner";
import { Sidebar } from "./sidebar";
import { ShellContextMenu } from "./context-menu/shell-context-menu";

const CanvasColumn = lazy(async () => ({
  default: (await import("./canvas-column")).CanvasColumn,
}));

/** True only for the one route that never renders its own `StageTopBar`
 * (see `AppRoute.hasStageTopBar`'s doc) — everything else titles its own
 * stage, so this stays false for the rest. */
function routeHasNoStageTopBar(path: string): boolean {
  const route = APP_ROUTES.find((candidate) =>
    matchesRoute(candidate.path, path),
  );
  return route?.hasStageTopBar === false;
}

function routeLabel(path: string): string {
  const route = APP_ROUTES.find((candidate) =>
    matchesRoute(candidate.path, path),
  );
  return route?.label ?? "Workbench";
}

export function AppShell({
  path,
  user,
  onSignOut,
  children,
}: {
  readonly path: string;
  readonly user: SessionUser;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  const canvasAllowed = useCanvasColumnAvailable();
  const canvasOpen = useCanvasColumnOpen();
  const canvasProfile = useCanvasColumnProfile();
  const canvasArtifact = useCanvasColumnArtifact();
  const canvasRoutine = useCanvasColumnRoutine();
  const canvasFocus = useCanvasColumnFocus();
  const { selectedTenantId: tenantId, selectedPrincipalId: viewerPrincipalId } =
    useBench();

  // A text-kind artifact's shared `Y.Doc` (CL-5958 phase 2): one instance
  // per artifact id, torn down and replaced the moment the open artifact
  // changes so a stale doc from a previous artifact can never leak into a
  // newly opened one. Non-"doc" kinds never get one — there's nothing to
  // co-edit, so `usePresenceRoom` connects awareness-only for them, same
  // as phase 1.
  const [artifactDoc, setArtifactDoc] = useState<Y.Doc | null>(null);
  const [artifactSaveState, setArtifactSaveState] = useState<ArtifactSaveState>(
    { kind: "read-only" },
  );
  const artifactDocForId = useRef<string | null>(null);
  useEffect(() => {
    if (canvasArtifact === null || canvasArtifact.rendererKind !== "doc") {
      artifactDocForId.current = null;
      setArtifactDoc(null);
      setArtifactSaveState({ kind: "read-only" });
      return;
    }
    if (artifactDocForId.current === canvasArtifact.id) return;
    artifactDocForId.current = canvasArtifact.id;
    setArtifactDoc(new Y.Doc());
    setArtifactSaveState(
      canvasArtifact.canEdit === true
        ? { kind: "unsaved" }
        : { kind: "read-only" },
    );
  }, [canvasArtifact]);

  // Co-viewers of the open artifact, if any — see canvas-column.tsx's own
  // `PresenceCursor` doc for why this stays plain data across the
  // package boundary.
  const artifactPresence = usePresenceRoom(
    tenantId,
    canvasArtifact === null ? null : `artifact:${canvasArtifact.id}`,
    undefined,
    {
      ...(viewerPrincipalId === null ? {} : { principalId: viewerPrincipalId }),
      ...(artifactDoc === null
        ? {}
        : {
            doc: artifactDoc,
            onSaved: (info: { version: number; savedAt: number }) =>
              setArtifactSaveState({
                kind: "saved",
                version: info.version,
                savedAt: info.savedAt,
              }),
          }),
    },
  );
  const editingCoworkers = artifactPresence.members
    .filter(
      (member) =>
        member.typing === true && member.principalId !== viewerPrincipalId,
    )
    .map((member) => member.displayName);
  const artifactSaveStateWithEditors: ArtifactSaveState =
    canvasArtifact?.canEdit === true && editingCoworkers.length > 0
      ? { kind: "editing", by: editingCoworkers }
      : artifactSaveState;
  const closeCanvas = useCloseCanvas();
  const toggleCanvasFocus = useToggleCanvasFocus();
  const mainRef = useRef<HTMLDivElement>(null);
  // Route changes must not inherit the previous page's scroll position.
  useScrollReset(mainRef, path);
  const pendingCount = usePendingApprovalCount(tenantId);
  const pendingChip =
    pendingCount === null
      ? undefined
      : pendingCount > 0
        ? {
            tone: "needs-you" as const,
            label: `${String(pendingCount)} waiting on you`,
          }
        : { tone: "ok" as const, label: "All caught up" };

  return (
    <div className="shell-frame">
      <Sidebar
        path={path}
        user={user}
        onNavigate={navigate}
        onSignOut={onSignOut}
      />
      <div className="shell-main" ref={mainRef}>
        <div className="shell-main-content">
          <ProviderHealthBanner path={path} />
          {routeHasNoStageTopBar(path) ? (
            <StageTopBar
              crumbs={[{ label: routeLabel(path) }]}
              {...(pendingChip !== undefined ? { chip: pendingChip } : {})}
            />
          ) : null}
          <Suspense
            fallback={
              <div className="page-fill shell-route-loading">
                <WorkbenchLoadingState />
              </div>
            }
          >
            {children}
          </Suspense>
        </div>
      </div>
      {canvasAllowed ? (
        <Suspense fallback={null}>
          <CanvasColumn
            open={canvasOpen}
            profile={canvasProfile}
            artifact={canvasArtifact}
            routine={canvasRoutine}
            focus={canvasFocus}
            onClose={closeCanvas}
            onToggleFocus={toggleCanvasFocus}
            onNavigate={navigate}
            presenceCursors={artifactPresence.members
              .filter((member) => member.cursor !== undefined)
              .map((member) => ({
                principalId: member.principalId,
                displayName: member.displayName,
                color: member.color,
                x: member.cursor?.x ?? 0,
                y: member.cursor?.y ?? 0,
              }))}
            onCursorMove={artifactPresence.publishCursor}
            {...(artifactDoc !== null ? { artifactDoc } : {})}
            artifactSaveState={artifactSaveStateWithEditors}
            onArtifactTyping={artifactPresence.publishTyping}
            presenceConnection={artifactPresence.connection}
          />
        </Suspense>
      ) : null}
      <ShellContextMenu onSignOut={onSignOut} />
    </div>
  );
}
