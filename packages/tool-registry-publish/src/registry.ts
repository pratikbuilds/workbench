// The one site naming the tenant-scoped package-registry asset that
// resolves `@corbits/*` tool-package pins, and the packages published
// into it. A rename or an added package changes one file instead of
// chasing string literals across `apps/hub` (scope routing) and every
// publish call site — the same reasoning `WORKSPACE_BUILTINS_REGISTRY`
// documents in vendor/intx/hub-sessions/src/package-registry-kind.ts.

/**
 * Asset name the hub's `@corbits` scope routing resolves tool-package
 * pins against (`apps/hub/src/index.ts`'s `CORBITS_TOOLS_REGISTRY`).
 * Kept here so the publisher and the hub's scope-routing config read
 * the same literal.
 */
export const CORBITS_TOOLS_REGISTRY = "corbits-tools";

/**
 * Package names a seeded `corbits-tools` registry must carry for the
 * default workflow set to launch. Default workflows pin at least these
 * (Myra's assistant pins `@corbits/memory-tools`); an empty or dangling
 * registry — a package-registry row whose git repo has no tarball
 * commits — is not seeded.
 */
export const REQUIRED_SEED_TOOL_PACKAGES = ["@corbits/memory-tools"] as const;

/** True when `filename` is an npm-style tarball for `packageName` (any version). */
export function tarballCoversPackage(
  filename: string,
  packageName: string,
): boolean {
  const prefix = `${packageName.replace(/^@/, "").replace("/", "-")}-`;
  return filename.startsWith(prefix) && filename.endsWith(".tgz");
}

/**
 * Whether a tarball listing is enough for first-run launch: non-empty
 * and covering every `REQUIRED_SEED_TOOL_PACKAGES` entry. An empty list
 * is the dangling-asset case (`GET tarballs` → `[]` after git init with
 * no commit).
 */
export function tarballsCoverRequiredSeedPackages(
  filenames: Iterable<string>,
): boolean {
  const list = [...filenames];
  if (list.length === 0) return false;
  return REQUIRED_SEED_TOOL_PACKAGES.every((name) =>
    list.some((filename) => tarballCoversPackage(filename, name)),
  );
}

/**
 * Absolute directories of the `@corbits/*-tools` packages published
 * into the `corbits-tools` registry. Every workflow's
 * `toolPackagePins` under the `@corbits` scope must name a package
 * listed here, or its pin never resolves. `capability-tools`
 * (CL-6084/CL-6086) is published here and pinned into every drafted
 * agent's default tool-package set — see `@corbits/capability-tools`'s
 * README for how its request_capability tool reaches the hub.
 */
export const CORBITS_TOOL_PACKAGE_DIRS: readonly string[] = [
  new URL("../../memory-tools", import.meta.url).pathname,
  new URL("../../capability-tools", import.meta.url).pathname,
  new URL("../../connections-tools", import.meta.url).pathname,
  new URL("../../catalog-tools", import.meta.url).pathname,
  new URL("../../agent-directory-tools", import.meta.url).pathname,
  new URL("../../interaction-tools", import.meta.url).pathname,
  new URL("../../skills-tools", import.meta.url).pathname,
  new URL("../../mcp-tools", import.meta.url).pathname,
  new URL("../../tools-skills", import.meta.url).pathname,
  new URL("../../github-tools", import.meta.url).pathname,
  new URL("../../web-search-tools", import.meta.url).pathname,
  new URL("../../granola-tools", import.meta.url).pathname,
  new URL("../../manus-tools", import.meta.url).pathname,
  new URL("../../linear-tools", import.meta.url).pathname,
  new URL("../../workflow-authoring-tools", import.meta.url).pathname,
  // Scout's own artifact-save/list tool bundle (`scoutArtifactTools`) and
  // Jimmy's `gif_search` bundle: each package pins itself in its own
  // `toolPackagePins` (`SCOUT_TOOL_PACKAGE_PINS`, `JIMMY_TOOL_PACKAGE_PINS`),
  // so each must publish here too or that self-pin never resolves.
  new URL("../../scout-agent", import.meta.url).pathname,
  new URL("../../jimmy-agent", import.meta.url).pathname,
];
