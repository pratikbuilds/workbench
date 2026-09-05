// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring this package's `migrations.test.ts`. Runs
// against its own scratch database, never the developer's or the
// walking-skeleton suite's.
//
// Proves the one thing an in-memory `WebhookTriggerStore` fake cannot:
// that `createDrizzleWebhookTriggerStore` actually round-trips a secret
// through `CredentialCipher` — encrypted on disk, decrypted back to the
// exact plaintext on read — and that a real (non-noop) cipher's
// ciphertext is not the plaintext secret, so a raw table dump does not
// disclose it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  createEnvKeyCredentialCipher,
  createNoopCredentialCipher,
} from "@intx/crypto";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { applyWebhookTriggersMigrations } from "../src/migrations";
import { createDrizzleWebhookTriggerStore } from "../src/store";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_webhook_triggers_store_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT_ID = "tnt_1";
const KEY = new Uint8Array(32).fill(7);

describeIfDb(
  "createDrizzleWebhookTriggerStore: secret encryption at rest",
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
      await applyWebhookTriggersMigrations(scratchUrl);
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

    test("a real cipher's stored secret is not the plaintext, and round-trips correctly", async () => {
      const sql = postgres(scratchUrl, { max: 1 });
      try {
        const db = drizzle(sql);
        const cipher = createEnvKeyCredentialCipher(KEY);
        const store = createDrizzleWebhookTriggerStore(db, cipher);

        const created = await store.create({
          id: "wht_encrypted",
          tenantId: TENANT_ID,
          name: "Support digest",
          workflowDefinitionId: "def_1",
          inputTemplate: "New delivery.",
          secret: "the-plaintext-secret",
          createdBy: "user_1",
        });
        expect(created.secret).toBe("the-plaintext-secret");

        const [rawRow] =
          await sql`select secret from webhook_triggers.webhook_trigger where id = ${created.id}`;
        expect(rawRow?.["secret"]).not.toBe("the-plaintext-secret");
        expect(String(rawRow?.["secret"])).toContain("enc:");

        const fetched = await store.get(TENANT_ID, created.id);
        expect(fetched?.secret).toBe("the-plaintext-secret");

        const fetchedById = await store.getById(created.id);
        expect(fetchedById?.secret).toBe("the-plaintext-secret");
      } finally {
        await sql.end();
      }
    });

    test("rotateSecret re-encrypts and the new secret round-trips", async () => {
      const sql = postgres(scratchUrl, { max: 1 });
      try {
        const db = drizzle(sql);
        const cipher = createEnvKeyCredentialCipher(KEY);
        const store = createDrizzleWebhookTriggerStore(db, cipher);

        const created = await store.create({
          id: "wht_rotate",
          tenantId: TENANT_ID,
          name: "Rotation test",
          workflowDefinitionId: "def_1",
          inputTemplate: "New delivery.",
          secret: "original-secret",
          createdBy: "user_1",
        });

        const rotated = await store.rotateSecret(
          TENANT_ID,
          created.id,
          "rotated-secret",
        );
        expect(rotated?.secret).toBe("rotated-secret");

        const [rawRow] =
          await sql`select secret from webhook_triggers.webhook_trigger where id = ${created.id}`;
        expect(rawRow?.["secret"]).not.toBe("rotated-secret");

        const fetched = await store.get(TENANT_ID, created.id);
        expect(fetched?.secret).toBe("rotated-secret");
      } finally {
        await sql.end();
      }
    });

    test("a noop cipher (dev/test default) round-trips as plaintext identity", async () => {
      const sql = postgres(scratchUrl, { max: 1 });
      try {
        const db = drizzle(sql);
        const store = createDrizzleWebhookTriggerStore(
          db,
          createNoopCredentialCipher(),
        );

        const created = await store.create({
          id: "wht_noop",
          tenantId: TENANT_ID,
          name: "Noop cipher test",
          workflowDefinitionId: "def_1",
          inputTemplate: "New delivery.",
          secret: "plain-secret",
          createdBy: "user_1",
        });

        const [rawRow] =
          await sql`select secret from webhook_triggers.webhook_trigger where id = ${created.id}`;
        expect(rawRow?.["secret"]).toBe("plain-secret");

        const fetched = await store.get(TENANT_ID, created.id);
        expect(fetched?.secret).toBe("plain-secret");
      } finally {
        await sql.end();
      }
    });

    // CL-7242: `startReviewingRepos`'s check-then-act
    // (hasWebhookTrigger then createWebhookTrigger) can race two
    // concurrent "start reviewing" calls for the same repo past the
    // read before either write lands. `ensure` is the actual backstop
    // apps/hub's `createWebhookTrigger` port binds to instead of
    // `create` — reconstructs the audit's finding (2 live triggers for
    // one repo) against the real `webhook_trigger_tenant_definition_name_unique`
    // index (migration 0003).
    test("two concurrent ensure() calls for the same tenant/definition/name settle on exactly one trigger", async () => {
      const sql = postgres(scratchUrl, { max: 5 });
      try {
        const db = drizzle(sql);
        const cipher = createEnvKeyCredentialCipher(KEY);
        const store = createDrizzleWebhookTriggerStore(db, cipher);

        const input = (id: string) => ({
          id,
          tenantId: TENANT_ID,
          name: "acme/widgets pull-request-opened",
          workflowDefinitionId: "def_code_review",
          inputTemplate: "Review the pull request at {{pull_request.html_url}}",
          secret: `secret-${id}`,
          createdBy: "user_1",
        });

        const [first, second] = await Promise.all([
          store.ensure(input("wht_race_1")),
          store.ensure(input("wht_race_2")),
        ]);

        expect(first.id).toBe(second.id);
        expect(first.secret).toBe(second.secret);

        const rows = await sql`
          select id from webhook_triggers.webhook_trigger
          where tenant_id = ${TENANT_ID} and workflow_definition_id = 'def_code_review'
            and name = 'acme/widgets pull-request-opened'
        `;
        expect(rows).toHaveLength(1);
      } finally {
        await sql.end();
      }
    });
  },
);
