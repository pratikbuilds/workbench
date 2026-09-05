// The command palette's `>` action commands: everything the shell mock's
// `buildCmdkEntries` lists under "Commands" that this app can actually wire
// today. Skills still use the off-route-safe pending-flag pattern
// `library-upload.ts` established: the palette can fire from any page,
// before the target page (and its window-event listener) has mounted, so
// a same-tick `dispatchEvent` would be a race the listener always loses.
// `pending-dialog-request.ts` generalizes that pattern; the target page
// (skills-page.tsx) consumes the pending flag on mount. Skills moved from
// its own route into a Settings section (CL-5990) and back out to its own
// rail destination (CL-6355) — "New skill" lands on `/skills`. "New task"
// and the Inbox page it used to open are gone (CL-6151, owner decision):
// tasks are dispatched by Myra from inside a workbench now.
//
// Workbench creation is not one of those — there is no dialog to race, no
// page to mount first: "new-workbench" navigates straight to the template
// picker (`/new`, CL-6342 — superseding CL-6138's direct mint), the same
// hop the sidebar's own "+" control uses. A second "new-agent" row that
// said and did the same thing was dropped (CL-6820). "New thread" is out
// of scope (killed by owner decision).

import { createPendingDialogRequest } from "@corbits/shell-layout";
import { CHAT_STRINGS } from "@corbits/chat-ui";
import { WORKBENCH_PATH_PREFIX } from "./workbench-path";
import { NEW_WORKBENCH_PATH } from "./routes";
import { listAgentDefinitions } from "./agents-api";
import { openAgentDmChat } from "./agent-dm-launch";
import { findMyraDefinition } from "./myra-workbench";
import { requestLibraryUpload } from "./library-upload";

export const NEW_SKILL_EVENT = "workbench:skills:create";

const newSkillRequest = createPendingDialogRequest();

/** Consumed by skills-settings-section.tsx on mount. */
export const consumePendingNewSkill = newSkillRequest.consumePending;

/** Test helper — drop leftover pending state between cases. */
export function resetPendingDialogRequests(): void {
  newSkillRequest.resetPending();
}

export type ActionCommandId =
  | "new-workbench"
  | "new-skill"
  | "upload-artifact"
  | "toggle-theme"
  | "close-canvas"
  | "talk-to-myra"
  | "go-workbenches"
  | "go-insights";

export type ActionCommand = {
  readonly id: ActionCommandId;
  readonly title: string;
  readonly subtitle: string;
};

/** Static catalog: id, title, subtitle. Matches the mock's action-command
 * titles, with "Install skill" relabeled "New skill" to match the shell's
 * current skills model: a person authors a skill into the workbench's own
 * registry (`skills-api.ts`) rather than installing one from a catalog. */
export const ACTION_COMMANDS: readonly ActionCommand[] = [
  {
    id: "new-workbench",
    title: CHAT_STRINGS.newWorkbenchAction,
    subtitle: "Start a new workbench",
  },
  { id: "new-skill", title: "New skill", subtitle: "Workbench capability" },
  {
    id: "upload-artifact",
    title: "Upload artifact",
    subtitle: "Files · open dialog",
  },
  { id: "toggle-theme", title: "Toggle theme", subtitle: "Light / dark" },
  {
    id: "close-canvas",
    title: "Close canvas",
    subtitle: "Full-width stage",
  },
  {
    id: "talk-to-myra",
    title: "Talk to Myra",
    subtitle: "Open your personal agent",
  },
  {
    id: "go-workbenches",
    title: "Go to workbenches",
    subtitle: "Home · conversation list",
  },
  {
    id: "go-insights",
    title: "Go to insights",
    subtitle: "Not in the nav · still routable",
  },
];

export type ActionCommandContext = {
  readonly path: string;
  readonly navigate: (to: string) => void;
  readonly tenantId: string | null;
  readonly cycleTheme: () => void;
  readonly closeCanvas: () => void;
};

/**
 * Runs one action command. "new-workbench" opens the template picker (see
 * the module doc); "new-skill" still goes through a pending flag when the
 * palette fires it off-route (see the module doc), so the target page's
 * own mount effect opens the dialog instead of a dispatch racing against
 * that page's not-yet-mounted listener.
 */
export async function runActionCommand(
  id: ActionCommandId,
  ctx: ActionCommandContext,
): Promise<void> {
  switch (id) {
    case "new-workbench": {
      ctx.navigate(NEW_WORKBENCH_PATH);
      return;
    }
    case "new-skill": {
      newSkillRequest.request({
        alreadyOnTargetRoute:
          ctx.path === "/skills" || ctx.path.startsWith("/skills/"),
        navigateToTargetRoute: () => ctx.navigate("/skills"),
        dispatch: () => window.dispatchEvent(new CustomEvent(NEW_SKILL_EVENT)),
      });
      return;
    }
    case "upload-artifact": {
      requestLibraryUpload({
        alreadyOnLibrary:
          ctx.path === "/files" || ctx.path.startsWith("/files/"),
        navigateToLibrary: () => ctx.navigate("/files"),
      });
      return;
    }
    case "toggle-theme": {
      ctx.cycleTheme();
      return;
    }
    case "close-canvas": {
      ctx.closeCanvas();
      return;
    }
    case "talk-to-myra": {
      if (ctx.tenantId === null) return;
      const myra = findMyraDefinition(await listAgentDefinitions(ctx.tenantId));
      if (myra === undefined) return;
      await openAgentDmChat(ctx.tenantId, myra.id, ctx.navigate);
      return;
    }
    case "go-workbenches": {
      ctx.navigate(WORKBENCH_PATH_PREFIX);
      return;
    }
    case "go-insights": {
      ctx.navigate("/insights");
      return;
    }
  }
}
