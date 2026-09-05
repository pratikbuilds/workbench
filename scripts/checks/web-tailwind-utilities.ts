// check:web-utilities — app-authored Tailwind classes must land in the
// production CSS. apps/web used to import only react-ui's prebuilt
// stylesheet, so every utility react-ui itself did not use was dead CSS.
// This check builds the web app (when dist is missing or stale) and asserts
// a fixed set of known app/package utilities appear in the emitted CSS.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

/** Substrings that must appear in the built CSS. Escaped selectors are
 * written the way Tailwind emits them (e.g. `sm\:px-7`). */
const REQUIRED_UTILITIES = [
  "grid-cols-",
  "sm\\:px-7",
  "w-fit",
  "min-h-",
  // The chart series is styled through theme tokens (app.css and
  // chat-ui's agent accent), not arbitrary-value utilities — the
  // removed artifactKindColor was the last bg-[var(--chart-N)] author.
  // The tokens themselves must still survive into the built CSS.
  "--chart-1:",
  "--chart-2:",
  "--chart-3:",
  "--chart-4:",
  "--chart-5:",
  "var(--chart-1)",
  "bg-muted",
] as const;

function newestMtime(dir: string, extensions: readonly string[]): number {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // ignore unreadable files
      }
    }
  }
  return newest;
}

/** Every emitted stylesheet: code splitting emits one CSS file per
 * chunk, so a required utility may land in any of them. */
function findBuiltCss(distAssets: string): string[] {
  try {
    return readdirSync(distAssets)
      .filter((name) => name.endsWith(".css"))
      .sort()
      .map((name) => path.join(distAssets, name));
  } catch {
    return [];
  }
}

async function ensureWebBuild(
  root: string,
  report: CheckReport,
): Promise<void> {
  const webDir = path.join(root, "apps/web");
  const distAssets = path.join(webDir, "dist/assets");
  const cssPaths = findBuiltCss(distAssets);
  const sourceNewest = Math.max(
    newestMtime(path.join(webDir, "src"), [".tsx", ".ts", ".css"]),
    newestMtime(path.join(root, "packages/artifact-ui/src"), [".tsx", ".ts"]),
  );
  const cssMtime = cssPaths.reduce((oldest, cssPath) => {
    try {
      return Math.min(oldest, statSync(cssPath).mtimeMs);
    } catch {
      return 0;
    }
  }, Number.POSITIVE_INFINITY);

  if (cssPaths.length > 0 && cssMtime >= sourceNewest) {
    report.notes.push(
      `reusing existing build (${cssPaths
        .map((cssPath) => path.relative(root, cssPath))
        .join(", ")})`,
    );
    return;
  }

  report.notes.push("building @workbench/web for CSS inspection");
  const proc = Bun.spawn(
    ["bun", "run", "--filter", "@workbench/web", "build"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exit = await proc.exited;
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text();
    report.violations.push(`web build failed (exit ${exit}): ${stderr.trim()}`);
  }
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const report = emptyReport();
  await ensureWebBuild(root, report);
  if (report.violations.length > 0) {
    reportAndExit("check:web-utilities", report);
  }

  const cssPaths = findBuiltCss(path.join(root, "apps/web/dist/assets"));
  if (cssPaths.length === 0) {
    report.violations.push(
      "no CSS asset under apps/web/dist/assets after build",
    );
    reportAndExit("check:web-utilities", report);
  }

  const cssFiles = cssPaths.map((cssPath) => path.relative(root, cssPath));
  const css = cssPaths
    .map((cssPath) => readFileSync(cssPath, "utf8"))
    .join("\n");
  for (const utility of REQUIRED_UTILITIES) {
    if (!css.includes(utility)) {
      report.violations.push(
        `built CSS missing utility substring ${JSON.stringify(utility)} (files ${cssFiles.join(", ")})`,
      );
    }
  }
  if (report.violations.length === 0) {
    report.notes.push(
      `all ${REQUIRED_UTILITIES.length} required utilities present across ${cssFiles.join(", ")}`,
    );
  }
  reportAndExit("check:web-utilities", report);
}

if (import.meta.main) await main();
