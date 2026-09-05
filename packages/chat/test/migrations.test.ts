// DB-gated: skipped when no DATABASE_URL is reachable (a fresh
// checkout still runs the unit gates), and turned into a loud failure
// by CI=true so the suite can never silently vanish from CI —
// mirroring scripts/e2e/harness.ts's e2eDatabaseUrl/baseUrlToE2eUrl.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's, so a failure here can never corrupt either.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations, chatMigrations } from "../src/migrations";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_migrations_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const migrationNames = [
  "0001_channel_settings",
  "0002_channel_read_state",
  "0003_channel_launch",
  "0004_channel_launch_noop_inference",
  "0005_channel_tenancy",
  "0006_channel_tenancy_parent_index",
  "0007_chat_bench_settings",
  "0008_channel_context_window_explicit_inherit",
  "0009_channel_threads",
  "0010_block_responses",
  "0011_channel_threads_parent_thread_id",
  "0012_message_reactions",
  "0013_pinned_messages",
  "0014_channel_share",
  "0015_channel_share_member",
  "0016_finalized_turn_write_claim",
  "0017_message_client_ids",
  "0018_rename_channel_to_workbench",
  "0019_workbench_messages",
  "0020_workbench_launch_current_run",
  "0021_workbench_launch_prior_runs",
  "0022_agent_turns",
  "0023_drop_workbench_host_arm",
  "0024_workbench_launch_sources_digest",
  "0025_workbench_threads_unique_key",
  "0026_workbench_threads_delivery_key",
  "0027_block_responses_notified_at",
  "0028_turn_mail_correlation",
  "0029_workbench_messages_mail_message_id",
];

describeIfDb("applyChatMigrations", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  test("applies every table and is idempotent on a second run", async () => {
    const first = await applyChatMigrations(scratchUrl);
    expect(first.applied).toEqual(migrationNames);

    const second = await applyChatMigrations(scratchUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.sort()).toEqual([...migrationNames].sort());

    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const tables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'chat' AND table_name IN ` +
          `('workbench_settings', 'workbench_read_state', 'workbench_launch', 'workbench_tenancy', 'chat_bench_settings', 'workbench_threads', 'workbench_thread_messages', 'message_reactions', 'pinned_messages', 'finalized_turn_write_claim', 'workbench_messages', 'agent_turns')`,
      );
      expect(tables.map((row) => String(row["table_name"])).sort()).toEqual(
        [
          "workbench_launch",
          "workbench_read_state",
          "workbench_settings",
          "workbench_tenancy",
          "workbench_thread_messages",
          "workbench_threads",
          "chat_bench_settings",
          "message_reactions",
          "pinned_messages",
          "finalized_turn_write_claim",
          "workbench_messages",
          "agent_turns",
        ].sort(),
      );

      // Renamed away (CL-6260): the old "channel"-named tables must not
      // linger alongside their renamed replacements.
      const oldNamedTables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'chat' AND table_name IN ` +
          `('channel_settings', 'channel_read_state', 'channel_launch', 'channel_tenancy', 'channel_threads', 'channel_thread_messages', 'channel_share', 'channel_share_member')`,
      );
      expect(oldNamedTables).toHaveLength(0);

      // None of chat's tables leak into `public` — every one of them
      // landed in the package's own `chat` schema.
      const publicTables = await sql.unsafe(
        `SELECT table_name FROM information_schema.tables ` +
          `WHERE table_schema = 'public' AND table_name IN ` +
          `('workbench_settings', 'workbench_read_state', 'workbench_launch', 'workbench_tenancy', 'chat_bench_settings', 'workbench_threads', 'workbench_thread_messages', 'block_responses', 'message_reactions', 'pinned_messages')`,
      );
      expect(publicTables).toHaveLength(0);

      // `listChildWorkbenchTenancies` filters on `parent_tenant_id` on
      // every `GET /workbenches` call — without an index that is a
      // sequential scan on every request.
      const indexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'chat' AND tablename = 'workbench_tenancy'`,
      );
      expect(indexes.map((row) => String(row["indexname"]))).toContain(
        "workbench_tenancy_parent_tenant_id_idx",
      );

      // The batched per-message reaction/pin reads on `GET /messages`
      // filter on (tenant, workbench[, message]) — without these, both
      // become sequential scans on every page load.
      const reactionIndexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'chat' AND tablename = 'message_reactions'`,
      );
      expect(reactionIndexes.map((row) => String(row["indexname"]))).toContain(
        "message_reactions_message_idx",
      );

      const pinIndexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'chat' AND tablename = 'pinned_messages'`,
      );
      expect(pinIndexes.map((row) => String(row["indexname"]))).toContain(
        "pinned_messages_workbench_idx",
      );

      // CL-7130: `ensureRootThread`/`anchoredReplyThread` insert-then-
      // reselect on conflict, and these partial unique indexes are
      // what makes the conflict possible instead of a silent
      // duplicate row.
      const threadIndexes = await sql.unsafe(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'chat' AND tablename = 'workbench_threads'`,
      );
      const threadIndexNames = threadIndexes.map((row) =>
        String(row["indexname"]),
      );
      expect(threadIndexNames).toContain("workbench_threads_root_key");
      expect(threadIndexNames).toContain("workbench_threads_reply_key");

      // CL-7199: `createDeliveryThread` insert-then-reselects on
      // conflict the same way; this partial unique index is what makes
      // the conflict possible instead of a silent duplicate delivery
      // thread per run.
      expect(threadIndexNames).toContain("workbench_threads_delivery_key");
    } finally {
      await sql.end();
    }
  });

  test("0008 makes a pre-existing row's absent contextWindow an explicit inherit, leaving a set value untouched", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`DELETE FROM "chat"."workbench_settings"`);
      await sql.unsafe(
        `INSERT INTO "chat"."workbench_settings" (tenant_id, workbench_id, settings, updated_by) VALUES
          ('tnt_1', 'chn_absent', '{"chat/kind": "channel"}'::jsonb, 'prn_1'),
          ('tnt_1', 'chn_override', '{"chat/kind": "channel", "chat/contextWindow": 5}'::jsonb, 'prn_1')`,
      );

      // 0008's own historical SQL text still names the pre-rename table
      // and column (see `chatMigrations`) — this scratch database has
      // already run 0018's rename, so exercising 0008's *behavior* here
      // means restating its `jsonb_set` logic against the current table
      // name rather than replaying that stale literal text.
      const contextWindowInheritSql = chatMigrations.find(
        (candidate) =>
          candidate.name === "0008_channel_context_window_explicit_inherit",
      );
      if (contextWindowInheritSql === undefined) {
        throw new Error("0008 migration missing from chatMigrations");
      }
      await sql.unsafe(`
        UPDATE "chat"."workbench_settings"
        SET "settings" = jsonb_set("settings", '{chat/contextWindow}', 'null'::jsonb)
        WHERE NOT ("settings" ? 'chat/contextWindow');
      `);

      const rows = await sql.unsafe(
        `SELECT workbench_id, settings FROM "chat"."workbench_settings" ORDER BY workbench_id`,
      );
      const byId = new Map(
        rows.map((row) => [String(row["workbench_id"]), row["settings"]]),
      );
      expect(
        (byId.get("chn_absent") as Record<string, unknown>)[
          "chat/contextWindow"
        ],
      ).toBeNull();
      expect(
        (byId.get("chn_override") as Record<string, unknown>)[
          "chat/contextWindow"
        ],
      ).toBe(5);
    } finally {
      await sql.end();
    }
  });
});

describeIfDb("0025_workbench_threads_unique_key dedupe", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  ).replace("_chat_migrations_test", "_chat_migrations_dedupe_test");
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  test("collapses duplicate root and reply threads, repointing thread_id and parent_thread_id references at the kept row", async () => {
    // Replay every migration through 0023 by hand, recording each in
    // the same ledger table `applyChatMigrations` reads, so the two
    // duplicate roots below can be seeded *before* 0025 exists to
    // forbid them — then let `applyChatMigrations` run 0025 for real.
    const preDedupeMigrations = chatMigrations.filter(
      (migration) => migration.name !== "0025_workbench_threads_unique_key",
    );
    const seed = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await seed.unsafe(`CREATE SCHEMA IF NOT EXISTS "chat"`);
      await seed.unsafe(
        `CREATE TABLE IF NOT EXISTS "chat"."chat_migrations" ` +
          `(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const migration of preDedupeMigrations) {
        await seed.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(
            `INSERT INTO "chat"."chat_migrations" (name) VALUES ($1)`,
            [migration.name],
          );
        });
      }

      await seed.unsafe(`
        INSERT INTO "chat"."workbench_threads"
          (id, tenant_id, workbench_id, kind, parent_message_id, created_at)
        VALUES
          ('thr_root_old', 'tnt_dedupe', 'wb_dedupe', 'root', NULL, now() - interval '1 hour'),
          ('thr_root_new', 'tnt_dedupe', 'wb_dedupe', 'root', NULL, now()),
          ('thr_reply_old', 'tnt_dedupe', 'wb_dedupe', 'reply', 'msg_parent', now() - interval '1 hour'),
          ('thr_reply_new', 'tnt_dedupe', 'wb_dedupe', 'reply', 'msg_parent', now())
      `);
      await seed.unsafe(`
        INSERT INTO "chat"."workbench_thread_messages"
          (tenant_id, workbench_id, thread_id, message_id)
        VALUES ('tnt_dedupe', 'wb_dedupe', 'thr_root_new', 'msg_dedupe')
      `);
      // A message parked in the dropped reply duplicate — proves
      // `workbench_messages.thread_id` is repointed, not just
      // `workbench_thread_messages.thread_id`.
      await seed.unsafe(`
        INSERT INTO "chat"."workbench_messages"
          (id, tenant_id, workbench_id, sender_address, thread_id, parts)
        VALUES (
          'msg_in_dropped_reply', 'tnt_dedupe', 'wb_dedupe', 'addr_1',
          'thr_reply_new', '[]'::jsonb
        )
      `);
      // A depth-2 thread anchored off the dropped root duplicate —
      // proves `workbench_threads.parent_thread_id` is repointed too,
      // not just message-facing references.
      await seed.unsafe(`
        INSERT INTO "chat"."workbench_threads"
          (id, tenant_id, workbench_id, kind, parent_message_id, parent_thread_id, created_at)
        VALUES (
          'thr_child_of_dropped_root', 'tnt_dedupe', 'wb_dedupe', 'reply',
          'msg_child', 'thr_root_new', now()
        )
      `);
    } finally {
      await seed.end();
    }

    const report = await applyChatMigrations(scratchUrl);
    expect(report.applied).toEqual(["0025_workbench_threads_unique_key"]);

    const verify = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const roots = await verify.unsafe(
        `SELECT id FROM "chat"."workbench_threads" ` +
          `WHERE tenant_id = 'tnt_dedupe' AND workbench_id = 'wb_dedupe' AND kind = 'root'`,
      );
      expect(roots.map((row) => String(row["id"]))).toEqual(["thr_root_old"]);

      const membership = await verify.unsafe(
        `SELECT thread_id FROM "chat"."workbench_thread_messages" WHERE message_id = 'msg_dedupe'`,
      );
      expect(String(membership[0]?.["thread_id"])).toBe("thr_root_old");

      const replies = await verify.unsafe(
        `SELECT id FROM "chat"."workbench_threads" ` +
          `WHERE tenant_id = 'tnt_dedupe' AND workbench_id = 'wb_dedupe' ` +
          `AND kind = 'reply' AND parent_message_id = 'msg_parent'`,
      );
      expect(replies.map((row) => String(row["id"]))).toEqual([
        "thr_reply_old",
      ]);

      const messageThreadId = await verify.unsafe(
        `SELECT thread_id FROM "chat"."workbench_messages" WHERE id = 'msg_in_dropped_reply'`,
      );
      expect(String(messageThreadId[0]?.["thread_id"])).toBe("thr_reply_old");

      const childParentThreadId = await verify.unsafe(
        `SELECT parent_thread_id FROM "chat"."workbench_threads" WHERE id = 'thr_child_of_dropped_root'`,
      );
      expect(String(childParentThreadId[0]?.["parent_thread_id"])).toBe(
        "thr_root_old",
      );

      // The reply unique index holds: a second reply row for the same
      // (tenant, workbench, parent_message_id) key is now rejected
      // rather than silently accepted as a second duplicate.
      // postgres.js queries are lazy thenables, not Promises; wrap so
      // `expect(...).rejects` actually runs the statement.
      await expect(
        (async () => {
          await verify.unsafe(
            `INSERT INTO "chat"."workbench_threads" ` +
              `(id, tenant_id, workbench_id, kind, parent_message_id) ` +
              `VALUES ('thr_reply_conflict', 'tnt_dedupe', 'wb_dedupe', 'reply', 'msg_parent')`,
          );
        })(),
      ).rejects.toThrow();
    } finally {
      await verify.end();
    }
  }, 120000);
});

describeIfDb("0026_workbench_threads_delivery_key dedupe", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  ).replace("_chat_migrations_test", "_chat_migrations_delivery_dedupe_test");
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  }, 20000);

  test("collapses duplicate delivery threads per run ref, repoints thread_id and parent_thread_id references, leaves null-run-ref rows untouched, and rejects a repeat insert", async () => {
    // Replay every migration through 0025 by hand, seeding the
    // duplicates 0026 must clean up before it exists to forbid them —
    // then let `applyChatMigrations` run 0026 for real.
    const preDeliveryKeyMigrations = chatMigrations.filter(
      (migration) => migration.name !== "0026_workbench_threads_delivery_key",
    );
    const seed = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await seed.unsafe(`CREATE SCHEMA IF NOT EXISTS "chat"`);
      await seed.unsafe(
        `CREATE TABLE IF NOT EXISTS "chat"."chat_migrations" ` +
          `(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const migration of preDeliveryKeyMigrations) {
        await seed.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(
            `INSERT INTO "chat"."chat_migrations" (name) VALUES ($1)`,
            [migration.name],
          );
        });
      }

      await seed.unsafe(`
        INSERT INTO "chat"."workbench_threads"
          (id, tenant_id, workbench_id, kind, run_ref, created_at)
        VALUES
          ('thr_delivery_old', 'tnt_ddedupe', 'wb_ddedupe', 'delivery', 'run_1', now() - interval '1 hour'),
          ('thr_delivery_new', 'tnt_ddedupe', 'wb_ddedupe', 'delivery', 'run_1', now())
      `);
      // Two delivery rows with a null run_ref: the window partition in
      // the dedupe groups nulls together (unlike the partial unique
      // index it backstops, which treats nulls as distinct), so these
      // must survive untouched rather than being collapsed to one row.
      await seed.unsafe(`
        INSERT INTO "chat"."workbench_threads"
          (id, tenant_id, workbench_id, kind, run_ref, created_at)
        VALUES
          ('thr_delivery_null_a', 'tnt_ddedupe', 'wb_ddedupe', 'delivery', NULL, now() - interval '1 hour'),
          ('thr_delivery_null_b', 'tnt_ddedupe', 'wb_ddedupe', 'delivery', NULL, now())
      `);
      await seed.unsafe(`
        INSERT INTO "chat"."workbench_thread_messages"
          (tenant_id, workbench_id, thread_id, message_id)
        VALUES ('tnt_ddedupe', 'wb_ddedupe', 'thr_delivery_new', 'msg_ddedupe')
      `);
      // A message parked in the dropped delivery duplicate — proves
      // `workbench_messages.thread_id` is repointed too.
      await seed.unsafe(`
        INSERT INTO "chat"."workbench_messages"
          (id, tenant_id, workbench_id, sender_address, thread_id, parts)
        VALUES (
          'msg_in_dropped_delivery', 'tnt_ddedupe', 'wb_ddedupe', 'addr_1',
          'thr_delivery_new', '[]'::jsonb
        )
      `);
      // A reply thread anchored directly on the dropped delivery
      // duplicate (a reply to a message that lived in it) — proves
      // `workbench_threads.parent_thread_id` is repointed, matching
      // `containerThreadFor`/`resolveThreadAnchor` letting a delivery
      // thread act as a reply's anchor.
      await seed.unsafe(`
        INSERT INTO "chat"."workbench_threads"
          (id, tenant_id, workbench_id, kind, parent_message_id, parent_thread_id, created_at)
        VALUES (
          'thr_child_of_dropped_delivery', 'tnt_ddedupe', 'wb_ddedupe', 'reply',
          'msg_child', 'thr_delivery_new', now()
        )
      `);
    } finally {
      await seed.end();
    }

    const report = await applyChatMigrations(scratchUrl);
    expect(report.applied).toEqual(["0026_workbench_threads_delivery_key"]);

    const verify = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      const deliveries = await verify.unsafe(
        `SELECT id FROM "chat"."workbench_threads" ` +
          `WHERE tenant_id = 'tnt_ddedupe' AND workbench_id = 'wb_ddedupe' ` +
          `AND kind = 'delivery' AND run_ref = 'run_1'`,
      );
      expect(deliveries.map((row) => String(row["id"]))).toEqual([
        "thr_delivery_old",
      ]);

      const nullRunRefRows = await verify.unsafe(
        `SELECT id FROM "chat"."workbench_threads" ` +
          `WHERE tenant_id = 'tnt_ddedupe' AND workbench_id = 'wb_ddedupe' ` +
          `AND kind = 'delivery' AND run_ref IS NULL`,
      );
      expect(nullRunRefRows.map((row) => String(row["id"])).sort()).toEqual([
        "thr_delivery_null_a",
        "thr_delivery_null_b",
      ]);

      const membership = await verify.unsafe(
        `SELECT thread_id FROM "chat"."workbench_thread_messages" WHERE message_id = 'msg_ddedupe'`,
      );
      expect(String(membership[0]?.["thread_id"])).toBe("thr_delivery_old");

      const messageThreadId = await verify.unsafe(
        `SELECT thread_id FROM "chat"."workbench_messages" WHERE id = 'msg_in_dropped_delivery'`,
      );
      expect(String(messageThreadId[0]?.["thread_id"])).toBe(
        "thr_delivery_old",
      );

      const childParentThreadId = await verify.unsafe(
        `SELECT parent_thread_id FROM "chat"."workbench_threads" WHERE id = 'thr_child_of_dropped_delivery'`,
      );
      expect(String(childParentThreadId[0]?.["parent_thread_id"])).toBe(
        "thr_delivery_old",
      );

      // The delivery unique index holds: a second delivery row for the
      // same (tenant, workbench, run_ref) key is now rejected rather
      // than silently accepted as a second duplicate.
      await expect(
        (async () => {
          await verify.unsafe(
            `INSERT INTO "chat"."workbench_threads" ` +
              `(id, tenant_id, workbench_id, kind, run_ref) ` +
              `VALUES ('thr_delivery_conflict', 'tnt_ddedupe', 'wb_ddedupe', 'delivery', 'run_1')`,
          );
        })(),
      ).rejects.toThrow();

      // A null run_ref never conflicts, matching the partial index's
      // predicate.
      await verify.unsafe(
        `INSERT INTO "chat"."workbench_threads" ` +
          `(id, tenant_id, workbench_id, kind, run_ref) ` +
          `VALUES ('thr_delivery_null_c', 'tnt_ddedupe', 'wb_ddedupe', 'delivery', NULL)`,
      );
    } finally {
      await verify.end();
    }
  }, 120000);
});
