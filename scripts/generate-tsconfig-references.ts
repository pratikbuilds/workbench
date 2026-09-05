// Derives each package's composite project settings from its own
// package.json `dependencies` (not `devDependencies` — a dev-only edge is
// not a type dependency and is the easiest way to introduce a spurious
// cycle) and a combined `tsconfig.json` that type-checks `src` + `test`
// together. Run with `--check` to fail instead of write, for use in
// `check:tsconfig-references`.
//
// Two tsconfigs per package, not one, and the composite one is NOT named
// `tsconfig.json` -- for two independent reasons:
//
// 1. A composite project's `references` must form a DAG, and test files
//    routinely break that: they import `scripts/e2e/harness.ts` (a shared
//    test helper, not a workspace package) which itself imports production
//    packages like `@corbits/seeding` -- so a package upstream of
//    `seeding` whose *tests* import the harness would otherwise put
//    that package's own composite project in a cycle with itself.
// 2. Every tool that discovers a project by convention -- ESLint's
//    `projectService`, an editor's language server, a bare `tsc` in the
//    package directory -- looks for a file literally named `tsconfig.json`
//    and does not know to also check a same-purpose file under a different
//    name. Naming the composite src-only project `tsconfig.src.json`
//    instead keeps `tsconfig.json` as the combined, conventionally-named
//    project every such tool finds on its own; only `tsc --build` and the
//    `references` of composite dependents need to know the other name
//    exists, and they do so via an explicit path
//    (`{"path": "../dep/tsconfig.src.json"}`, not a bare directory).
//
// Splitting src (composite, referenced by dependents, built by
// `tsc --build`) from the combined project (a leaf nothing depends on, so
// it can reference anything without risking a cycle) removes that whole
// class of failure.
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { Glob } from "bun";

const WORKSPACE_ROOTS = [
  "apps",
  "packages",
  "tools",
  "workflows",
  "vendor/intx",
] as const;

const SRC_CONFIG_NAME = "tsconfig.src.json";

type PackageManifest = {
  readonly name: string;
  readonly dir: string;
  readonly workspaceDeps: readonly string[];
};

async function readManifests(): Promise<PackageManifest[]> {
  const manifests: PackageManifest[] = [];
  for (const root of WORKSPACE_ROOTS) {
    const glob = new Glob(`${root}/*/package.json`);
    for await (const manifestPath of glob.scan(".")) {
      const raw = (await Bun.file(manifestPath).json()) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      const dir = manifestPath.slice(0, -"/package.json".length);
      manifests.push({
        name: raw.name ?? dir,
        dir,
        workspaceDeps: Object.entries(raw.dependencies ?? {})
          .filter(([, range]) => range.startsWith("workspace:"))
          .map(([dep]) => dep),
      });
    }
  }
  return manifests;
}

type Tsconfig = {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  references?: { path: string }[];
  [key: string]: unknown;
};

const BUILD_COMPILER_OPTIONS = {
  composite: true,
  emitDeclarationOnly: true,
  outDir: "dist",
  tsBuildInfoFile: "dist/tsconfig.tsbuildinfo",
};

const COMBINED_COMPILER_OPTIONS = {
  composite: false,
  noEmit: true,
  disableSourceOfProjectReferenceRedirect: true,
  // `noEmit` alone does not turn off `rootDir` enforcement -- TypeScript
  // still computes it for declaration output whenever `declaration` is on,
  // which every project inherits from tsconfig.base.json. This project
  // reaches test helpers and, through them, whatever those helpers import,
  // all outside its own package directory; declaration output was never
  // wanted here, so switch off everything that makes TypeScript care where
  // those files live.
  declaration: false,
  declarationMap: false,
  emitDeclarationOnly: false,
  // Left unset, `extends` inherits tsBuildInfoFile: "dist/tsconfig.tsbuildinfo"
  // from tsconfig.src.json, so the combined project's --noEmit check and the
  // composite build write the same file and each invalidates the other's
  // incremental state. Giving the combined project its own path (next to
  // this tsconfig.json, since there's no outDir here to nest it under)
  // keeps the two builds independent.
  tsBuildInfoFile: "tsconfig.tsbuildinfo",
};

/**
 * TypeScript project references must form a DAG: a single cycle anywhere
 * makes `tsc --build` refuse the whole graph. The workspace's real `src`
 * `dependencies` graph has one strongly-connected component (a handful of
 * packages depend on each other, directly or transitively), so edges that
 * stay inside the same component are dropped from `references` — those
 * packages keep resolving each other's types via plain source imports,
 * same as before this change, just without the composite build's
 * skip-if-up-to-date benefit between themselves.
 */
function stronglyConnectedComponents(
  manifests: readonly PackageManifest[],
): ReadonlyMap<string, number> {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  let counter = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();
  let nextComponentId = 0;

  function strongconnect(v: string): void {
    indices.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of byName.get(v)?.workspaceDeps ?? []) {
      if (!byName.has(w)) continue;
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(
          v,
          Math.min(lowlink.get(v) as number, lowlink.get(w) as number),
        );
      } else if (onStack.has(w)) {
        lowlink.set(
          v,
          Math.min(lowlink.get(v) as number, indices.get(w) as number),
        );
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const id = nextComponentId;
      nextComponentId += 1;
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        componentOf.set(member, id);
      } while (member !== v);
    }
  }

  for (const manifest of manifests) {
    if (!indices.has(manifest.name)) strongconnect(manifest.name);
  }
  return componentOf;
}

/**
 * Packages in a multi-member strongly-connected component don't just drop
 * the edges *within* that component (handled by `stronglyConnectedComponents`
 * above) -- in practice the file-level import cycle that remains once one
 * edge is dropped from a composite `--build` graph makes `tsc --build`
 * pathologically slow (observed: single packages that never finished within
 * five minutes, well past the 600s gate cap). These packages are excluded
 * from the composite graph entirely rather than half-participating in it;
 * see `cyclicNames` in `main`.
 */
function srcReferencePathsFor(
  manifest: PackageManifest,
  byName: ReadonlyMap<string, PackageManifest>,
  withTsconfig: ReadonlySet<string>,
  cyclicNames: ReadonlySet<string>,
): string[] {
  const paths: string[] = [];
  for (const dep of manifest.workspaceDeps) {
    const target = byName.get(dep);
    if (target === undefined || !withTsconfig.has(target.name)) continue;
    if (cyclicNames.has(target.name)) continue;
    const rel = relative(manifest.dir, target.dir) || ".";
    const relDir = rel.startsWith(".") ? rel : `./${rel}`;
    paths.push(`${relDir}/${SRC_CONFIG_NAME}`);
  }
  return paths.sort();
}

/**
 * `scripts/e2e/harness.ts`, `scripts/db-setup.ts` and `test/isolation/setup.ts`
 * are shared test/setup helpers that many packages import by relative path
 * -- they are not workspace packages (no `package.json` dependency records
 * the edge), are not composite, and pull in production packages themselves
 * (`harness.ts` imports `@corbits/seeding`), so they can never
 * legally appear in a `references` array. A package's `test/` directory
 * importing one is fine -- the combined non-composite project resolves it
 * via plain source, same as any other undeclared import. A package's `src`
 * importing one is not: a composite project cannot cross its rootDir via an
 * undeclared relative import, so such a package is excluded from the
 * composite graph entirely (see `excludedNames` in `main`), the same
 * treatment as a real dependency cycle.
 */
const ROOT_SCRIPT_MARKERS = [
  /(?:from|import\()\s*["'][^"'\n]*scripts\/e2e[^"'\n]*["']/,
  /(?:from|import\()\s*["'][^"'\n]*scripts\/db-setup[^"'\n]*["']/,
  /(?:from|import\()\s*["'][^"'\n]*test\/isolation[^"'\n]*["']/,
] as const;

// Matched as an import specifier (quoted), not a substring anywhere in the
// file -- a comment mentioning "scripts/db-setup.ts" is not an import of it.
async function importsRootScript(dir: string): Promise<boolean> {
  const glob = new Glob(`${dir}/**/*.ts`);
  for await (const path of glob.scan(".")) {
    if (path.includes("/dist/") || path.includes("/node_modules/")) continue;
    const text = await Bun.file(path).text();
    if (ROOT_SCRIPT_MARKERS.some((pattern) => pattern.test(text))) return true;
  }
  return false;
}

async function loadTsconfig(path: string): Promise<Tsconfig | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return (await file.json()) as Tsconfig;
}

// Colocated unit tests (`src/**/*.test.ts`, see AGENTS.md) commonly reach
// outside `src` -- into the package's own `package.json`, or a `test/`
// fixtures module -- which the composite src project cannot allow across
// its rootDir. They are excluded here and picked up by the combined
// project's `include` instead, alongside a dedicated `test/` directory
// when present.
function withSrcFields(
  dir: string,
  config: Tsconfig,
  referencePaths: readonly string[],
): Tsconfig {
  const {
    compilerOptions,
    references: _oldReferences,
    include,
    exclude: _oldExclude,
    extends: _oldExtends,
    ...rest
  } = config;
  return {
    // Not hand-copied from the seed: `vendor/intx/*` sits one directory
    // deeper than `apps/*`/`packages/*`/`tools/*`/`workflows/*`, so a fixed
    // "../../" string resolves to a path that doesn't exist for it -- an
    // unresolvable `extends` silently drops everything the base config
    // sets, `skipLibCheck` included, and node_modules' own .d.ts files
    // start failing the build.
    extends: `${relative(dir, ".")}/tsconfig.base.json`,
    ...rest,
    include: [
      ...(include ?? ["src"]).filter(
        (entry) =>
          entry !== "test" &&
          entry !== "package.json" &&
          entry !== "src/**/*.json",
      ),
      "package.json",
      "src/**/*.json",
    ],
    exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    compilerOptions: { ...compilerOptions, ...BUILD_COMPILER_OPTIONS },
    ...(referencePaths.length > 0
      ? { references: referencePaths.map((path) => ({ path })) }
      : {}),
  };
}

// A cyclic package keeps the pre-change shape: no composite settings, no
// references, `src` + `test` checked together as one non-build project. It
// is excluded from `tsc --build` and checked separately; see
// scripts/typecheck.ts.
function withLegacyFields(config: Tsconfig): Tsconfig {
  const {
    compilerOptions,
    references: _oldReferences,
    include,
    exclude: _oldExclude,
    ...rest
  } = config;
  const {
    composite: _c,
    emitDeclarationOnly: _e,
    outDir: _o,
    tsBuildInfoFile: _t,
    ...restOptions
  } = compilerOptions ?? {};
  const cleanedInclude = (include ?? ["src"]).filter(
    (entry) => entry !== "package.json" && entry !== "src/**/*.json",
  );
  return {
    ...rest,
    include: cleanedInclude.includes("test")
      ? cleanedInclude
      : [...cleanedInclude, "test"],
    compilerOptions: { ...restOptions, noEmit: true },
  };
}

function legacyFieldsMatch(current: Tsconfig, next: Tsconfig): boolean {
  const currentOptions = current.compilerOptions ?? {};
  for (const key of Object.keys(BUILD_COMPILER_OPTIONS)) {
    if (key in currentOptions) return false;
  }
  if (currentOptions.noEmit !== true) return false;
  if (current.references !== undefined) return false;
  return listsMatch(current.include, next.include);
}

// The combined project: everyone's `tsconfig.json` by name, so every tool
// that discovers a project by convention (ESLint's `projectService`, an
// editor, a bare `tsc` invocation) finds it without being told the
// composite project exists at all.
function combinedConfigFor(
  dir: string,
  referencePaths: readonly string[],
  hasTestDir: boolean,
  extraInclude: readonly string[],
): Tsconfig {
  const baseInclude = hasTestDir ? ["src", "test"] : ["src"];
  return {
    extends: `./${SRC_CONFIG_NAME}`,
    compilerOptions: {
      ...COMBINED_COMPILER_OPTIONS,
      // `extends` still carries `outDir: "dist"` down from the composite
      // src config. With an `outDir` but no explicit `rootDir`, TypeScript
      // infers `rootDir` from `include` alone -- "src" and "test" -- not
      // from the full set of files the program actually reaches. A test
      // file importing a shared test helper (which itself imports whatever
      // production code that helper touches) reaches files nowhere near
      // "src"/"test", and TS6059s on every one of them despite `noEmit`.
      // An explicit `rootDir` at the repository root is a real ancestor of
      // every file the workspace can ever reach, so the check always
      // passes; nothing is emitted here regardless.
      rootDir: relative(dir, ".") || ".",
    },
    // A package can have content outside src/test that nothing else here
    // knows about (packages/e2b-sandbox-sidecar's `template/`, a sandbox
    // asset tree read at runtime, not imported) -- carried forward from
    // whatever the package's own tsconfig.json already declared rather
    // than silently dropped by rebuilding `include` from a fixed list.
    include: [...new Set([...baseInclude, ...extraInclude])],
    exclude: [],
    ...(referencePaths.length > 0
      ? { references: referencePaths.map((path) => ({ path })) }
      : {}),
  };
}

// Formatting is prettier's job (enforced separately by `bun run lint`), so
// drift is judged on the meaningful fields only, not on whitespace.
function srcFieldsMatch(current: Tsconfig, next: Tsconfig): boolean {
  if (current.extends !== next.extends) return false;
  const currentOptions = current.compilerOptions ?? {};
  const nextOptions = next.compilerOptions ?? {};
  for (const key of Object.keys(BUILD_COMPILER_OPTIONS)) {
    if (currentOptions[key] !== nextOptions[key]) return false;
  }
  if (!referencesMatch(current.references, next.references)) return false;
  if (!listsMatch(current.include, next.include)) return false;
  return listsMatch(
    current.exclude as string[] | undefined,
    next.exclude as string[] | undefined,
  );
}

function listsMatch(
  current: readonly string[] | undefined,
  next: readonly string[] | undefined,
): boolean {
  const a = [...(current ?? [])].sort();
  const b = [...(next ?? [])].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function referencesMatch(
  current: Tsconfig["references"],
  next: Tsconfig["references"],
): boolean {
  const currentPaths = (current ?? []).map((r) => r.path).sort();
  const nextPaths = (next ?? []).map((r) => r.path).sort();
  return (
    currentPaths.length === nextPaths.length &&
    currentPaths.every((path, i) => path === nextPaths[i])
  );
}

function combinedFieldsMatch(
  current: Tsconfig | undefined,
  next: Tsconfig,
): boolean {
  if (current === undefined) return false;
  const currentOptions = current.compilerOptions ?? {};
  const nextOptions = next.compilerOptions ?? {};
  for (const key of [...Object.keys(COMBINED_COMPILER_OPTIONS), "rootDir"]) {
    if (currentOptions[key] !== nextOptions[key]) return false;
  }
  if (current.extends !== next.extends) return false;
  return (
    referencesMatch(current.references, next.references) &&
    listsMatch(current.include, next.include)
  );
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const manifests = await readManifests();
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const componentOf = stronglyConnectedComponents(manifests);
  const componentSizes = new Map<number, number>();
  for (const id of componentOf.values()) {
    componentSizes.set(id, (componentSizes.get(id) ?? 0) + 1);
  }
  const cyclicNames = new Set(
    [...componentOf.entries()]
      .filter(([, id]) => (componentSizes.get(id) ?? 0) > 1)
      .map(([name]) => name),
  );
  const excludedNames = new Set(cyclicNames);
  for (const manifest of manifests) {
    if (await importsRootScript(`${manifest.dir}/src`)) {
      excludedNames.add(manifest.name);
    }
  }

  // Excluding a package from the composite graph without also excluding
  // every package that depends on it is not a smaller version of the same
  // fix -- it is broken. A composite project cannot put a non-composite
  // dependency in `references` (no declarations to consume), so it falls
  // back to resolving that dependency's *source* directly. TypeScript then
  // keeps walking that source's own imports -- test helpers included --
  // with no project boundary to stop at, and flags every file it reaches
  // outside the dependent's rootDir. The exclusion has to propagate to
  // every transitive consumer, not just the packages in the cycle itself.
  let excludedGrew = true;
  while (excludedGrew) {
    excludedGrew = false;
    for (const manifest of manifests) {
      if (excludedNames.has(manifest.name)) continue;
      if (manifest.workspaceDeps.some((dep) => excludedNames.has(dep))) {
        excludedNames.add(manifest.name);
        excludedGrew = true;
      }
    }
  }

  // The combined `tsconfig.json` is the thing every package has always
  // had; it's the seed for a composite package's `tsconfig.src.json`
  // (carrying forward any package-specific compilerOptions, like
  // `types: ["bun"]`) and, for a legacy package, the file itself.
  const existingCombined = new Map<string, Tsconfig>();
  for (const manifest of manifests) {
    const config = await loadTsconfig(`${manifest.dir}/tsconfig.json`);
    if (config !== undefined) existingCombined.set(manifest.name, config);
  }
  const withTsconfig = new Set(existingCombined.keys());

  const drifted: string[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  for (const manifest of manifests) {
    const currentCombined = existingCombined.get(manifest.name);
    if (currentCombined === undefined) continue;

    const srcConfigPath = `${manifest.dir}/${SRC_CONFIG_NAME}`;

    if (excludedNames.has(manifest.name)) {
      const nextLegacy = withLegacyFields(currentCombined);
      if (!legacyFieldsMatch(currentCombined, nextLegacy)) {
        if (checkOnly) {
          drifted.push(`${manifest.dir}/tsconfig.json`);
        } else {
          const path = `${manifest.dir}/tsconfig.json`;
          await Bun.write(path, `${JSON.stringify(nextLegacy, null, 2)}\n`);
          written.push(path);
        }
      }
      if (existsSync(srcConfigPath)) {
        if (checkOnly) drifted.push(srcConfigPath);
        else {
          // Removed, not written -- prettier has nothing left to format.
          await Bun.file(srcConfigPath).delete();
          removed.push(srcConfigPath);
        }
      }
      continue;
    }

    const srcReferences = srcReferencePathsFor(
      manifest,
      byName,
      withTsconfig,
      excludedNames,
    );
    // The current tsconfig.src.json (if this isn't the first run) carries
    // any package-specific compilerOptions already merged in; fall back to
    // the combined file only the very first time a package joins the
    // composite graph.
    const srcSeed = (await loadTsconfig(srcConfigPath)) ?? currentCombined;
    const nextSrc = withSrcFields(manifest.dir, srcSeed, srcReferences);
    const currentSrc = await loadTsconfig(srcConfigPath);
    if (currentSrc === undefined || !srcFieldsMatch(currentSrc, nextSrc)) {
      if (checkOnly) {
        drifted.push(srcConfigPath);
      } else {
        await Bun.write(srcConfigPath, `${JSON.stringify(nextSrc, null, 2)}\n`);
        written.push(srcConfigPath);
      }
    }

    const hasTestDir = existsSync(`${manifest.dir}/test`);
    const extraInclude = (currentCombined.include ?? []).filter(
      (entry) => entry !== "src" && entry !== "test",
    );
    const nextCombined = combinedConfigFor(
      manifest.dir,
      srcReferences,
      hasTestDir,
      extraInclude,
    );
    if (!combinedFieldsMatch(currentCombined, nextCombined)) {
      if (checkOnly) {
        drifted.push(`${manifest.dir}/tsconfig.json`);
      } else {
        const path = `${manifest.dir}/tsconfig.json`;
        await Bun.write(path, `${JSON.stringify(nextCombined, null, 2)}\n`);
        written.push(path);
      }
    }

    // `tsconfig.test.json` predates the rename above -- the combined
    // project it held now lives at `tsconfig.json` directly.
    const stalePath = `${manifest.dir}/tsconfig.test.json`;
    if (existsSync(stalePath)) {
      if (checkOnly) {
        drifted.push(stalePath);
      } else {
        await Bun.file(stalePath).delete();
        removed.push(stalePath);
      }
    }
  }

  // `tsc --build` given many unrelated root projects as separate CLI
  // arguments shares source-file/diagnostic state across them in a way that
  // misattributes `rootDir` violations to the wrong project entirely
  // (observed: a clean project reported errors that belonged to a project
  // built earlier in the same invocation). Handing it one root -- a
  // solution file whose only content is `references` to every composite
  // project's tsconfig.src.json -- avoids that: `tsc --build` still walks
  // the full transitive graph and skips whatever is already up to date,
  // but the diagnostic state is no longer split across sibling root
  // arguments.
  const solutionReferences = manifests
    .filter(
      (manifest) =>
        existingCombined.has(manifest.name) &&
        !excludedNames.has(manifest.name),
    )
    .map((manifest) => manifest.dir)
    .sort()
    .map((dir) => ({ path: `./${dir}/${SRC_CONFIG_NAME}` }));
  const solutionPath = "tsconfig.build.json";
  const nextSolution: Tsconfig = {
    files: [],
    references: solutionReferences,
  };
  const currentSolution = await loadTsconfig(solutionPath);
  if (
    currentSolution === undefined ||
    !referencesMatch(currentSolution.references, nextSolution.references)
  ) {
    if (checkOnly) {
      drifted.push(solutionPath);
    } else {
      await Bun.write(
        solutionPath,
        `${JSON.stringify(nextSolution, null, 2)}\n`,
      );
      written.push(solutionPath);
    }
  }

  if (checkOnly && drifted.length > 0) {
    console.error(
      `tsconfig references are out of sync with package.json dependencies in ${drifted.length} file(s):\n${drifted.map((d) => `  ${d}`).join("\n")}\nRun: bun run scripts/generate-tsconfig-references.ts`,
    );
    process.exit(1);
  }

  if (!checkOnly && written.length > 0) {
    const format = Bun.spawn(["bunx", "prettier", "--write", ...written], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await format.exited;
  }
  if (!checkOnly && removed.length > 0) {
    console.error(`removed ${removed.length} stale file(s):`);
    for (const path of removed) console.error(`  ${path}`);
  }
}

await main();
