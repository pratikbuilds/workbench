// Tool-name constants a scorer checks for. Kept in lockstep with each
// manager-tools bundle's own export (see each package's src/tool.ts) —
// tool-names.test.ts pins these against the real bundles so a rename
// there fails this package's tests instead of a scorer silently never
// matching.
export const CREATE_AGENT_TOOL = "create_agent";
export const ROUTINE_CREATE_TOOL = "routine_create";
export const ROUTINE_RUN_NOW_TOOL = "routine_run_now";
export const MEMORY_ADD_TOOL = "memory_add";
export const MEMORY_SEARCH_TOOL = "memory_search";
export const MEMORY_LIST_TOOL = "memory_list";
export const LIST_CONNECTIONS_TOOL = "list_connections";
export const REQUEST_CONNECTION_TOOL = "request_connection";

/** The tools a "build" step uses to stand up real, lasting workbench
 * state — the ones an interview must precede. */
export const BUILD_TOOLS = [CREATE_AGENT_TOOL] as const;

// The shipped GitHub write path (CL-6340 Code Review MVP, PR #62):
// one diff read and one aggregated comment-only review per PR, posted
// by the code-review workflow run itself. Pinned against
// `@corbits/github-tools`' own exports in tool-names.test.ts.
export const GITHUB_PULL_REQUEST_DIFF_TOOL = "github_pull_request_diff";
export const GITHUB_POST_PR_REVIEW_TOOL = "github_post_pr_review";

// Merge-class action name the owner ruling parks behind explicit human
// approval. No such tool exists in `@corbits/github-tools` today —
// posting is comment-only by design — so the parked-merge half of
// `outwardGitHubActionsRespectGrantBoundary` is vacuously satisfiable
// until one ships; the constant names what the scorer watches for.
export const GITHUB_MERGE_PULL_REQUEST_TOOL = "github_merge_pull_request";
