// Database bootstrap for the platform schema plus any installed
// package's own migrations. The hub's schema is defined entirely by
// @intx/db's shipped migrations; this repository authors no SQL for
// the platform itself. Installed packages may ship their own product
// tables, though — @corbits/chat is the first — and this script
// applies each installed package's migration set right after the
// platform's, as an explicit literal list below. This script makes
// the database in DATABASE_URL runnable: it creates the database if
// it is missing, applies the platform migrations (which include the
// better-auth tables) into the target schema, records exactly which
// migration files it applied so a re-run can tell "already done" from
// "done by something else", then applies the installed packages'
// migrations on top — and says so out loud either way.
//
// The platform dependencies are resolved through apps/hub on purpose:
// the schema this script creates is the hub's schema, so it must be
// built with exactly the @intx/db version the hub runs, not a
// separately-declared copy that could drift.
//
// Exported surface (consumed by the dev bootstrap, the CLI's setup
// verb, and the test harnesses):
//
//   setupDatabase(databaseUrl, { schema? })  -> DbSetupReport
//   resetSchema(databaseUrl, { schema? })    -> void
//
// Run directly: `bun scripts/db-setup.ts [--reset]` (reads DATABASE_URL).

import path from "node:path";
import { readdir } from "node:fs/promises";

import {
  applyFoldedRunsMigrations,
  backfillFoldedRunMarkers,
} from "../packages/folded-runs/src/migrations";
import {
  applyChatMigrations,
  listWorkbenchLaunchFoldedRunIds,
} from "../packages/chat/src/migrations";
import { applyWebhookTriggersMigrations } from "../packages/webhook-triggers/src/migrations";
import { reconcileDuplicateRepoGrants } from "../packages/connections/src/reconcile-duplicate-repo-grants";
import { applyNotifyMigrations } from "../packages/notify/src/migrations";
import {
  applyInboxMigrations,
  applyMailboxMigrations,
} from "../packages/inbox/src/migrations";
import { applyInsightsMigrations } from "../packages/insights/src/migrations";
import { applyPreferencesMigrations } from "../packages/preferences/src/migrations";
import { applyBenchMigrations } from "../packages/bench/src/migrations";
import { applySkillsMigrations } from "../packages/skills/src/migrations";
import { applyAgentDirectoryMigrations } from "../packages/agent-directory/src/migrations";
import { applyOnboardingMigrations } from "../packages/onboarding/src/migrations";
import { applyAccessPolicyMigrations } from "../packages/access-policy/src/migrations";
import { applyRunKeyHistoryMigrations } from "../packages/run-key-history/src/migrations";
import { applyWorkflowDeploySourceMigrations } from "../packages/workflows/src/deploy-source/migrations";
import { applyInferenceCatalogMigrations } from "../packages/inference-catalog/src/migrations";

const repoRoot = path.resolve(import.meta.dir, "..");
const HUB_DIR = path.join(repoRoot, "apps", "hub");

/**
 * Installed packages that ship their own product-table migrations,
 * applied after the platform's. Explicit and literal on purpose: no
 * discovery magic, no globbing for migrations. @corbits/chat is the
 * first installed package to need this seam. See
 * docs/package-migrations.md for the convention each package's
 * migration runner follows (literal SQL, package-owned ledger,
 * transactional apply) and which shape to pick for a new package.
 */
const INSTALLED_PACKAGE_MIGRATIONS: readonly {
  name: string;
  apply: (databaseUrl: string) => Promise<{ applied: string[] }>;
}[] = [
  // Ahead of @corbits/chat: it launches runs through
  // @corbits/folded-runs' `launchFoldedRun`, which writes into its
  // `folded_run` marker table unconditionally on every launch.
  { name: "@corbits/folded-runs", apply: applyFoldedRunsMigrations },
  { name: "@corbits/chat", apply: applyChatMigrations },
  { name: "@corbits/webhook-triggers", apply: applyWebhookTriggersMigrations },
  { name: "@corbits/notify", apply: applyNotifyMigrations },
  { name: "@corbits/mailbox", apply: applyMailboxMigrations },
  // CL-7208's snooze-until table, own schema — see packages/inbox/src/schema.ts.
  { name: "@corbits/inbox", apply: applyInboxMigrations },
  { name: "@corbits/insights", apply: applyInsightsMigrations },
  { name: "@corbits/preferences", apply: applyPreferencesMigrations },
  { name: "@corbits/bench", apply: applyBenchMigrations },
  { name: "@corbits/skills", apply: applySkillsMigrations },
  { name: "@corbits/agent-directory", apply: applyAgentDirectoryMigrations },
  { name: "@workbench/onboarding", apply: applyOnboardingMigrations },
  { name: "@workbench/access-policy", apply: applyAccessPolicyMigrations },
  { name: "@corbits/run-key-history", apply: applyRunKeyHistoryMigrations },
  {
    name: "@corbits/workflows (deploy-source)",
    apply: applyWorkflowDeploySourceMigrations,
  },
  {
    name: "@corbits/inference-catalog",
    apply: applyInferenceCatalogMigrations,
  },
];

/**
 * Apply every installed package's migration set, in the explicit
 * order listed above, right after the platform's own migrations. Each
 * package owns its own idempotence and bookkeeping (see
 * applyChatMigrations); this only sequences them and reports what ran.
 */
async function applyInstalledPackageMigrations(
  databaseUrl: string,
): Promise<void> {
  for (const { name, apply } of INSTALLED_PACKAGE_MIGRATIONS) {
    try {
      const { applied } = await apply(databaseUrl);
      if (applied.length > 0) {
        console.log(
          `db-setup: applied ${applied.length} migration(s) for ${name}: ` +
            applied.join(", "),
        );
      }
    } catch (error) {
      throw new Error(
        `db-setup: failed applying migrations for installed package ${name}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  await backfillFoldedRunsFromInstalledPackages(databaseUrl);

  // CL-7242: not a package migration (no schema, no ledger, no DDL at
  // all) -- a plain, always-safe-to-re-run DELETE against the
  // platform's own `grant` table through @intx/db's published export,
  // cleaning up any repo grants CL-7242's race duplicated before this
  // fix's lease started preventing new ones. See
  // reconcile-duplicate-repo-grants.ts for why this is DML, not DDL,
  // and why that distinction is what keeps it off the vendored-delta
  // ledger.
  const { removedIds } = await reconcileDuplicateRepoGrants(databaseUrl);
  if (removedIds.length > 0) {
    console.log(
      `db-setup: removed ${removedIds.length} duplicate repo grant(s): ` +
        removedIds.join(", "),
    );
  }

  await dropRoutinesSchemaAfterDigestHandoff(databaseUrl);
}

/**
 * One-time cross-package backfill for every folded run launched
 * before @corbits/folded-runs' own `folded_run` marker table existed
 * (CL-6061). Neither @corbits/folded-runs nor this script reads
 * another package's tables directly to do this — @corbits/chat
 * already depends on @corbits/folded-runs, so having it read back its
 * schema would close that into a cycle. Instead the launching package
 * exposes its own read-only lister over its own schema
 * (listWorkbenchLaunchFoldedRunIds), this script — the one place that
 * already knows and sequences every installed package — passes its
 * output through, and @corbits/folded-runs' own
 * backfillFoldedRunMarkers is the only thing that ever writes to its
 * table. Ledgered by that function under its own migration name, so
 * every run after the first is a fast no-op.
 *
 * @corbits/tasks used to contribute a second seed list here
 * (listTaskFoldedRunIds); that package was deleted (tasks primitive
 * removed in favor of workflows/routines). Its `tasks.task` and
 * `tasks.task_leg` tables and their migration ledger are left in
 * place in Postgres untouched — only this backfill's read of them
 * stops, per the removal ruling.
 */
async function backfillFoldedRunsFromInstalledPackages(
  databaseUrl: string,
): Promise<void> {
  const workbenchLaunchSeeds =
    await listWorkbenchLaunchFoldedRunIds(databaseUrl);
  const { applied, inserted } = await backfillFoldedRunMarkers(
    databaseUrl,
    workbenchLaunchSeeds,
  );
  if (applied) {
    console.log(
      `db-setup: backfilled ${inserted} folded_run marker(s) from ` +
        "@corbits/chat",
    );
  }
}

// --- hub-resolved platform dependencies ------------------------------

// Minimal local views of the two hub dependencies this script uses.
// They are resolved out of the hub's dependency tree at runtime, so
// the shapes are pinned here instead of imported.
interface IntxDbMigrate {
  runMigrations(config: unknown, options: { schema: string }): Promise<void>;
  dropSchema(config: unknown, options: { schema: string }): Promise<void>;
}

interface SqlClient {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

type PostgresFactory = (options: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number;
  onnotice: () => undefined;
}) => SqlClient;

function resolveHubDependency(specifier: string): string {
  try {
    return Bun.resolveSync(specifier, HUB_DIR);
  } catch {
    throw new Error(
      [
        `Cannot resolve ${specifier} from ${HUB_DIR}.`,
        "The hub's dependencies are not installed. Run:",
        "",
        "  bun install",
      ].join("\n"),
    );
  }
}

async function loadIntxDb(): Promise<IntxDbMigrate> {
  const resolved = resolveHubDependency("@intx/db");
  const loaded = (await import(resolved)) as Partial<IntxDbMigrate>;
  if (
    typeof loaded.runMigrations !== "function" ||
    typeof loaded.dropSchema !== "function"
  ) {
    throw new Error(
      [
        `@intx/db at ${resolved} does not export runMigrations/dropSchema;`,
        "the installed version does not match what scripts/db-setup.ts",
        "expects. Reinstall dependencies and re-run:",
        "",
        "  bun install",
      ].join("\n"),
    );
  }
  return { runMigrations: loaded.runMigrations, dropSchema: loaded.dropSchema };
}

export async function loadPostgres(): Promise<PostgresFactory> {
  const resolved = resolveHubDependency("postgres");
  const loaded = (await import(resolved)) as { default: PostgresFactory };
  return loaded.default;
}

/**
 * The migration files @intx/db ships, sorted in apply order. The
 * package pins them at `<pkgRoot>/migrations`, a sibling of the entry
 * module's directory (`src/index.ts` in the vendored workspace,
 * `dist/index.js` when published), so `<entry dir>/../migrations` is
 * the same resolution @intx/db's own runMigrations performs.
 */
async function listShippedMigrations(): Promise<string[]> {
  const entry = resolveHubDependency("@intx/db");
  const dir = path.resolve(path.dirname(entry), "..", "migrations");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    throw new Error(
      [
        `@intx/db's migrations directory is missing at ${dir}.`,
        "Reinstall dependencies and re-run:",
        "",
        "  bun install",
      ].join("\n"),
    );
  }
  const sql = files.filter((f) => f.endsWith(".sql")).sort();
  if (sql.length === 0) {
    throw new Error(
      [
        `@intx/db ships no .sql migrations in ${dir}; the installed package`,
        "is broken. Reinstall dependencies and re-run:",
        "",
        "  bun install",
      ].join("\n"),
    );
  }
  return sql;
}

// --- connection plumbing ---------------------------------------------

interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Parse DATABASE_URL the same way the hub does (see dbConfigFromUrl in
 * apps/hub/src/index.ts), so this script bootstraps exactly the
 * connection the hub will use. An empty user falls through to the
 * postgres client's OS-username default, matching the hub's behavior.
 */
export function dbTargetFromUrl(databaseUrl: string): DbTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      `DATABASE_URL is not a parseable URL: ${JSON.stringify(databaseUrl)}. ` +
        "Expected e.g. postgres://user:pass@localhost:5432/workbench.",
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `DATABASE_URL must be a postgres:// URL, got ${url.protocol}//.`,
    );
  }
  const database = url.pathname.replace(/^\//, "");
  if (database === "") {
    throw new Error(
      "DATABASE_URL names no database (empty path). " +
        "Expected e.g. postgres://localhost:5432/workbench.",
    );
  }
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

async function connect(
  postgres: PostgresFactory,
  target: DbTarget,
): Promise<SqlClient> {
  return postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    max: 1,
    onnotice: () => undefined,
  });
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Connect to the target database, creating it first when it does not
 * exist (via the server's maintenance database). Returns whether the
 * database had to be created. Unreachable servers fail with the fix
 * named, mirroring the dev bootstrap's guidance.
 */
async function ensureDatabase(
  postgres: PostgresFactory,
  target: DbTarget,
): Promise<{ sql: SqlClient; createdDatabase: boolean }> {
  const sql = await connect(postgres, target);
  try {
    await sql.unsafe("SELECT 1");
    return { sql, createdDatabase: false };
  } catch (error) {
    await sql.end();
    if (pgErrorCode(error) !== "3D000") {
      throw new Error(
        [
          `Cannot connect to Postgres at ${target.host}:${target.port} ` +
            `(from DATABASE_URL): ${error instanceof Error ? error.message : String(error)}`,
          "Start a local Postgres and re-run. On macOS:",
          "",
          "  brew install postgresql@17 pgvector",
          "  brew services start postgresql@17",
        ].join("\n"),
        { cause: error },
      );
    }
  }
  // 3D000: the database does not exist. Create it from the maintenance
  // database, then reconnect to it.
  const maintenance = await connect(postgres, {
    ...target,
    database: "postgres",
  });
  try {
    await maintenance.unsafe(
      `CREATE DATABASE ${quoteIdentifier(target.database)}`,
    );
  } catch (error) {
    throw new Error(
      `Database ${JSON.stringify(target.database)} does not exist and ` +
        `creating it failed: ${error instanceof Error ? error.message : String(error)}. ` +
        "Create it yourself (createdb) or point DATABASE_URL at a database " +
        "your role may create.",
      { cause: error },
    );
  } finally {
    await maintenance.end();
  }
  return { sql: await connect(postgres, target), createdDatabase: true };
}

// --- setup state inspection ------------------------------------------

// Ledger of migration files this script has applied into a schema.
// It lives inside the target schema so dropping the schema drops the
// ledger with it, and its presence distinguishes "set up by db-setup"
// from "tables created by something else".
const LEDGER_TABLE = "workbench_setup_migration";

// A table from @intx/db's first migration; its presence without the
// ledger means the schema was populated by something other than this
// script.
const SENTINEL_TABLE = "user";

async function tableExists(
  sql: SqlClient,
  schema: string,
  table: string,
): Promise<boolean> {
  const rows = await sql.unsafe(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
    [schema, table],
  );
  return rows.length > 0;
}

/**
 * One-shot: if a leftover `routines` schema is still present, enable the
 * authored workbench-digest definition for tenants whose digest routine
 * was on, then drop the schema. Absent schema is a no-op. Safe to re-run.
 *
 * `updated_at = now()` is load-bearing: seed treats `createdAt === updatedAt`
 * as pristine and PUTs `stopped`. Copying enablement without bumping
 * `updated_at` would look untouched and get re-archived on the next seed.
 */
export const DIGEST_HANDOFF_SQL = `UPDATE workflow_definition wd SET status = CASE WHEN r.enabled THEN 'deployed' ELSE 'stopped' END, updated_at = now() FROM routines.routine r WHERE r.preset_key = 'workbench-digest' AND wd.name = 'workbench-digest' AND wd.tenant_id = r.tenant_id AND wd.origin = 'authored'`;

async function dropRoutinesSchemaAfterDigestHandoff(
  databaseUrl: string,
): Promise<void> {
  const postgres = await loadPostgres();
  const target = dbTargetFromUrl(databaseUrl);
  const sql = await connect(postgres, target);
  try {
    const existing = await sql.unsafe(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
      ["routines"],
    );
    if (existing.length === 0) return;
    await sql.unsafe(DIGEST_HANDOFF_SQL);
    await sql.unsafe("DROP SCHEMA IF EXISTS routines CASCADE");
    console.log(
      "db-setup: dropped routines schema after digest enablement handoff",
    );
  } finally {
    await sql.end();
  }
}

async function appliedMigrations(
  sql: SqlClient,
  schema: string,
): Promise<string[]> {
  const rows = await sql.unsafe(
    `SELECT filename FROM ${quoteIdentifier(schema)}.${quoteIdentifier(LEDGER_TABLE)} ORDER BY filename`,
  );
  return rows.map((row) => String(row["filename"]));
}

// --- public surface ---------------------------------------------------

export interface DbSetupOptions {
  /** Target Postgres schema; defaults to "public", which is where the hub connects. */
  schema?: string;
}

export interface DbSetupReport {
  /** The database name from DATABASE_URL. */
  database: string;
  /** The Postgres schema the platform tables live in. */
  schema: string;
  /** Whether the database itself had to be created. */
  createdDatabase: boolean;
  /** "migrated" when this call applied migrations; "unchanged" when the schema was already current. */
  action: "migrated" | "unchanged";
  /** Number of migration files now applied in the schema. */
  migrations: number;
}

/**
 * Ensure a sidecar identity row exists for `sidecarId` with the given
 * token: the hub authenticates a sidecar's WebSocket dial-in against
 * the token hash on the `sidecar` table, so the row must exist before
 * the sidecar process starts. Idempotent — re-running refreshes the
 * hash, so a changed token heals rather than locking the sidecar out.
 */
export async function ensureSidecarIdentity(
  databaseUrl: string,
  sidecarId: string,
  token: string,
): Promise<void> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const postgres = await loadPostgres();
  const target = dbTargetFromUrl(databaseUrl);
  const sql = await connect(postgres, target);
  try {
    await sql.unsafe(
      `INSERT INTO "sidecar" ("id", "url", "token_hash_sha256")
       VALUES ($1, $2, $3)
       ON CONFLICT ("id") DO UPDATE SET "token_hash_sha256" = $3`,
      [sidecarId, "ws://local-sidecar", Buffer.from(digest)],
    );
  } finally {
    await sql.end();
  }
}

/**
 * Make the database in `databaseUrl` runnable: create the database if
 * missing, apply @intx/db's shipped migrations (platform tables plus
 * the better-auth tables) into the target schema, and record what was
 * applied. Idempotent: a schema this script already set up at the same
 * migration level reports "unchanged" and touches nothing. Any state
 * it cannot vouch for — tables without its ledger, or a ledger that
 * disagrees with the shipped migration list — fails loudly and names
 * the fix instead of guessing.
 */
export async function setupDatabase(
  databaseUrl: string,
  options: DbSetupOptions = {},
): Promise<DbSetupReport> {
  const schema = options.schema ?? "public";
  const target = dbTargetFromUrl(databaseUrl);
  const [postgres, intxDb, shipped] = await Promise.all([
    loadPostgres(),
    loadIntxDb(),
    listShippedMigrations(),
  ]);

  const { sql, createdDatabase } = await ensureDatabase(postgres, target);
  try {
    const hasLedger = await tableExists(sql, schema, LEDGER_TABLE);
    if (hasLedger) {
      const applied = await appliedMigrations(sql, schema);
      const same =
        applied.length === shipped.length &&
        applied.every((file, i) => file === shipped[i]);
      if (same) {
        await applyInstalledPackageMigrations(databaseUrl);
        return {
          database: target.database,
          schema,
          createdDatabase,
          action: "unchanged",
          migrations: applied.length,
        };
      }
      throw new Error(
        [
          `Schema ${JSON.stringify(schema)} in database ${JSON.stringify(target.database)} ` +
            `was set up with a different @intx/db migration set ` +
            `(${applied.length} applied, ${shipped.length} shipped).`,
          "The platform migrations replay from scratch; they cannot be applied",
          "incrementally on top of an older set. Reset the schema and re-run:",
          "",
          "  bun scripts/db-setup.ts --reset",
        ].join("\n"),
      );
    }

    if (await tableExists(sql, schema, SENTINEL_TABLE)) {
      throw new Error(
        [
          `Schema ${JSON.stringify(schema)} in database ${JSON.stringify(target.database)} ` +
            "already contains platform tables but no db-setup ledger, so this",
          "script cannot vouch for its state. Reset the schema and re-run:",
          "",
          "  bun scripts/db-setup.ts --reset",
        ].join("\n"),
      );
    }

    await intxDb.runMigrations(target, { schema });
    await sql.unsafe(
      `CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(LEDGER_TABLE)} (` +
        `filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    for (const file of shipped) {
      await sql.unsafe(
        `INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(LEDGER_TABLE)} (filename) VALUES ($1)`,
        [file],
      );
    }
    await applyInstalledPackageMigrations(databaseUrl);
    return {
      database: target.database,
      schema,
      createdDatabase,
      action: "migrated",
      migrations: shipped.length,
    };
  } finally {
    await sql.end();
  }
}

// Every installed package that owns a named schema of its own (see
// docs/package-migrations.md) rather than the platform's `public`, so a
// reset that only drops `schema` would leave those tables behind: the next
// `bun run dev`/`workbench reset` would boot against fresh `tenant`/
// `principal` rows while e.g. `mailbox.principal_mail` or
// `chat.workbench_settings` still held the old ones (and, once the old FKs
// are cascaded away, orphaned rows no package's `CREATE TABLE IF NOT
// EXISTS` migration would ever revisit). Always dropped alongside the
// target schema so a reset is a true clean slate for every installed
// package's tables, not only the platform's.
const PACKAGE_SCHEMAS = [
  "mailbox",
  "folded_runs",
  "chat",
  "routines",
  "insights",
  "notify",
  "webhook_triggers",
  "onboarding",
  "access_policy",
  "bench",
  "preferences",
  "skills",
  "slack_tag",
  "tasks",
  "agent_directory",
] as const;

/**
 * Drop the target schema and everything in it (platform tables, auth
 * tables, and the setup ledger), plus every installed package's own named
 * schema. A missing database is a no-op: there is nothing to drop. Pair
 * with setupDatabase for a from-scratch rebuild; the e2e harness does
 * exactly that.
 */
export async function resetSchema(
  databaseUrl: string,
  options: DbSetupOptions = {},
): Promise<void> {
  const schema = options.schema ?? "public";
  const target = dbTargetFromUrl(databaseUrl);
  const [postgres, intxDb] = await Promise.all([loadPostgres(), loadIntxDb()]);
  const probe = await connect(postgres, target);
  try {
    await probe.unsafe("SELECT 1");
  } catch (error) {
    await probe.end();
    if (pgErrorCode(error) === "3D000") return;
    throw new Error(
      [
        `Cannot connect to Postgres at ${target.host}:${target.port} ` +
          `(from DATABASE_URL): ${error instanceof Error ? error.message : String(error)}`,
        "Start a local Postgres and re-run. On macOS:",
        "",
        "  brew install postgresql@17 pgvector",
        "  brew services start postgresql@17",
      ].join("\n"),
      { cause: error },
    );
  }
  await probe.end();
  await intxDb.dropSchema(target, { schema });
  for (const packageSchema of PACKAGE_SCHEMAS) {
    await intxDb.dropSchema(target, { schema: packageSchema });
  }
}

// --- command-line entry ----------------------------------------------

function describeReport(report: DbSetupReport): string {
  const lines: string[] = [];
  if (report.createdDatabase) {
    lines.push(`created database ${JSON.stringify(report.database)}`);
  }
  if (report.action === "migrated") {
    lines.push(
      `applied ${report.migrations} platform migrations into schema ` +
        `${JSON.stringify(report.schema)} of database ${JSON.stringify(report.database)}`,
    );
  } else {
    lines.push(
      `schema ${JSON.stringify(report.schema)} of database ` +
        `${JSON.stringify(report.database)} is already migrated ` +
        `(${report.migrations} migrations); nothing to do`,
    );
  }
  return lines.map((line) => `db-setup: ${line}`).join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const unknown = args.filter((a) => a !== "--reset");
  if (unknown.length > 0) {
    console.error(
      `db-setup: unknown argument(s): ${unknown.join(" ")}\n` +
        "usage: bun scripts/db-setup.ts [--reset]",
    );
    process.exit(1);
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      [
        "db-setup: DATABASE_URL is not set.",
        "Create an env file from the template and re-run:",
        "",
        "  cp .env.example .env",
        "  bun scripts/db-setup.ts",
      ].join("\n"),
    );
    process.exit(1);
  }
  try {
    if (reset) {
      await resetSchema(databaseUrl);
      console.log("db-setup: dropped existing schema");
    }
    const report = await setupDatabase(databaseUrl);
    console.log(describeReport(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
