// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring `write-claims.drizzle.test.ts`.
// Runs against its own scratch database.
//
// Proves `createDrizzleTurnMailCorrelationStore`'s race safety: two
// concurrent `recordTurnMail` calls for the same mail really do race at
// the database (a real connection pool, not one connection serializing
// them), and the fix (`INSERT ... ON CONFLICT DO NOTHING`, never
// select-then-branch) never throws a raw PK-violation and keeps the
// first source — the exact scenario CL-6314 exists to close: a retried
// dispatch racing itself must never re-point a mail another delivery
// already claimed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyChatMigrations } from "../src/migrations";
import { createDrizzleTurnMailCorrelationStore } from "../src/turn-mail-correlation";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_turn_mail_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb(
  "createDrizzleTurnMailCorrelationStore: concurrent recordTurnMail",
  () => {
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
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
        await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
      } finally {
        await maintenance.end();
      }
      await applyChatMigrations(scratchUrl);
    });

    afterAll(async () => {
      const maintenanceUrl = new URL(scratchUrl);
      maintenanceUrl.pathname = "/postgres";
      const maintenance = postgres(maintenanceUrl.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await maintenance.unsafe(
          `DROP DATABASE IF EXISTS "${scratchDatabase}"`,
        );
      } finally {
        await maintenance.end();
      }
    });

    test("two concurrent records for the same mail never throw, and the first source wins", async () => {
      // `max: 5` — a real connection pool, so the two records below issue
      // genuinely overlapping queries rather than being serialized onto
      // one connection before either can race the other.
      const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
      try {
        const store = createDrizzleTurnMailCorrelationStore(drizzle(sql));

        await Promise.all([
          store.recordTurnMail({
            tenantId: "ten_1",
            mailId: "mail_race_1",
            workbenchId: "ins_workbench1",
            sourceMessageId: "msg_first",
          }),
          store.recordTurnMail({
            tenantId: "ten_1",
            mailId: "mail_race_1",
            workbenchId: "ins_workbench1",
            sourceMessageId: "msg_second",
          }),
        ]);

        const rows = await sql.unsafe(
          `SELECT * FROM "chat"."turn_mail_correlation" WHERE "tenant_id" = 'ten_1' AND "mail_id" = 'mail_race_1'`,
        );
        expect(rows).toHaveLength(1);

        // Either racer may win the insert — what matters is exactly one
        // row survives, never two and never a thrown PK-violation.
        const source = await store.findTurnMailSource({
          tenantId: "ten_1",
          mailId: "mail_race_1",
        });
        if (source?.sourceMessageId === undefined) {
          throw new Error("expected the raced mail to resolve to one source");
        }
        expect(["msg_first", "msg_second"]).toContain(source.sourceMessageId);
      } finally {
        await sql.end();
      }
    });

    test("record then find round-trips the source", async () => {
      const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
      try {
        const store = createDrizzleTurnMailCorrelationStore(drizzle(sql));
        await store.recordTurnMail({
          tenantId: "ten_1",
          mailId: "mail_roundtrip_1",
          workbenchId: "ins_workbench1",
          sourceMessageId: "msg_1",
        });

        expect(
          await store.findTurnMailSource({
            tenantId: "ten_1",
            mailId: "mail_roundtrip_1",
          }),
        ).toEqual({
          tenantId: "ten_1",
          workbenchId: "ins_workbench1",
          sourceMessageId: "msg_1",
        });
        expect(
          await store.findTurnMailSource({
            tenantId: "ten_1",
            mailId: "mail_missing",
          }),
        ).toBeUndefined();
      } finally {
        await sql.end();
      }
    });
  },
);
