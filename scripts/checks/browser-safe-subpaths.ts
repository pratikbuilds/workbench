// check:browser-safe-subpaths — a package that declares a "browser-safe"
// subpath (`@corbits/inbox/client`, `@corbits/workflows/client`, …) is
// making a promise: nothing reachable from that one entry point pulls in
// a server-only dependency. Comments have said as much for a while; this
// check is what actually makes it true, by walking the real transitive
// import graph — relative imports and `@corbits/*` workspace subpath
// imports — starting at each declared entry, and failing if it ever
// reaches `postgres`, `drizzle-orm`, `hono`, or any `@intx/*` import.
//
// `import type` / `export type` statements are skipped: a type-only
// import is erased at compile time and carries no runtime dependency
// (see e.g. packages/inbox/src/project.ts's type-only `@corbits/mailbox`
// import). A package this repo doesn't own (an external git dependency
// like `@corbits/mailbox` or `@corbits/react-ui`) is an opaque leaf — its
// own source isn't in this tree to walk, so it can't be statically
// checked here and is trusted the same way a `node_modules` import
// always is.
//
// New browser-safe subpaths need an explicit ruling in ENTRIES below —
// this check only walks what it's told to. A package.json declaring the
// conventional `./client` subpath with no matching ENTRIES ruling is
// itself a violation, so a new client can't be silently forgotten; a
// non-conventional browser-safe subpath (like api-query's `./envelope`)
// still needs to be added to ENTRIES by hand.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const SCAN_GLOB = "packages/**/*.{ts,tsx}";

export interface PackageManifest {
  readonly name: string;
  readonly exports: Readonly<Record<string, string>>;
}

export interface BrowserSafeEntry {
  readonly package: string;
  /** An `exports` key, e.g. `"./client"` or `"."`. */
  readonly subpath: string;
}

/**
 * The declared browser-safe subpaths this check enforces. Each of these
 * packages carries a header comment / README claim that nothing server-
 * only reaches this entry point — this is what backs that claim.
 */
export const ENTRIES: readonly BrowserSafeEntry[] = [
  { package: "@corbits/inbox", subpath: "./client" },
  { package: "@corbits/insights", subpath: "./client" },
  { package: "@corbits/agent-directory", subpath: "./client" },
  { package: "@corbits/bench", subpath: "./client" },
  { package: "@corbits/preferences", subpath: "./client" },
  { package: "@corbits/api-query", subpath: "." },
  // The envelope alone (UnauthenticatedError, ApiQueryError, toAPIQuery) has
  // no React/JSX dependency, so packages without `jsx` configured (e.g.
  // @corbits/bench, @corbits/preferences) import this subpath rather than
  // the root, which drags in query-view.tsx.
  { package: "@corbits/api-query", subpath: "./envelope" },
  // CL-6099: the Inference settings section (packages/inference-settings)
  // imports this for its known-provider base URL seeds — plain data, no
  // HTTP, so it is safe alongside the other browser-facing subpaths above.
  // @corbits/presence's "." export reaches ./routes, and through it the
  // whole @intx/hub-api server graph. Its two browser halves — the
  // transport client and the pure per-principal color function — are
  // subpaths precisely so a browser package never pulls that in.
  { package: "@corbits/presence", subpath: "./client" },
  { package: "@corbits/presence", subpath: "./color" },
  // @corbits/approvals' root reaches @intx/authz for the grant-allowance
  // gate; `headlineFor` is pure string work over a tool snapshot, so the
  // browser composes an approval's headline through this subpath.
  { package: "@corbits/approvals", subpath: "./headline" },
  // CL-7373: the workflow source-tree constants, the definition-detail
  // wire schema, and the pure lifecycle derivation — the same read
  // `apps/web`'s workflow detail page (`workflow-detail-api.ts`) needs.
  { package: "@corbits/workflows", subpath: "./client" },
];

const DENYLIST_PATTERNS: readonly RegExp[] = [
  /^@intx\//,
  /^hono(\/|$)/,
  /^postgres(\/|$)/,
  /^drizzle-orm(\/|$)/,
  /^node:/,
];

function isDenylisted(specifier: string): boolean {
  return DENYLIST_PATTERNS.some((pattern) => pattern.test(specifier));
}

function entryLabel(entry: BrowserSafeEntry): string {
  if (entry.subpath === ".") return entry.package;
  return `${entry.package}/${entry.subpath.replace(/^\.\//, "")}`;
}

interface ImportSpecifier {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/**
 * Blanks out line and block comments, preserving offsets and newlines so
 * the patterns below cannot match prose. Without this, a comment
 * mentioning the word `import` before a real import swallows the lines
 * between them — `[^;]*?` spans newlines — and reports the file's genuine
 * type-only import as a value import.
 */
export function stripComments(contents: string): string {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

/**
 * Extracts every static `from "..."` import/export specifier from a
 * source file, plus dynamic `import("...")` and bare side-effect
 * `import "...";` forms. A statement is `typeOnly` only when the whole
 * statement is `import type` / `export type` — a mixed statement like
 * `import { type X, y } from "z"` is conservatively treated as a value
 * import, since `y` really is one.
 */
export function parseImportSpecifiers(source: string): ImportSpecifier[] {
  const contents = stripComments(source);
  const results: ImportSpecifier[] = [];

  const fromPattern =
    /\b(import|export)\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']/g;
  for (const match of contents.matchAll(fromPattern)) {
    const specifier = match[3];
    if (specifier === undefined) continue;
    results.push({ specifier, typeOnly: match[2] !== undefined });
  }

  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']/g;
  for (const match of contents.matchAll(dynamicPattern)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    results.push({ specifier, typeOnly: false });
  }

  const sideEffectPattern = /\bimport\s+["']([^"']+)["']\s*;/g;
  for (const match of contents.matchAll(sideEffectPattern)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    results.push({ specifier, typeOnly: false });
  }

  return results;
}

function resolveRelative(
  fromRelPath: string,
  specifier: string,
  files: ReadonlyMap<string, string>,
): string | undefined {
  const dir = path.posix.dirname(fromRelPath);
  const base = path.posix.normalize(path.posix.join(dir, specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function splitPackageSpecifier(specifier: string): {
  packageName: string;
  rest: string;
} {
  const segments = specifier.split("/");
  const packageName = segments.slice(0, 2).join("/");
  const rest = segments.slice(2).join("/");
  return { packageName, rest };
}

/**
 * `./client` is this repo's naming convention for a browser-safe subpath
 * (inbox, insights, agent-directory, presence, bench,
 * preferences all use it) — a package that declares one is making the same
 * "nothing server-only reaches here" promise ENTRIES exists to check, so a
 * declared `./client` with no ENTRIES ruling is itself a violation, not a
 * silent skip.
 */
const CONVENTIONAL_SUBPATH = "./client";

function findUnruledClientExports(
  entries: readonly BrowserSafeEntry[],
  packages: readonly PackageManifest[],
): string[] {
  const ruled = new Set(
    entries.map((entry) => `${entry.package}${entry.subpath}`),
  );
  const violations: string[] = [];
  for (const pkg of packages) {
    if (pkg.exports[CONVENTIONAL_SUBPATH] === undefined) continue;
    if (ruled.has(`${pkg.name}${CONVENTIONAL_SUBPATH}`)) continue;
    violations.push(
      `${pkg.name} declares a "${CONVENTIONAL_SUBPATH}" export with no ` +
        `ENTRIES ruling in scripts/checks/browser-safe-subpaths.ts — add ` +
        `{ package: "${pkg.name}", subpath: "${CONVENTIONAL_SUBPATH}" } to ENTRIES.`,
    );
  }
  return violations;
}

/**
 * Walks the transitive import graph of every declared entry and reports
 * a violation for each denylisted import reached, and for any import
 * this check cannot resolve (a broken relative import, or a workspace
 * package subpath not declared in that package's own `exports`) — an
 * unresolvable import is exactly the kind of drift this check exists to
 * catch, not something to silently skip.
 */
export function auditBrowserSafeSubpaths(
  entries: readonly BrowserSafeEntry[],
  packages: readonly PackageManifest[],
  files: ReadonlyMap<string, string>,
): CheckReport {
  const report = emptyReport();

  report.violations.push(...findUnruledClientExports(entries, packages));

  for (const entry of entries) {
    const label = entryLabel(entry);
    const manifest = packages.find((pkg) => pkg.name === entry.package);
    if (manifest === undefined) {
      report.violations.push(
        `${label}: no package named "${entry.package}" found.`,
      );
      continue;
    }
    const entryRelPath = manifest.exports[entry.subpath];
    if (entryRelPath === undefined) {
      report.violations.push(
        `${label}: "${entry.package}" declares no "${entry.subpath}" export.`,
      );
      continue;
    }

    const visited = new Set<string>();
    const stack: { relPath: string; chain: readonly string[] }[] = [
      { relPath: entryRelPath, chain: [entryRelPath] },
    ];
    let reached = 0;

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const { relPath, chain } = current;
      if (visited.has(relPath)) continue;
      visited.add(relPath);
      reached += 1;

      const contents = files.get(relPath);
      if (contents === undefined) {
        report.violations.push(
          `${label}: cannot read "${relPath}" (chain: ${chain.join(" -> ")}).`,
        );
        continue;
      }

      for (const { specifier, typeOnly } of parseImportSpecifiers(contents)) {
        if (typeOnly) continue;

        if (isDenylisted(specifier)) {
          report.violations.push(
            `${label}: reaches server-only import "${specifier}" via ` +
              `${relPath} (chain: ${chain.join(" -> ")} -> ${specifier}).`,
          );
          continue;
        }

        if (specifier.startsWith(".")) {
          const resolved = resolveRelative(relPath, specifier, files);
          if (resolved === undefined) {
            report.violations.push(
              `${label}: cannot resolve "${specifier}" imported from "${relPath}".`,
            );
            continue;
          }
          stack.push({ relPath: resolved, chain: [...chain, resolved] });
          continue;
        }

        if (specifier.startsWith("@corbits/")) {
          const { packageName, rest } = splitPackageSpecifier(specifier);
          const depManifest = packages.find((pkg) => pkg.name === packageName);
          if (depManifest === undefined) continue; // external dependency, opaque leaf
          const key = rest === "" ? "." : `./${rest}`;
          const target = depManifest.exports[key];
          if (target === undefined) {
            report.violations.push(
              `${label}: "${specifier}" imported from "${relPath}" has no ` +
                `declared "${key}" export in ${packageName}'s package.json.`,
            );
            continue;
          }
          stack.push({ relPath: target, chain: [...chain, target] });
          continue;
        }

        // A bare external module (arktype, react, lucide-react, …) that
        // isn't denylisted: a leaf, nothing further to resolve.
      }
    }

    report.notes.push(
      `${label}: ${reached} file(s) in its import graph, clean.`,
    );
  }

  return report;
}

async function scanPackageManifests(root: string): Promise<PackageManifest[]> {
  const manifests: PackageManifest[] = [];
  const glob = new Glob("packages/*/package.json");
  for await (const relPath of glob.scan({ cwd: root, dot: false })) {
    const raw: unknown = await Bun.file(path.join(root, relPath)).json();
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("name" in raw) ||
      typeof raw.name !== "string"
    ) {
      continue;
    }
    const exportsField =
      "exports" in raw &&
      typeof raw.exports === "object" &&
      raw.exports !== null
        ? (raw.exports as Record<string, unknown>)
        : {};
    const packageDir = path.posix.dirname(relPath);
    const exportsMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(exportsField)) {
      if (typeof value !== "string") continue;
      exportsMap[key] = path.posix.normalize(
        path.posix.join(packageDir, value),
      );
    }
    manifests.push({ name: raw.name, exports: exportsMap });
  }
  return manifests;
}

async function scanSourceFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const glob = new Glob(SCAN_GLOB);
  for await (const relPath of glob.scan({ cwd: root, dot: false })) {
    if (relPath.includes("node_modules/")) continue;
    if (relPath.includes("/dist/") || relPath.startsWith("dist/")) continue;
    files.set(relPath, await Bun.file(path.join(root, relPath)).text());
  }
  return files;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = rootFromArgs(args);
  const [packages, files] = await Promise.all([
    scanPackageManifests(root),
    scanSourceFiles(root),
  ]);
  const report = auditBrowserSafeSubpaths(ENTRIES, packages, files);
  reportAndExit("check:browser-safe-subpaths", report);
}

if (import.meta.main) await main();
