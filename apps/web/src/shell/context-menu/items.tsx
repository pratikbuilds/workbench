// One item builder per target type. Every item here calls a real backend or
// a real, already-shipped shell affordance — nothing toast-only. A target
// whose mock counterpart had no working backend (mark-read, mute, archive,
// share) simply has no builder and so contributes no items.

import {
  patchWorkbenchSettings,
  profileSubjectFromParticipant,
  WORKBENCHES_MUTATED_EVENT,
} from "@corbits/chat-ui";
import type { ProfileSubject } from "@corbits/chat-ui";
import { contextMenuItem, contextMenuSeparator } from "@corbits/context-menu";
import type { ContextMenu, ContextMenuEntry } from "@corbits/context-menu";
import { reportError } from "@corbits/error-sink";
import {
  ArrowSquareOut,
  Hash,
  LinkSimple as LinkIcon,
  MagnifyingGlass,
  MoonStars,
  PencilSimple,
  PlayCircle,
  PushPin,
  PushPinSlash,
  SignOut,
  SlidersHorizontal,
  UserCircle,
} from "@corbits/icons";
import { toast } from "@corbits/react-ui";

import {
  copyArtifactLinks,
  copyArtifactLinksActionLabel,
  copyArtifactLinksToastLabel,
} from "../library-artifacts";
import { workbenchPath } from "../../workbench-path";
import { requestWorkbenchRename } from "../../workbench-rename-events";
import { openCommandPalette } from "../../command-palette-open-store";
import { runScheduledWorkflowNow } from "../../routines-api";
import { SETTINGS_PATH } from "../../routes";
import type { ShellContextMenuTarget } from "./targets";

export type ShellContextMenuActions = {
  readonly tenantId: string | null;
  readonly navigate: (to: string) => void;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly cycleTheme: () => void;
  readonly signOut: () => void;
  /** Called with the tenant id after a routine's Run now succeeds, so the
   * caller can refresh the routines list and run history that a stale
   * right-click menu has no other way to know changed. */
  readonly onRoutineRan: (tenantId: string) => void;
};

async function copyLink(path: string, label: string): Promise<void> {
  const url = `${window.location.origin}${path}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(`${label} link copied`);
  } catch {
    toast("Couldn't copy the link");
  }
}

function workbenchMenu(
  target: Extract<ShellContextMenuTarget, { type: "workbench" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const entries: ContextMenuEntry[] = [
    contextMenuItem({
      id: "rename",
      label: "Rename workbench",
      icon: <PencilSimple />,
      onSelect: () => requestWorkbenchRename(target.id),
    }),
  ];
  if (actions.tenantId !== null) {
    const tenantId = actions.tenantId;
    entries.push(
      contextMenuItem({
        id: "pin",
        label: target.pinned ? "Unpin workbench" : "Pin workbench",
        icon: target.pinned ? <PushPinSlash /> : <PushPin />,
        onSelect: () => {
          void patchWorkbenchSettings(tenantId, target.id, {
            "chat/pinned": !target.pinned,
          }).then(
            () => {
              // Settings persist without this, but the sidebar list caches
              // its workbench fetch — without a mutation signal the pin
              // has zero visible effect (no reorder, no glyph refresh).
              window.dispatchEvent(
                new CustomEvent(WORKBENCHES_MUTATED_EVENT, {
                  detail: { tenantId },
                }),
              );
              toast(target.pinned ? "Workbench unpinned" : "Workbench pinned");
            },
            () => toast("Couldn't update the workbench"),
          );
        },
      }),
    );
  }
  entries.push(
    contextMenuSeparator,
    contextMenuItem({
      id: "copy-link",
      label: "Copy link",
      icon: <LinkIcon />,
      onSelect: () => void copyLink(workbenchPath(target.id), target.title),
    }),
  );
  return { label: target.title, entries };
}

function profileMenu(
  target: Extract<ShellContextMenuTarget, { type: "profile" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const subject = profileSubjectFromParticipant({
    address: target.address,
    handle: target.handle,
  });
  return {
    label: subject.displayName,
    entries: [
      contextMenuItem({
        id: "open-profile",
        label: "Open profile",
        icon: <UserCircle />,
        onSelect: () => actions.openProfile(subject),
      }),
    ],
  };
}

function routineMenu(
  target: Extract<ShellContextMenuTarget, { type: "routine" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const path = `/routines/${encodeURIComponent(target.id)}`;
  const entries: ContextMenuEntry[] = [
    contextMenuItem({
      id: "open",
      label: "Open routine",
      icon: <ArrowSquareOut />,
      onSelect: () => actions.navigate(path),
    }),
  ];
  if (actions.tenantId !== null) {
    const tenantId = actions.tenantId;
    entries.push(
      contextMenuItem({
        id: "run-now",
        label: "Run now",
        icon: <PlayCircle />,
        onSelect: () => {
          void (async () => {
            try {
              await runScheduledWorkflowNow(tenantId, target.id);
              toast(`${target.name} started`);
              actions.onRoutineRan(tenantId);
            } catch (cause) {
              reportError(cause, {
                operation: "scheduled_workflow_run_now",
                tenantId,
              });
              toast("Couldn't start the routine");
            }
          })();
        },
      }),
    );
  }
  entries.push(
    contextMenuSeparator,
    contextMenuItem({
      id: "copy-link",
      label: "Copy link",
      icon: <LinkIcon />,
      onSelect: () => void copyLink(path, target.name),
    }),
  );
  return { label: target.name, entries };
}

function insightsRunMenu(
  target: Extract<ShellContextMenuTarget, { type: "insights-run" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const path = `/insights/runs/${encodeURIComponent(target.id)}`;
  return {
    entries: [
      contextMenuItem({
        id: "open",
        label: "Open run",
        icon: <ArrowSquareOut />,
        onSelect: () => actions.navigate(path),
      }),
      contextMenuItem({
        id: "copy-link",
        label: "Copy link",
        icon: <LinkIcon />,
        onSelect: () => void copyLink(path, "Run"),
      }),
    ],
  };
}

/**
 * Same operation set the Files bulk action bar offers (CL-6423): copy
 * every acted-on file's canonical link. `target.ids` is either the single
 * right-clicked row, or the whole active selection when the row is part of
 * one — see `SHELL_CONTEXT_MENU_TARGETS`.
 */
function artifactMenu(
  target: Extract<ShellContextMenuTarget, { type: "artifact" }>,
): ContextMenu {
  const count = target.ids.length;
  return {
    entries: [
      contextMenuItem({
        id: "copy-link",
        label: copyArtifactLinksActionLabel(count),
        icon: <LinkIcon />,
        onSelect: () => {
          void copyArtifactLinks(target.ids).then(
            () => toast(copyArtifactLinksToastLabel(count)),
            () => toast("Couldn't copy the link"),
          );
        },
      }),
    ],
  };
}

function accountMenu(actions: ShellContextMenuActions): ContextMenu {
  return {
    label: "Account",
    entries: [
      contextMenuItem({
        id: "settings",
        label: "Settings",
        icon: <SlidersHorizontal />,
        onSelect: () => actions.navigate(SETTINGS_PATH),
      }),
      contextMenuSeparator,
      contextMenuItem({
        id: "sign-out",
        label: "Sign out",
        icon: <SignOut />,
        onSelect: () => actions.signOut(),
      }),
    ],
  };
}

function shellMenu(actions: ShellContextMenuActions): ContextMenu {
  return {
    label: "Workbench",
    entries: [
      contextMenuItem({
        id: "search",
        label: "Search",
        icon: <MagnifyingGlass />,
        onSelect: () => openCommandPalette(),
      }),
      contextMenuItem({
        id: "workbenches",
        label: "Go to workbenches",
        icon: <Hash />,
        onSelect: () => actions.navigate(workbenchPath(null)),
      }),
      contextMenuSeparator,
      contextMenuItem({
        id: "theme",
        label: "Toggle theme",
        icon: <MoonStars />,
        onSelect: () => actions.cycleTheme(),
      }),
    ],
  };
}

export function shellContextMenuFor(
  target: ShellContextMenuTarget,
  actions: ShellContextMenuActions,
): ContextMenu {
  switch (target.type) {
    case "workbench":
      return workbenchMenu(target, actions);
    case "profile":
      return profileMenu(target, actions);
    case "routine":
      return routineMenu(target, actions);
    case "insights-run":
      return insightsRunMenu(target, actions);
    case "artifact":
      return artifactMenu(target);
    case "account":
      return accountMenu(actions);
    case "shell":
      return shellMenu(actions);
  }
}
