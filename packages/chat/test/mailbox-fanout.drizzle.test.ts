// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `threads.drizzle.test.ts`. Runs against its own scratch database with
// a minimal control plane (`tenant`/`principal`) the mailbox FKs need.
//
// Proves `createDrizzleMailboxWriter`'s one write path — a batch through
// `@corbits/mailbox`'s own `writeMailboxMessages` — against a real
// `@corbits/mailbox` schema: an outbound row and an inbound row committed
// together in one transaction, both dedupe on a retried batch, and — the
// critique's frame-Message-ID probe — the stored frame's `Message-ID:`
// header, the row's own cached `message_id` column, and the batch's
// caller-supplied `messageKey` all agree, with `In-Reply-To:` likewise
// matching what the caller passed in.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createMailboxDb, runMailboxMigrations } from "@corbits/mailbox";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { dbGate } from "../../../scripts/e2e/db-gate";
import {
  createDrizzleMailboxWriter,
  type MailboxBatchItem,
} from "../src/mailbox-fanout";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_mailbox_fanout_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT_ID = "tnt_1";
const PRINCIPAL_ID = "prn_alice";
const OTHER_PRINCIPAL_ID = "prn_bob";
const DOMAIN = "acme.example";

describeIfDb("createDrizzleMailboxWriter", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  async function freshDb() {
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
    const { db, close } = createMailboxDb(scratchUrl);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "tenant" ("id" text PRIMARY KEY)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "principal" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE
      )
    `);
    await db.execute(sql`INSERT INTO "tenant" ("id") VALUES (${TENANT_ID})`);
    await db.execute(
      sql`INSERT INTO "principal" ("id", "tenant_id") VALUES (${PRINCIPAL_ID}, ${TENANT_ID}), (${OTHER_PRINCIPAL_ID}, ${TENANT_ID})`,
    );
    await runMailboxMigrations(db);
    return { db, close };
  }

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

  test("a batch writes an outbound and an inbound row together and dedupes a retried batch", async () => {
    const { db, close } = await freshDb();
    try {
      const writer = createDrizzleMailboxWriter(db);
      const messageId = "<msg_1@acme.example>";

      const items: MailboxBatchItem[] = [
        {
          tenantId: TENANT_ID,
          principalId: PRINCIPAL_ID,
          address: `${PRINCIPAL_ID}@${DOMAIN}`,
          fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
          subject: "hello",
          body: "hello",
          messageId,
          direction: "outbound",
        },
        {
          tenantId: TENANT_ID,
          principalId: OTHER_PRINCIPAL_ID,
          address: `${OTHER_PRINCIPAL_ID}@${DOMAIN}`,
          fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
          subject: "hello",
          body: "hello",
          messageId,
          direction: "inbound",
        },
      ];

      const results = await writer.writeBatch(items);
      expect(results.map((r) => r.id !== null)).toEqual([true, true]);

      const rows = await db.execute<{
        principal_id: string;
        direction: string;
        message_id: string;
      }>(
        sql`SELECT principal_id, direction, message_id FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID} ORDER BY principal_id`,
      );
      expect([...rows]).toEqual([
        {
          principal_id: PRINCIPAL_ID,
          direction: "outbound",
          message_id: messageId,
        },
        {
          principal_id: OTHER_PRINCIPAL_ID,
          direction: "inbound",
          message_id: messageId,
        },
      ]);

      // A retried batch is idempotent — the default transport key dedupes
      // both rows without writing a duplicate of either.
      const retried = await writer.writeBatch(items);
      expect(retried.every((r) => r.id === null)).toBe(true);

      const countRows = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID}`,
      );
      expect(countRows[0]?.count).toBe("2");
    } finally {
      await close();
    }
  }, 20000);

  test("a batch that fails partway writes nothing, and a retry after a real success writes nothing twice", async () => {
    const { db, close } = await freshDb();
    try {
      const writer = createDrizzleMailboxWriter(db);
      const messageId = "<msg_partial@acme.example>";

      const badItems: MailboxBatchItem[] = [
        {
          tenantId: TENANT_ID,
          principalId: PRINCIPAL_ID,
          address: `${PRINCIPAL_ID}@${DOMAIN}`,
          fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
          subject: "hello",
          body: "hello",
          messageId,
          direction: "outbound",
        },
        {
          // An unknown principal: the FK refuses this row, and the whole
          // batch's transaction must roll back — including the first,
          // otherwise-valid item above.
          tenantId: TENANT_ID,
          principalId: "prn_ghost",
          address: `prn_ghost@${DOMAIN}`,
          fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
          subject: "hello",
          body: "hello",
          messageId,
          direction: "inbound",
        },
      ];

      await expect(writer.writeBatch(badItems)).rejects.toThrow();

      const afterFailure = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID}`,
      );
      expect(afterFailure[0]?.count).toBe("0");

      // Retry with a corrected batch: succeeds and writes exactly the
      // rows a first-time success would have.
      const goodItems: MailboxBatchItem[] = [
        badItems[0] as MailboxBatchItem,
        {
          tenantId: TENANT_ID,
          principalId: OTHER_PRINCIPAL_ID,
          address: `${OTHER_PRINCIPAL_ID}@${DOMAIN}`,
          fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
          subject: "hello",
          body: "hello",
          messageId,
          direction: "inbound",
        },
      ];
      const succeeded = await writer.writeBatch(goodItems);
      expect(succeeded.every((r) => r.id !== null)).toBe(true);

      // Retrying the now-successful batch again writes nothing more.
      const retried = await writer.writeBatch(goodItems);
      expect(retried.every((r) => r.id === null)).toBe(true);

      const countRows = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text FROM "mailbox"."principal_mail" WHERE "tenant_id" = ${TENANT_ID}`,
      );
      expect(countRows[0]?.count).toBe("2");
    } finally {
      await close();
    }
  }, 20000);

  // Critique probe folded in: the stored frame's `Message-ID:` header,
  // the row's cached `message_id` column, and `In-Reply-To:` all agree
  // with what the caller passed in — never a separately-minted id.
  test("the stored frame's Message-ID and In-Reply-To match the caller's own", async () => {
    const { db, close } = await freshDb();
    try {
      const writer = createDrizzleMailboxWriter(db);
      const messageId = "<row1@acme.example>";
      const inReplyTo = "<row0@acme.example>";

      await writer.writeBatch([
        {
          tenantId: TENANT_ID,
          principalId: PRINCIPAL_ID,
          address: `${PRINCIPAL_ID}@${DOMAIN}`,
          fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
          subject: "s",
          body: "b",
          messageId,
          direction: "outbound",
          inReplyTo,
        },
        {
          tenantId: TENANT_ID,
          principalId: OTHER_PRINCIPAL_ID,
          address: `${OTHER_PRINCIPAL_ID}@${DOMAIN}`,
          fromAddress: `${PRINCIPAL_ID}@${DOMAIN}`,
          subject: "s",
          body: "b",
          messageId,
          direction: "inbound",
          inReplyTo,
        },
      ]);

      const rows = await db.execute<{ principal_id: string; raw: Buffer }>(
        sql`SELECT principal_id, raw FROM "mailbox"."principal_mail" ORDER BY principal_id`,
      );
      const headers = [...rows].map((r) => {
        const text = Buffer.from(r.raw).toString("utf8");
        const h = (n: string) =>
          text.match(new RegExp(`^${n}:\\s*(.*)$`, "im"))?.[1] ?? null;
        return {
          principal: r.principal_id,
          messageId: h("Message-ID"),
          inReplyTo: h("In-Reply-To"),
        };
      });
      for (const header of headers) {
        expect(header.messageId).toBe(messageId);
        expect(header.inReplyTo).toBe(inReplyTo);
      }
    } finally {
      await close();
    }
  }, 20000);
});
