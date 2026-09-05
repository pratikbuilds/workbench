// @ts-check

import * as eslint from "@eslint/js";
import * as tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    ".data/**",
    "apps/hub/.data/**",
    "coverage/**",
    "tmp/**",
    "vendor/**",
    ".claude/**",
    ".worktrees/**",
    ".agent-state/**",
    "dispatch/**",
    "specs/**",
    "plans/**",
  ]),
  {
    linterOptions: {
      // Zero-suppressions policy: inline disables are not permitted at all.
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // The real rule lives in the `src/**` override below, scoped there
      // so generated build output, one-off scripts, and top-level
      // entrypoints (which install `@intx/log`'s own console sink) are
      // never in scope for it. Off by default here.
      "no-console": 0,
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true },
      ],
      // Stylistic only, no bug-catching value; arktype mixes type/interface
      // deliberately.
      "@typescript-eslint/consistent-type-definitions": 0,
      "@typescript-eslint/no-empty-function": 0,
      "@typescript-eslint/no-empty-object-type": 0,
      "@typescript-eslint/no-invalid-void-type": 0,
      "@typescript-eslint/no-inferrable-types": 0,
      "@typescript-eslint/consistent-indexed-object-style": 0,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.ts"],
    rules: { "no-console": 0 },
  },
  // CL-6359: every app/package's `src/` routes through the global logger
  // — `@intx/log` on the backend, `@corbits/client-log` in the browser —
  // instead of ad-hoc `console.*` calls, so a category+level shape is
  // traceable end-to-end and nothing bypasses it silently. Two carve-outs:
  // tests, where a stray console call is dev noise, not a product
  // surface; and each logger module's own implementation, which is the
  // one sanctioned place `console.*` is still called directly.
  {
    files: ["**/src/**/*.ts", "**/src/**/*.tsx"],
    ignores: [
      "**/src/**/*.test.ts",
      "**/src/**/*.test.tsx",
      "packages/client-log/src/index.ts",
    ],
    rules: { "no-console": "error" },
  },
  // CL-icons-phosphor: Phosphor (bold weight) replaced lucide-react as the
  // one icon library, and the Sparkle/Sparkles glyph is banned outright —
  // owner ruling, it read as a generic "AI" cliché everywhere it appeared.
  // `packages/icons` is the single place allowed to import
  // `@phosphor-icons/react` directly (see its `src/index.tsx`); every other
  // package routes glyphs through `@corbits/icons` so the curated name list
  // and the bold-weight default stay enforced in one place.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/icons/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "lucide-react",
              message:
                "lucide-react is retired — import from @corbits/icons instead.",
            },
            {
              name: "@phosphor-icons/react",
              message:
                "Import icons from @corbits/icons, not @phosphor-icons/react directly.",
            },
          ],
          patterns: [
            {
              group: ["@phosphor-icons/react/*"],
              message:
                "Import icons from @corbits/icons, not @phosphor-icons/react directly.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportSpecifier[imported.name=/^Sparkle(s)?$/], ImportSpecifier[local.name=/^Sparkle(s)?$/]",
          message:
            "The Sparkle/Sparkles glyph is banned — pick a glyph that means something specific to what it marks.",
        },
      ],
    },
  },
);
