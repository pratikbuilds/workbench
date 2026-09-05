// The platform migration set is replayed from scratch and tracked by
// filename: a schema set up under an older @intx/db migration list (here,
// the pre-re-pin numbering of workbench's own two migrations) is refused
// with the reset instruction instead of being patched incrementally.
// The old-numbering suite is DB-gated (skipped when DATABASE_URL is unset).
// The digest-handoff SQL assertion always runs.
import { expect, test } from "bun:test";

import {
  dbTargetFromUrl,
  DIGEST_HANDOFF_SQL,
  loadPostgres,
  setupDatabase,
} from "./db-setup";
import { dbGate } from "./e2e/db-gate";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = dbGate(databaseUrl, import.meta.path);

test("digest handoff SQL bumps updated_at so copied enablement is not pristine", () => {
  expect(DIGEST_HANDOFF_SQL).toMatch(/updated_at\s*=\s*now\(\)/);
});

const OLD_NUMBERING_TAIL = [
  "0084_delete_orphaned_credential_grants.sql",
  "0085_workflow_definition_version_wire_projection.sql",
  "0086_workflow_definition_origin.sql",
];

describeIfDb(
  "setupDatabase against a schema migrated under the old numbering",
  () => {
    test("refuses to apply incrementally and names the reset", async () => {
      const schema = `db_setup_test_${Date.now().toString(36)}`;
      const target = dbTargetFromUrl(databaseUrl);
      const sql = await loadPostgres().then((postgres) =>
        postgres({ ...target, max: 1, onnotice: () => undefined }),
      );
      try {
        await sql.unsafe(`CREATE SCHEMA "${schema}"`);
        await sql.unsafe(
          `CREATE TABLE "${schema}"."workbench_setup_migration" (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        for (const file of OLD_NUMBERING_TAIL) {
          await sql.unsafe(
            `INSERT INTO "${schema}"."workbench_setup_migration" (filename) VALUES ($1)`,
            [file],
          );
        }
        await expect(setupDatabase(databaseUrl, { schema })).rejects.toThrow(
          /different @intx\/db migration set[\s\S]*db-setup\.ts --reset/,
        );
      } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await sql.end();
      }
    });
  },
);
