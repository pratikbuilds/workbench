// WORKBENCH DELTA (see VENDORED.md): a fresh replay of the shipped SQL,
// sorted by filename, must land upstream's newest migration and both of
// ours. DB-gated: skipped when DATABASE_URL is unset, matching the hub
// tests' convention.
import { afterAll, describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import postgres from "postgres";

import { dropSchema, runMigrations } from "./migrate";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = databaseUrl === "" ? describe.skip : describe;

function configFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username) || userInfo().username,
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
  };
}

describeIfDb("runMigrations replays the shipped SQL into a fresh schema", () => {
  const schema = `migrate_test_${Date.now().toString(36)}`;
  const config = configFromUrl(databaseUrl);
  afterAll(() => dropSchema(config, { schema }));

  test("lands upstream's approval run index and workbench columns", async () => {
    await runMigrations(config, { schema });
    const sql = postgres({ ...config, max: 1, onnotice: () => undefined });
    try {
      const columns = await sql<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = ${schema}
          AND (table_name, column_name) IN (
            ('workflow_definition_version', 'wire_projection'),
            ('workflow_definition', 'origin'),
            ('workflow_definition', 'schedule_claimed_minute'))`;
      expect(columns.map((row) => row.column_name).sort()).toEqual([
        "origin",
        "schedule_claimed_minute",
        "wire_projection",
      ]);
      const indexes = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = ${schema} AND indexname = 'approval_run_idx'`;
      expect(indexes).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });
});
