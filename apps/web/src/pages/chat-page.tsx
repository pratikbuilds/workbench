// Workbench surface for the main stage. `/w` and `/w/:workbenchId` (plus legacy
// `/chat` prefixes) render the conversation here — not in the canvas.
// Canvas stays auxiliary (profiles and similar) and opens on demand from
// this workspace.

import { libraryArtifactPath } from "@corbits/artifact-ui";
import { describeApiError } from "@corbits/api-query";
import { listPrincipals } from "@corbits/settings-ui";
import { ChatWorkspace, fetchWorkbenchBlob, type Part } from "@corbits/chat-ui";
import {
  getResolvedCatalog,
  hasUsableModel as computeHasUsableModel,
} from "@corbits/inference-settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { fetchArtifactDetail } from "../api";
import { createChatApprovalActions } from "../approval-actions";
import { createChatBlockResponseActions } from "../block-response-actions";
import { createChatConnectGithubActions } from "../connect-github-actions";
import { createChatConnectServiceActions } from "../connect-service-actions";
import { useBench } from "../bench-context";
import { useSignOut, useSessionUser } from "../navigation";

import {
  artifactContentFromBlob,
  artifactContentFromBlobError,
  artifactContentFromDetail,
  artifactContentFromDetailError,
} from "../chat-artifact-open";
import {
  workbenchIdFromPath,
  workbenchPath,
  workbenchSettingsPath,
  workbenchSettingsSectionFromPath,
  workbenchSettingsEntityIdFromPath,
  isWorkbenchSettingsPath,
} from "../workbench-path";
import { reportWorkbenchNotFound } from "../workbench-not-found-event";
import { recordLastWorkbenchId } from "../last-workbench";
import {
  ONBOARDING_PATH,
  MISSION_CONTROL_PATH,
  NEW_WORKBENCH_PATH,
} from "../routes";
import {
  useProviderHealthBanner,
  useRequestPluginsConnect,
} from "../shell/provider-health-context";
import {
  useOpenArtifactInCanvas,
  useOpenProfileInCanvas,
} from "../shell/canvas-availability";
import { useRegisterComposerInsert } from "../shell/composer-insertion";
import { StageTopBar } from "../shell/stage-top-bar";
import { tenantResolutionFromBench } from "../shell/tenant-resolution";

export function ChatPage({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const bench = useBench();
  const onSignIn = useSignOut();
  const sessionUser = useSessionUser();
  const workbenchId = workbenchIdFromPath(path);

  const settingsOpen = isWorkbenchSettingsPath(path);
  const settingsSection = workbenchSettingsSectionFromPath(path) ?? "general";
  const settingsEntityId = settingsOpen
    ? workbenchSettingsEntityIdFromPath(path, settingsSection)
    : null;
  const openProfile = useOpenProfileInCanvas();
  const registerComposerInsert = useRegisterComposerInsert();
  const openArtifactInCanvas = useOpenArtifactInCanvas();
  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;
  const queryClient = useQueryClient();
  const tenantId = bench.selectedTenantId;

  // Same display name the sidebar account row already shows (CL-6655): the
  // auth session's name, which sign-up seeds from the email local-part when
  // no profile name was typed. Without this, chat-ui falls back to "Member"
  // for the reader's own presence/message avatar.
  const currentUser =
    principalId === undefined
      ? undefined
      : {
          principalId,
          ...(sessionUser !== undefined
            ? {
                name:
                  sessionUser.name.trim().length > 0
                    ? sessionUser.name.trim()
                    : (sessionUser.email.split("@")[0] ?? sessionUser.email),
                handle: sessionUser.email,
              }
            : {}),
        };

  // Files' workbench-first lens (CL-6353) reads this back to default to
  // "this workbench" when the person just came from one.
  useEffect(() => {
    if (tenantId === null || workbenchId === null) return;
    recordLastWorkbenchId(tenantId, workbenchId);
  }, [tenantId, workbenchId]);

  // Who's live in this workbench right now is derived inside `ChatWorkspace`
  // itself now (CL-6328), off the same `/stream` connection as everything
  // else — no separate `@corbits/presence` room/heartbeat for this surface
  // any more (that stack still backs the artifact canvas's cursor sync,
  // which has no chat stream of its own to piggyback on).
  const approvalActions = useMemo(
    () =>
      tenantId === null
        ? undefined
        : createChatApprovalActions(tenantId, queryClient),
    [tenantId, queryClient],
  );
  const blockResponses = useMemo(
    () =>
      tenantId === null || workbenchId === null
        ? undefined
        : createChatBlockResponseActions(tenantId, workbenchId),
    [tenantId, workbenchId],
  );
  const connectGithubActions = useMemo(
    () =>
      tenantId === null || workbenchId === null
        ? undefined
        : createChatConnectGithubActions(tenantId, workbenchId),
    [tenantId, workbenchId],
  );
  const connectServiceActions = useMemo(
    () =>
      tenantId === null
        ? undefined
        : createChatConnectServiceActions(tenantId, path),
    [tenantId, path],
  );

  // The in-chat "Fix this connection" affordance's deep link (CL-6092) —
  // the exact same hop the shell banner's own "Fix it" takes, reusing
  // `providerHealthBanner`'s current provider (chat-ui only sees a
  // classified reply's prose, never which provider it named — see
  // `inference-failure.ts`'s own header) rather than inventing a second
  // routing decision. Falls back to a bare Plugins visit if the banner's
  // provider isn't currently known (an edge case: the health poll hasn't
  // landed yet, or the incident already cleared between the reply and
  // the click).
  const providerHealthBanner = useProviderHealthBanner();
  const requestPluginsConnect = useRequestPluginsConnect();
  const listMembers = useCallback(async (memberTenantId: string) => {
    const principals = await listPrincipals(memberTenantId);
    return principals
      .filter((p) => p.kind === "user" && p.status === "active")
      .map((p) => ({ id: p.id, displayName: p.displayName }));
  }, []);

  const handleFixConnection = useCallback(() => {
    if (providerHealthBanner === null) {
      navigate("/plugins");
      return;
    }
    if (providerHealthBanner.zeroWorkingProviders) {
      navigate(ONBOARDING_PATH);
      return;
    }
    requestPluginsConnect(providerHealthBanner.provider);
    navigate("/plugins");
  }, [providerHealthBanner, requestPluginsConnect, navigate]);

  // CL-6568: whether this tenant can actually run inference — never
  // whether a `model_provider` row merely exists, since seeding mints
  // that row with no credential attached. The same resolved-catalog
  // read `resolveModelSources` acts on at launch, so a model only
  // carries an offering once a real credential backs it.
  const resolvedCatalogQuery = useQuery({
    queryKey: ["chat-page", "resolved-catalog", tenantId],
    queryFn: () => getResolvedCatalog(tenantId ?? ""),
    enabled: tenantId !== null,
  });
  const hasUsableModel =
    resolvedCatalogQuery.data !== undefined
      ? computeHasUsableModel(resolvedCatalogQuery.data)
      : undefined;
  const handleConnectModel = useCallback(() => {
    navigate("/settings/connections");
  }, [navigate]);

  // A file part with an `artifactId` links back to a real Library row
  // (CL-6000) — this always resolves through the Library artifacts read
  // surface for that id, the same one `LibraryRoute` reads, never raw blob
  // bytes. Only a part with no `artifactId` (a plain human upload the
  // platform never diverted into an artifact) falls back to reading the
  // bytes off the chat platform's own blob route. Either path renders
  // through the same typed renderers Library and the canvas already share.
  const openArtifact = useCallback(
    (part: Part & { kind: "file" }) => {
      if (tenantId === null) return;
      if (part.artifactId !== undefined) {
        const artifactId = part.artifactId;
        void fetchArtifactDetail(tenantId, artifactId)
          .then((detail) => {
            openArtifactInCanvas(artifactContentFromDetail(tenantId, detail));
          })
          .catch((err) => {
            openArtifactInCanvas(
              artifactContentFromDetailError(
                part,
                artifactId,
                describeApiError(err, "loading this artifact"),
              ),
            );
          });
        return;
      }
      if (part.blobId === undefined || workbenchId === null) return;
      const blobId = part.blobId;
      void fetchWorkbenchBlob(tenantId, workbenchId, blobId)
        .then((contentBase64) => {
          openArtifactInCanvas(
            artifactContentFromBlob(part, blobId, contentBase64),
          );
        })
        .catch((err) => {
          openArtifactInCanvas(
            artifactContentFromBlobError(
              part,
              blobId,
              describeApiError(err, "loading this attachment"),
            ),
          );
        });
    },
    [tenantId, workbenchId, openArtifactInCanvas],
  );

  // The chip's "Open in Library" affordance — only ever offered for a part
  // that carries an `artifactId` (see `ArtifactChip`), so this always has a
  // real row to deep-link to.
  const openArtifactInLibrary = useCallback(
    (part: Part & { kind: "file" }) => {
      if (part.artifactId === undefined) return;
      navigate(libraryArtifactPath(part.artifactId));
    },
    [navigate],
  );

  const workspace = (
    <ChatWorkspace
      tenant={tenant}
      {...(currentUser !== undefined ? { currentUser } : {})}
      workbenchId={workbenchId}
      onWorkbenchChange={(nextWorkbenchId) =>
        navigate(workbenchPath(nextWorkbenchId))
      }
      onOpenProfile={openProfile}
      registerComposerInsert={registerComposerInsert}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={(open, section, entityId) => {
        if (workbenchId === null) return;
        navigate(
          open
            ? workbenchSettingsPath(
                workbenchId,
                section ?? settingsSection,
                entityId,
              )
            : workbenchPath(workbenchId),
        );
      }}
      settingsSection={settingsSection}
      onSettingsSectionChange={(section) => {
        if (workbenchId === null) return;
        navigate(workbenchSettingsPath(workbenchId, section));
      }}
      settingsEntityId={settingsEntityId}
      onSettingsEntityIdChange={(entityId) => {
        if (workbenchId === null) return;
        navigate(
          workbenchSettingsPath(
            workbenchId,
            settingsSection,
            entityId ?? undefined,
          ),
        );
      }}
      onOpenArtifact={openArtifact}
      onOpenArtifactInLibrary={openArtifactInLibrary}
      onFixConnection={handleFixConnection}
      {...(hasUsableModel !== undefined ? { hasUsableModel } : {})}
      onConnectModel={handleConnectModel}
      {...(approvalActions !== undefined ? { approvalActions } : {})}
      {...(blockResponses !== undefined ? { blockResponses } : {})}
      {...(connectGithubActions !== undefined ? { connectGithubActions } : {})}
      {...(connectServiceActions !== undefined
        ? { connectServiceActions }
        : {})}
      listMembers={listMembers}
      onWorkbenchNotFound={reportWorkbenchNotFound}
      onGoToMissionControl={() => navigate(MISSION_CONTROL_PATH)}
      onNewWorkbench={() => navigate(NEW_WORKBENCH_PATH)}
      onBackToWorkbenchList={() => navigate(workbenchPath(null))}
      {...(onSignIn !== undefined ? { onSignIn } : {})}
      headerSlot={(chrome) => (
        <StageTopBar
          crumbs={chrome.crumbs}
          {...(chrome.subtitle !== undefined
            ? { subtitle: chrome.subtitle }
            : {})}
          {...(chrome.actions !== undefined ? { actions: chrome.actions } : {})}
        />
      )}
    />
  );

  return <div className="flex h-full min-h-0 flex-col">{workspace}</div>;
}
