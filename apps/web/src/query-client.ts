// One QueryClient for the signed-in shell: shared cache for /api/me and
// tenant-scoped reads, so navigating between pages reuses data and a bench
// switch can drop the previous bench's tenant keys in a single call.

import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiQueryError, UnauthenticatedError } from "@corbits/api-query";
import { workbenchesQueryKey } from "@corbits/chat-ui";
import type { WorkbenchKind } from "@corbits/chat-ui";

/**
 * Retry policy shared by every query in the app: no session and a
 * definitive 404 both mean retrying cannot help — a 404 on a detail
 * lookup (an artifact or approval deleted since the link was made) is a
 * real, stable answer, not a transient failure, so retrying it three
 * times only delays an honest quiet no-op. Everything else (500s,
 * network failures) gets the normal three attempts.
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (error instanceof UnauthenticatedError) return false;
  if (error instanceof ApiQueryError && error.status === 404) return false;
  return failureCount < 3;
}

/**
 * True for any error this app's hub requests throw to mean "the hub no
 * longer recognizes this session" — a 401 from `useAPIQuery` surfaces as
 * `UnauthenticatedError`, everywhere else (mutations, hand-rolled fetches
 * in `agents-api.ts`/`routines-api.ts`/etc.) as an `ApiQueryError` whose
 * `status` is 401. Both mean the same thing: the DB was reset, the
 * session's user was deleted, or the cookie simply expired mid-session.
 */
export function isAuthInvalidError(error: unknown): boolean {
  if (error instanceof UnauthenticatedError) return true;
  return error instanceof ApiQueryError && error.status === 401;
}

/**
 * One QueryClient for the signed-in shell, wired so ANY query or mutation
 * that discovers the session is no longer valid — a restarted hub on an
 * empty DB, a cookie for a deleted user, a session that simply expired —
 * routes the whole app back to the login screen, not just the one widget
 * that happened to notice. Without this, a query that 401s renders its own
 * local "sign in required" box while the rest of the shell (nav, other
 * panels) keeps rendering as if nothing happened — the broken half-state
 * this hook exists to prevent. `onAuthInvalid` is called at most once per
 * invalid-session discovery; the caller is responsible for making it
 * idempotent (main.tsx's `handleSignOut` already is).
 */
export function createAppQueryClient(
  onAuthInvalid: () => void = () => undefined,
): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isAuthInvalidError(error)) onAuthInvalid();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isAuthInvalidError(error)) onAuthInvalid();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetryQuery,
      },
    },
  });
}

/** Stable identity-scoped keys — survive a bench switch. */
export const meKeys = {
  profile: ["me", "profile"] as const,
  principals: ["me", "principals"] as const,
  workbenchTenancyKinds: (tenantIds: readonly string[]) =>
    ["me", "workbench-tenancy-kinds", [...tenantIds].sort()] as const,
};

/** Tenant-scoped keys — removed wholesale when the user leaves a bench. */
export const tenantKeys = {
  all: (tenantId: string) => ["tenant", tenantId] as const,
  pendingApprovals: (tenantId: string) =>
    ["tenant", tenantId, "approvals"] as const,
  /** One agent-name read per run, shared by every approval that run raised
   * (see `pending-approvals.ts`). */
  runView: (tenantId: string, runId: string) =>
    ["tenant", tenantId, "runs", runId] as const,
  routines: (tenantId: string) => ["tenant", tenantId, "routines"] as const,
  availableCatalogWorkflows: (tenantId: string) =>
    ["tenant", tenantId, "routines", "available"] as const,
  skills: (tenantId: string) => ["tenant", tenantId, "skills"] as const,
  mcpServers: (tenantId: string) =>
    ["tenant", tenantId, "mcp-servers"] as const,
  routineRuns: (tenantId: string, routineId: string) =>
    ["tenant", tenantId, "routines", routineId, "runs"] as const,
  routineRunHistories: (tenantId: string) =>
    ["tenant", tenantId, "routine-run-histories"] as const,
  definitions: (tenantId: string) =>
    ["tenant", tenantId, "definitions"] as const,
  agentDirectory: (tenantId: string) =>
    ["tenant", tenantId, "agents", "directory"] as const,
  /** The sidebar's unified list of agent-DM candidates: own + ancestor
   * definitions (see `@corbits/agent-directory`'s `listVisibleAgentDefinitions`).
   * Kept apart from `agentDirectory` above, which is a different surface's
   * own key. */
  visibleAgents: (tenantId: string) =>
    ["tenant", tenantId, "agents", "visible"] as const,
  assets: (tenantId: string) => ["tenant", tenantId, "assets"] as const,
  artifacts: (tenantId: string) => ["tenant", tenantId, "artifacts"] as const,
  // Nested under `artifacts` (not a sibling key) so one
  // `invalidateQueries({ queryKey: tenantKeys.artifacts(tenantId) })` after
  // an upload covers both the list and the kind-nav counts.
  artifactCounts: (tenantId: string) =>
    ["tenant", tenantId, "artifacts", "counts"] as const,
  /** Settings section-nav gating (People/Roles/Grants/Credentials). Keyed
   * so col2's nav band and the settings stage — mounted in separate
   * subtrees — share one cached probe instead of each firing its own. */
  settingsAccess: (tenantId: string, principalId: string) =>
    ["tenant", tenantId, "settings-access", principalId] as const,
  /** Delegates to `@corbits/chat-ui`'s own key builder — that package owns
   * both the workbenches endpoint and `WorkbenchKind`, so this is the one array
   * shape every workbench-listing surface (bench-activity, command palette,
   * the Routines picker, `ChatWorkspace`'s own sidebar) keys against,
   * rather than each side of the app/package boundary keeping its own copy
   * of the literal that could drift apart. */
  workbenches: (tenantId: string, kind: WorkbenchKind) =>
    workbenchesQueryKey(tenantId, kind),
  topLevelRuns: (tenantId: string) =>
    ["tenant", tenantId, "top-level-runs"] as const,
  /** A workbench's own timeline reads (CL-6224): `tenantId` is the owning
   * bench chat's workbench-tenancy addresses these routes at (see
   * docs/workbench-tenancy.md), `workbenchId` the workbench's own id. */
  workbenchMessages: (tenantId: string, workbenchId: string) =>
    [
      "tenant",
      tenantId,
      "chat",
      "workbenches",
      workbenchId,
      "messages",
    ] as const,
  workbenchThreads: (tenantId: string, workbenchId: string) =>
    [
      "tenant",
      tenantId,
      "chat",
      "workbenches",
      workbenchId,
      "threads",
    ] as const,
  workbenchTimelineRoutineRuns: (tenantId: string, workbenchId: string) =>
    [
      "tenant",
      tenantId,
      "workbench-timeline-routine-runs",
      workbenchId,
    ] as const,
};

/**
 * Every surface that runs a routine (the routine panel's Run now button,
 * the shell context menu's Run now item) must refresh the same two reads —
 * the routines list and its run history — or one of them goes stale while
 * the other doesn't.
 */
export function invalidateRoutineQueries(
  queryClient: QueryClient,
  tenantId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: tenantKeys.routines(tenantId),
  });
  void queryClient.invalidateQueries({
    queryKey: tenantKeys.routineRunHistories(tenantId),
  });
}

/**
 * Map a hub GET path onto a stable query key. Unknown paths fall back to a
 * path-keyed entry so callers cannot accidentally share cache entries.
 */
export function pathToQueryKey(path: string): readonly unknown[] {
  if (path === "/api/me") return meKeys.profile;
  if (path === "/api/me/principals") return meKeys.principals;
  const approvals = /^\/api\/tenants\/([^/]+)\/approvals$/.exec(path);
  if (approvals?.[1] !== undefined) {
    return tenantKeys.pendingApprovals(approvals[1]);
  }
  const assets = /^\/api\/tenants\/([^/]+)\/assets$/.exec(path);
  if (assets?.[1] !== undefined) return tenantKeys.assets(assets[1]);
  const artifactCounts = /^\/api\/tenants\/([^/]+)\/artifacts\/counts$/.exec(
    path,
  );
  if (artifactCounts?.[1] !== undefined) {
    return tenantKeys.artifactCounts(artifactCounts[1]);
  }
  const artifacts = /^\/api\/tenants\/([^/]+)\/artifacts(?:\?(.*))?$/.exec(
    path,
  );
  if (artifacts?.[1] !== undefined) {
    return [...tenantKeys.artifacts(artifacts[1]), artifacts[2] ?? ""] as const;
  }
  return ["path", path];
}
