// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring
// `packages/granola-tools/test/credential-delivery.drizzle.test.ts`. Runs
// against its own Postgres schema, never the developer's or the
// walking-skeleton suite's.
//
// Proves the CL-7073 critique's finding 2: a catalog workflow's required
// connection reads as satisfied when the CONNECTED provider lives on an
// ancestor tenant, not only the exact deploying tenant — the same
// ancestor-chain precedence Plugins' `connectorStatus` and
// `@intx/db`'s credential resolution both use (child shadows parent).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema } from "@intx/db";
import { schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../../scripts/e2e/harness";
import { dbGate } from "../../../../scripts/e2e/db-gate";
import { listAvailableCatalogWorkflows } from "./available-catalog";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const SCHEMA = "workflows_available_catalog_test";

describeIfDb(
  "listAvailableCatalogWorkflows: ancestor-chain connection satisfaction",
  () => {
    const target = dbTargetFromUrl(
      databaseUrl ?? "postgres://localhost:5432/unused",
    );

    beforeAll(async () => {
      await runMigrations(target, { schema: SCHEMA });
    });

    afterAll(async () => {
      await dropSchema(target, { schema: SCHEMA });
    });

    test("a child workbench sees code-review as connected via its parent bench's github connection", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await db.insert(schema.tenant).values({
          id: "tnt_parent_bench",
          name: "Parent Bench",
          slug: "parent-bench",
          domain: "parent-bench.workbench.test",
        });
        await db.insert(schema.tenant).values({
          id: "tnt_child_workbench",
          name: "Child Workbench",
          slug: "child-workbench",
          domain: "child-workbench.workbench.test",
          parentId: "tnt_parent_bench",
        });
        await db.insert(schema.provider).values({
          id: "prov_parent_github",
          tenantId: "tnt_parent_bench",
          name: "github",
          plugin: "github",
        });
        await db.insert(schema.credential).values({
          id: "cred_parent_github",
          tenantId: "tnt_parent_bench",
          providerId: "prov_parent_github",
          name: "github-default",
          type: "oauth_token",
          secret: "encrypted-not-decrypted-by-this-path",
          status: "active",
        });

        const result = await listAvailableCatalogWorkflows({
          db,
          tenantId: "tnt_child_workbench",
          catalogAssetNames: ["code-review"],
        });

        const codeReview = result.find(
          (entry) => entry.assetName === "code-review",
        );
        expect(codeReview?.connectionsSatisfied).toBe(true);
        expect(codeReview?.missingConnections).toEqual([]);
      } finally {
        await close();
      }
    });

    test("a bench with no ancestor connection sees code-review as not yet connected", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        await db.insert(schema.tenant).values({
          id: "tnt_unconnected_bench",
          name: "Unconnected Bench",
          slug: "unconnected-bench",
          domain: "unconnected-bench.workbench.test",
        });

        const result = await listAvailableCatalogWorkflows({
          db,
          tenantId: "tnt_unconnected_bench",
          catalogAssetNames: ["code-review"],
        });

        const codeReview = result.find(
          (entry) => entry.assetName === "code-review",
        );
        expect(codeReview?.connectionsSatisfied).toBe(false);
        expect(codeReview?.missingConnections).toEqual(["github"]);
      } finally {
        await close();
      }
    });
  },
);
