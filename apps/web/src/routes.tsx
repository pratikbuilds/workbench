// The route table: one entry per screen, consumed by the command palette
// (label) and the route switch (render), so navigation and pages cannot
// drift apart. The sidebar itself lists workbenches (conversations), not
// routes — the first-run footer reaches Routines, Files, Skills, Agents,
// and Plugins; Insights and Evals join that rail only given honest usage.
// Insights, Evals, and Settings stay reachable by deep link and the
// palette even when they are off the rail. Conversation deep links
// (`/w/:workbenchId`) stay routable; `/` is the Myra land hop (ensure +
// open her conversation) for a bench with a workbench already, or the
// guided first-workbench describe screen for a bench with none (CL-6104)
// — never a Home dashboard.
// Approvals has no page — the Activity band owns them. Agents (CL-6354)
// and Skills (CL-6355) are their own rail destinations again — they spent
// a stretch as Settings sections (CL-5990) and `/settings/agents[/:id]` /
// `/settings/skills[/:id]` stay routable only as redirects back here, so
// old links and bookmarks still land somewhere real. Library was renamed
// Files (CL-6353) at the same time it moved off `/library`, which
// redirects the same way. Inbox is gone too (CL-6151: tasks + approvals
// don't flow into workbenches); `/inbox` stays routable only as a
// redirect to `/`.

import {
  ChatCircle,
  ChartBar,
  FlowArrow,
  FolderOpen,
  Lightning,
  ListBullets,
  PuzzlePiece,
  Robot,
  SlidersHorizontal,
  SquaresFour,
} from "@corbits/icons";
import { CHAT_STRINGS } from "@corbits/chat-ui";
import type { Slug } from "@corbits/slug";
import { lazy, useEffect, type ReactElement, type ReactNode } from "react";

import {
  AGENTS_PATH_PREFIX,
  EVALS_PATH_PREFIX,
  SKILLS_PATH_PREFIX,
  ROUTINES_PATH_PREFIX,
  WORKFLOWS_PATH_PREFIX,
  detailSlugFromPath,
  routineSegmentFromPath,
  workflowDefinitionAssetIdFromPath,
} from "./path-ids";
import { WORKBENCH_PATH_PREFIX, isWorkbenchPath } from "./workbench-path";
import {
  LegacyLibraryRedirect,
  LegacySettingsAgentsRedirect,
  LegacySettingsSkillsRedirect,
} from "./pages/legacy-settings-redirects";

// Each signed-in page is a dynamic import so Vite emits one chunk per
// screen. Static imports here pulled chat-ui, artifact-ui, settings-ui,
// plugins-ui, and insights into a single 1.2 MB SPA.

const HomeRoute = lazy(async () => ({
  default: (await import("./pages/home-page")).HomeRoute,
}));
const MissionControlRoute = lazy(async () => ({
  default: (await import("./pages/mission-control-page")).MissionControlRoute,
}));
const NewWorkbenchPickerRoute = lazy(async () => ({
  default: (await import("./pages/new-workbench-picker"))
    .NewWorkbenchPickerRoute,
}));
const ChatPage = lazy(async () => ({
  default: (await import("./pages/chat-page")).ChatPage,
}));
const RoutinesRoute = lazy(async () => ({
  default: (await import("./pages/routines-page")).RoutinesRoute,
}));
const LibraryRoute = lazy(async () => ({
  default: (await import("./pages/library-page")).LibraryRoute,
}));
const AgentsRoute = lazy(async () => ({
  default: (await import("./pages/agents-page")).AgentsRoute,
}));
const SkillsRoute = lazy(async () => ({
  default: (await import("./pages/skills-page")).SkillsRoute,
}));
const InsightsRoute = lazy(async () => ({
  default: (await import("./pages/insights-page")).InsightsRoute,
}));
const EvalsRoute = lazy(async () => ({
  default: (await import("./pages/evals-page")).EvalsRoute,
}));
const PluginsRoute = lazy(async () => ({
  default: (await import("./pages/plugins-page")).PluginsRoute,
}));
const SettingsRoute = lazy(async () => ({
  default: (await import("./pages/settings-page")).SettingsRoute,
}));
const AgentDetailRoute = lazy(async () => ({
  default: (await import("./pages/agent-detail-page")).AgentDetailRoute,
}));
const SkillDetailRoute = lazy(async () => ({
  default: (await import("./pages/skill-detail-page")).SkillDetailRoute,
}));
const RoutineDetailRoute = lazy(async () => ({
  default: (await import("./pages/routine-detail-page")).RoutineDetailRoute,
}));
const WorkflowDetailRoute = lazy(async () => ({
  default: (await import("./pages/workflow-detail-page")).WorkflowDetailRoute,
}));

/** The signed-out screen (CL-6369) — a real route, not a conditional swap:
 * any unauthenticated request for another path bounces here with `?next=`
 * so a successful sign-in returns to where the visitor meant to go. Not
 * one of `APP_ROUTES`: like `ONBOARDING_PATH`, it renders above the shell
 * entirely (no sidebar, no chrome to be "current" in) and is reached only
 * through the signed-out branch of `App`'s session switch. */
export const LOGIN_PATH = "/login";

/** Landing point for a session the first-login hook just provisioned a
 * personal bench for. Not one of `APP_ROUTES`: it has no sidebar entry,
 * it is only ever reached by the first-login redirect. */
export const ONBOARDING_PATH = "/onboarding";

/** Settings path — sidebar footer + settings page. */
export const SETTINGS_PATH = "/settings";

/** Mission Control — the bench's dashboard (CL-6488/CL-6489). Pinned above
 * the sidebar's footer rail as its own row (see DESIGN.md's Shell &
 * Navigation section), reachable by direct URL and the command palette
 * like everything else, but deliberately off `NAV_ROUTES`: it isn't a
 * roster to browse, it's the one destination the sidebar always pins in
 * view. */
export const MISSION_CONTROL_PATH = "/mission-control";

/** The template picker (CL-6342) — every "+ New workbench" affordance
 * (sidebar, command palette) hops here first; picking a row is what
 * actually mints the workbench. Not in `NAV_ROUTES`: it has no sidebar
 * row of its own, only the "+" control and the palette reach it. */
export const NEW_WORKBENCH_PATH = "/new";

/** Detail routes are addressed by slug (CL-6412): one route path per
 * entity, ending in this segment. A path matches only when its last
 * segment is a real slug, so `/agents/wfd_1` still resolves to the Agents
 * roster (which owns id deep links) while `/agents/triage-bot` resolves to
 * the agent's own screen. */
const SLUG_SEGMENT = "/:slug";

export const AGENT_DETAIL_PATH = `${AGENTS_PATH_PREFIX}${SLUG_SEGMENT}`;
export const SKILL_DETAIL_PATH = `${SKILLS_PATH_PREFIX}${SLUG_SEGMENT}`;
// Plugin detail (`/plugins/:slug`) is parked with CL-6417. CL-6817 removed
// the "still being built" stub so gallery/palette click-throughs do not
// promise a page that is only a placeholder.

/**
 * Routines are addressed by id, not by slug. DESIGN.md allows a slug in a
 * route only where it is "immutable and tenant-unique, enforced as a hard
 * database constraint — never a soft convention"; a routine has no slug
 * column, so a name-derived one is exactly the soft convention that rule
 * forbids, and the documented fallback is the opaque id. So this route
 * claims any single segment under `/routines`: an id renders the page,
 * and a name still resolves — `routine-detail-page.tsx` redirects it to
 * the id path — which keeps human-typed and shared-by-name links working
 * without making the fragile address canonical. A real slug column is
 * ticketed separately.
 */
const ROUTINE_SEGMENT = "/:routine";
export const ROUTINE_DETAIL_PATH = `${ROUTINES_PATH_PREFIX}${ROUTINE_SEGMENT}`;

/**
 * A workflow definition has no slug either — same reasoning as a routine
 * above — so `/workflows/:id` claims any single segment under
 * `/workflows`, addressed by the definition's own opaque asset id.
 */
const WORKFLOW_SEGMENT = "/:workflow";
export const WORKFLOW_DETAIL_PATH = `${WORKFLOWS_PATH_PREFIX}${WORKFLOW_SEGMENT}`;

function slugForDetailRoute(routePath: string, path: string): Slug | null {
  return detailSlugFromPath(path, routePath.slice(0, -SLUG_SEGMENT.length));
}

/** The routine detail route only ever renders for a path `matchesRoute`
 * already accepted, which is what makes the segment non-null here. */
function routineDetailSegment(path: string): string {
  const segment = routineSegmentFromPath(path);
  if (segment === null) {
    throw new Error(
      `${ROUTINE_DETAIL_PATH} rendered for a path with no routine: ${path}`,
    );
  }
  return segment;
}

/** A detail route only ever renders for a path `matchesRoute` already
 * accepted, which is what makes the slug non-null here. */
function detailRouteSlug(routePath: string, path: string): Slug {
  const slug = slugForDetailRoute(routePath, path);
  if (slug === null) {
    throw new Error(`${routePath} rendered for a path with no slug: ${path}`);
  }
  return slug;
}

export type AppRoute = {
  readonly path: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly render: (
    path: string,
    navigate: (to: string) => void,
  ) => ReactElement;
  /** False only for the one screen with no `StageTopBar` of its own — Myra
   * land (`/`) is a bare ensure+redirect hop (see `pages/home-page.tsx`)
   * with nothing in the stage to title itself while it resolves. `AppShell`
   * covers that gap generically (`shell/app-shell.tsx`) rather than home-page
   * inventing chrome for a screen that's never meant to linger. Every other
   * route titles its own stage. */
  readonly hasStageTopBar?: boolean;
};

/**
 * Matches nested product paths (`/routines/:id`, `/insights/...`) plus
 * conversation deep links (which also match when Myra land `/` is active)
 * and the slug-addressed detail routes (`/agents/:slug`). Other routes are
 * exact path matches. A roster prefix still matches its own nested paths,
 * so the sidebar footer row stays lit on a detail screen. Plugins is exact
 * only: until CL-6417 lands a real detail page, a slug under `/plugins` is
 * unroutable rather than a stub (CL-6817).
 */
export function matchesRoute(routePath: string, path: string): boolean {
  if (routePath === WORKBENCH_PATH_PREFIX) {
    return isWorkbenchPath(path) || path === "/";
  }
  if (routePath === ROUTINE_DETAIL_PATH) {
    const segment = routineSegmentFromPath(path);
    return segment !== null && !segment.includes("/");
  }
  if (routePath === WORKFLOW_DETAIL_PATH) {
    const assetId = workflowDefinitionAssetIdFromPath(path);
    return assetId !== null && !assetId.includes("/");
  }
  if (routePath.endsWith(SLUG_SEGMENT)) {
    return slugForDetailRoute(routePath, path) !== null;
  }
  if (
    routePath === "/routines" ||
    routePath === "/library" ||
    routePath === "/files" ||
    routePath === "/insights" ||
    routePath === EVALS_PATH_PREFIX ||
    routePath === "/agents" ||
    routePath === "/skills" ||
    routePath === "/settings/agents" ||
    routePath === "/settings/skills" ||
    routePath === SETTINGS_PATH
  ) {
    return path === routePath || path.startsWith(`${routePath}/`);
  }
  return routePath === path;
}

/** Bounces old `/inbox` links and bookmarks home (CL-6151: the Inbox page
 * is gone — tasks and approvals don't flow into a workbench). */
function InboxRedirect({
  navigate,
}: {
  readonly navigate: (to: string) => void;
}) {
  useEffect(() => {
    navigate("/");
  }, [navigate]);
  return null;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: "/",
    label: CHAT_STRINGS.newWorkbenchAction,
    icon: <ChatCircle />,
    render: () => <HomeRoute />,
    hasStageTopBar: false,
  },
  {
    path: MISSION_CONTROL_PATH,
    label: "Mission Control",
    icon: <SquaresFour />,
    render: (_path: string, navigate: (to: string) => void) => (
      <MissionControlRoute navigate={navigate} />
    ),
  },
  {
    path: NEW_WORKBENCH_PATH,
    label: CHAT_STRINGS.newWorkbenchAction,
    icon: <ChatCircle />,
    render: () => <NewWorkbenchPickerRoute />,
  },
  {
    path: WORKBENCH_PATH_PREFIX,
    label: "Workbenches",
    icon: <ChatCircle />,
    render: (path: string, navigate: (to: string) => void) => (
      <ChatPage path={path} navigate={navigate} />
    ),
  },
  {
    path: "/inbox",
    label: "Inbox",
    icon: <ChatCircle />,
    render: (_path: string, navigate: (to: string) => void) => (
      <InboxRedirect navigate={navigate} />
    ),
  },
  {
    // Detail routes come before their roster: the roster prefix matches
    // everything beneath it, so the more specific slug route has to be
    // found first.
    path: ROUTINE_DETAIL_PATH,
    label: "Routine",
    icon: <FlowArrow />,
    render: (path: string) => (
      <RoutineDetailRoute segment={routineDetailSegment(path)} />
    ),
  },
  {
    path: "/routines",
    label: "Routines",
    icon: <FlowArrow />,
    render: () => <RoutinesRoute />,
  },
  {
    // A workflow definition's own page (CL-7371) — no roster of its own
    // yet, only reached by a deep link (e.g. from a routine's target).
    path: WORKFLOW_DETAIL_PATH,
    label: "Workflow",
    icon: <FlowArrow />,
    render: (path: string) => <WorkflowDetailRoute path={path} />,
  },
  {
    // The renamed, remounted Library page (CL-6353) — "Library" stays out
    // of user-facing copy, but the underlying artifact machinery
    // (`library-page.tsx`, `libraryArtifactIdFromPath`, …) keeps its name.
    path: "/files",
    label: "Files",
    icon: <FolderOpen />,
    render: (path: string) => <LibraryRoute path={path} />,
  },
  {
    // Old `/library` links and bookmarks (CL-6353's rename) land here.
    path: "/library",
    label: "Files",
    icon: <FolderOpen />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacyLibraryRedirect path={path} navigate={navigate} />
    ),
  },
  {
    path: AGENT_DETAIL_PATH,
    label: "Agent",
    icon: <Robot />,
    render: (path: string, navigate: (to: string) => void) => (
      <AgentDetailRoute
        slug={detailRouteSlug(AGENT_DETAIL_PATH, path)}
        navigate={navigate}
      />
    ),
  },
  {
    path: "/agents",
    label: "Agents",
    icon: <Robot />,
    render: (path: string, navigate: (to: string) => void) => (
      <AgentsRoute path={path} navigate={navigate} />
    ),
  },
  {
    // Agents spent CL-5990 through CL-6354 as a Settings section — this
    // entry keeps old `/settings/agents[/:id]` links routable.
    path: "/settings/agents",
    label: "Agents",
    icon: <Robot />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacySettingsAgentsRedirect path={path} navigate={navigate} />
    ),
  },
  {
    path: SKILL_DETAIL_PATH,
    label: "Skill",
    icon: <Lightning />,
    render: (path: string) => <SkillDetailRoute path={path} />,
  },
  {
    path: "/skills",
    label: "Skills",
    icon: <Lightning />,
    render: (_path: string, navigate: (to: string) => void) => (
      <SkillsRoute navigate={navigate} />
    ),
  },
  {
    // Skills spent CL-5990 through CL-6355 as a Settings section — this
    // entry keeps old `/settings/skills[/:id]` links routable.
    path: "/settings/skills",
    label: "Skills",
    icon: <Lightning />,
    render: (path: string, navigate: (to: string) => void) => (
      <LegacySettingsSkillsRedirect path={path} navigate={navigate} />
    ),
  },
  {
    path: "/insights",
    label: "Insights",
    icon: <ChartBar />,
    render: (path: string) => <InsightsRoute path={path} />,
  },
  {
    path: EVALS_PATH_PREFIX,
    label: "Evals",
    icon: <ListBullets />,
    render: (path: string) => <EvalsRoute path={path} />,
  },
  {
    // First-run footer rail destination. No `/plugins/:slug` until
    // CL-6417 (CL-6817 unlinked the stub).
    path: "/plugins",
    label: "Plugins",
    icon: <PuzzlePiece />,
    render: (path: string, navigate: (to: string) => void) => (
      <PluginsRoute path={path} navigate={navigate} />
    ),
  },
  {
    path: SETTINGS_PATH,
    label: "Settings",
    icon: <SlidersHorizontal />,
    render: (path: string, navigate: (to: string) => void) => (
      <SettingsRoute path={path} navigate={navigate} />
    ),
  },
];

function routesInOrder(paths: readonly string[]): readonly AppRoute[] {
  const byPath = new Map(APP_ROUTES.map((route) => [route.path, route]));
  return paths.flatMap((path) => {
    const route = byPath.get(path);
    return route === undefined ? [] : [route];
  });
}

/**
 * Everything the command palette treats as a product destination (its
 * "Pages" group). The first-run sidebar footer reaches Routines / Files /
 * Skills / Agents / Plugins (and Insights / Evals only given honest
 * usage); Insights, Evals, and Settings stay palette- and
 * deep-link-reachable even when they are off the rail.
 */
export const NAV_ROUTES: readonly AppRoute[] = routesInOrder([
  "/routines",
  "/files",
  "/skills",
  "/agents",
  "/plugins",
  "/insights",
  EVALS_PATH_PREFIX,
  SETTINGS_PATH,
]);
