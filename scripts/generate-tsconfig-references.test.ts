// Drives the generator through its real command line against a throwaway
// fixture workspace, the same way run-all.test.ts exercises run-all.ts. This
// script is the only thing standing between package.json's real dependency
// graph and every package's `references` array — a silently wrong graph
// would make `tsc --build` skip stale dependents or, worse, refuse the whole
// build over a phantom cycle.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GENERATOR = join(import.meta.dir, "generate-tsconfig-references.ts");

let workspace = "";

async function writePackage(
  name: string,
  dependencies: Record<string, string> = {},
  options: { withTest?: boolean; srcFile?: string } = {},
): Promise<void> {
  const dir = join(workspace, "packages", name);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: `@fixture/${name}`, dependencies }, null, 2),
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({ extends: "../../tsconfig.base.json" }, null, 2),
  );
  await writeFile(
    join(dir, "src", "index.ts"),
    options.srcFile ?? "export const value = 1;\n",
  );
  if (options.withTest) {
    await mkdir(join(dir, "test"), { recursive: true });
    await writeFile(join(dir, "test", "index.test.ts"), "export {};\n");
  }
}

async function readTsconfig(name: string, file = "tsconfig.json") {
  const path = join(workspace, "packages", name, file);
  return JSON.parse(await Bun.file(path).text()) as {
    extends?: string;
    compilerOptions?: Record<string, unknown>;
    references?: { path: string }[];
    include?: string[];
  };
}

async function tsconfigExists(name: string, file: string): Promise<boolean> {
  return Bun.file(join(workspace, "packages", name, file)).exists();
}

function run(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return (async () => {
    const child = Bun.spawn(["bun", "run", GENERATOR, ...args], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stderr };
  })();
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "workbench-tsconfig-refs-"));
  for (const root of ["apps", "packages", "tools", "workflows"]) {
    await mkdir(join(workspace, root), { recursive: true });
  }
  await mkdir(join(workspace, "vendor", "intx"), { recursive: true });
});

afterEach(async () => {
  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

describe("generate-tsconfig-references", () => {
  test("gives a leaf package's tsconfig.src.json composite settings", async () => {
    await writePackage("leaf");
    await run([]);

    const config = await readTsconfig("leaf", "tsconfig.src.json");
    expect(config.compilerOptions?.["composite"]).toBe(true);
    expect(config.compilerOptions?.["outDir"]).toBe("dist");
    expect(config.references ?? []).toEqual([]);
  });

  test("keeps tsconfig.json as the combined, conventionally-named project", async () => {
    // Every tool that discovers a project by convention -- ESLint's
    // projectService, an editor, a bare `tsc` in the package directory --
    // looks for a file literally named tsconfig.json. The composite
    // src-only project lives at tsconfig.src.json instead, so this stays
    // the file such tools find on their own.
    await writePackage("leaf");
    await run([]);

    const config = await readTsconfig("leaf");
    expect(config.extends).toBe("./tsconfig.src.json");
    expect(config.compilerOptions?.["composite"]).toBe(false);
  });

  test("gives the combined tsconfig.json its own tsBuildInfoFile", async () => {
    // The combined project extends tsconfig.src.json, which sets
    // tsBuildInfoFile: "dist/tsconfig.tsbuildinfo" for the composite build.
    // Left inherited, the combined project's --noEmit check and the
    // composite build both write that same file, and each run invalidates
    // the other's incremental state.
    await writePackage("leaf");
    await run([]);

    const combined = await readTsconfig("leaf");
    expect(combined.compilerOptions?.["tsBuildInfoFile"]).toBe(
      "tsconfig.tsbuildinfo",
    );
  });

  test("references a real workspace dependency's tsconfig.src.json", async () => {
    await writePackage("leaf");
    await writePackage("consumer", { "@fixture/leaf": "workspace:*" });
    await run([]);

    const config = await readTsconfig("consumer", "tsconfig.src.json");
    expect(config.references).toEqual([{ path: "../leaf/tsconfig.src.json" }]);
  });

  test("does not reference a devDependency", async () => {
    await writePackage("leaf");
    const dir = join(workspace, "packages", "consumer");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "@fixture/consumer",
          devDependencies: { "@fixture/leaf": "workspace:*" },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.base.json" }, null, 2),
    );
    await writeFile(join(dir, "src", "index.ts"), "export {};\n");
    await run([]);

    const config = await readTsconfig("consumer", "tsconfig.src.json");
    expect(config.references ?? []).toEqual([]);
  });

  test("the combined tsconfig.json references the same deps as tsconfig.src.json", async () => {
    await writePackage("leaf");
    await writePackage(
      "consumer",
      { "@fixture/leaf": "workspace:*" },
      { withTest: true },
    );
    await run([]);

    const combined = await readTsconfig("consumer");
    expect(combined.references).toEqual([
      { path: "../leaf/tsconfig.src.json" },
    ]);
    expect(combined.compilerOptions?.["composite"]).toBe(false);
    expect(combined.include).toContain("test");
  });

  test("gives the combined tsconfig.json an explicit rootDir at the workspace root", async () => {
    // Without this, TypeScript infers `rootDir` from `include` alone once
    // `outDir` is inherited from the extended src config, and TS6059s on
    // any file a test reaches outside "src"/"test" -- which a shared test
    // helper living outside every package's own directory always is.
    await writePackage("leaf", {}, { withTest: true });
    await run([]);

    const combined = await readTsconfig("leaf");
    expect(combined.compilerOptions?.["rootDir"]).toBe("../..");
  });

  test("preserves a non-standard include entry across regenerations", async () => {
    // packages/e2b-sandbox-sidecar has a `template/` directory that is
    // neither `src` nor `test` -- assets read at runtime, not imported --
    // and was silently dropped the first time this generator rebuilt
    // `include` from a fixed ["src", "test"] list instead of carrying
    // forward whatever the package's own tsconfig.json already declared.
    await writePackage("leaf");
    const dir = join(workspace, "packages", "leaf");
    await mkdir(join(dir, "template"), { recursive: true });
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        { extends: "../../tsconfig.base.json", include: ["src", "template"] },
        null,
        2,
      ),
    );
    await run([]);

    const combined = await readTsconfig("leaf");
    expect(combined.include).toContain("template");

    // Idempotent: a second run must not lose it either.
    await run([]);
    const combinedAgain = await readTsconfig("leaf");
    expect(combinedAgain.include).toContain("template");
  });

  test("excludes a real dependency cycle from the composite graph entirely", async () => {
    await writePackage("cycle-a", { "@fixture/cycle-b": "workspace:*" });
    await writePackage("cycle-b", { "@fixture/cycle-a": "workspace:*" });
    await run([]);

    const a = await readTsconfig("cycle-a");
    expect(a.compilerOptions?.["composite"]).toBeUndefined();
    expect(a.references ?? []).toEqual([]);
    expect(await tsconfigExists("cycle-a", "tsconfig.src.json")).toBe(false);
  });

  // A package that is not itself part of a dependency cycle, but depends on
  // one that is, must also be excluded from the composite graph.
  // Half-excluding just the cycle members leaves their consumers pulling the
  // excluded dependency's raw source directly into their own composite
  // program, which TypeScript flags as a rootDir violation (TS6059) once it
  // walks further into that source's own imports.
  test("excludes a transitive (non-cyclic) consumer of a cyclic package", async () => {
    await writePackage("cycle-a", { "@fixture/cycle-b": "workspace:*" });
    await writePackage("cycle-b", { "@fixture/cycle-a": "workspace:*" });
    await writePackage("consumer", { "@fixture/cycle-a": "workspace:*" });
    await run([]);

    const consumer = await readTsconfig("consumer");
    expect(consumer.compilerOptions?.["composite"]).toBeUndefined();
    expect(consumer.references ?? []).toEqual([]);
    expect(await tsconfigExists("consumer", "tsconfig.src.json")).toBe(false);
  });

  test("excludes a two-hop transitive consumer of a cyclic package", async () => {
    await writePackage("cycle-a", { "@fixture/cycle-b": "workspace:*" });
    await writePackage("cycle-b", { "@fixture/cycle-a": "workspace:*" });
    await writePackage("mid", { "@fixture/cycle-a": "workspace:*" });
    await writePackage("outer", { "@fixture/mid": "workspace:*" });
    await run([]);

    const outer = await readTsconfig("outer");
    expect(outer.compilerOptions?.["composite"]).toBeUndefined();
    expect(outer.references ?? []).toEqual([]);
  });

  test("does not exclude an unrelated package outside the cycle's dependents", async () => {
    await writePackage("cycle-a", { "@fixture/cycle-b": "workspace:*" });
    await writePackage("cycle-b", { "@fixture/cycle-a": "workspace:*" });
    await writePackage("unrelated");
    await run([]);

    const unrelated = await readTsconfig("unrelated", "tsconfig.src.json");
    expect(unrelated.compilerOptions?.["composite"]).toBe(true);
  });

  test("excludes a package whose src imports a shared root script", async () => {
    await writePackage(
      "uses-harness",
      {},
      {
        srcFile: 'import { harness } from "../../../scripts/e2e/harness.ts";\n',
      },
    );
    await run([]);

    expect(await tsconfigExists("uses-harness", "tsconfig.src.json")).toBe(
      false,
    );
    const config = await readTsconfig("uses-harness");
    expect(config.compilerOptions?.["composite"]).toBeUndefined();
  });

  test("--check reports drift without writing", async () => {
    await writePackage("leaf");
    const before = await readTsconfig("leaf");

    const result = await run(["--check"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tsconfig.json");
    expect(await readTsconfig("leaf")).toEqual(before);
  });

  test("--check passes once the tree is in sync", async () => {
    await writePackage("leaf");
    await writePackage("consumer", { "@fixture/leaf": "workspace:*" });
    await run([]);

    const result = await run(["--check"]);

    expect(result.exitCode).toBe(0);
  });
});
