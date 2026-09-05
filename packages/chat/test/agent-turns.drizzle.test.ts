// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `migrations.test.ts`. Runs against its own scratch database.
//
// `agent-turns.test.ts` proves the projection's contract against the
// in-memory store, which allocates occurrences on a single-threaded
// event loop and so can never actually race. This exercises the real
// `createDrizzleAgentTurnStore`, where two dispatches for the same
// (workbench, agent) really do race for the next occurrence — and
// therefore for a child run id. Two turns quietly sharing one run id is
// exactly the traceability hole this projection exists to close, so the
// bar here is that the race is loud, never silently duplicated.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import {
  AGENT_TURN_STALE_MS,
  createDrizzleAgentTurnStore,
} from "../src/agent-turns";
import { applyChatMigrations } from "../src/migrations";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_chat_agent_turns_drizzle_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT = "tnt_1";
const WORKBENCH = "run_workbench1";
const AGENT = "ins_echo1@acme.example";

describeIfDb("createDrizzleAgentTurnStore", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");

  async function withMaintenance(
    run: (sql: ReturnType<typeof postgres>) => Promise<void>,
  ): Promise<void> {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await run(maintenance);
    } finally {
      await maintenance.end();
    }
  }

  beforeAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await sql.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    });
    await applyChatMigrations(scratchUrl);
  });

  afterAll(async () => {
    await withMaintenance(async (sql) => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    });
  });

  test("occurrences advance per (workbench, agent), and a turn round-trips", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleAgentTurnStore(drizzle(sql));

      const first = await store.startTurn({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        agentAddress: AGENT,
        requestMessageIds: ["msg_1"],
      });
      const second = await store.startTurn({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        agentAddress: AGENT,
        requestMessageIds: ["msg_2"],
      });
      const otherAgent = await store.startTurn({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        agentAddress: "ins_echo2@acme.example",
        requestMessageIds: ["msg_2"],
      });

      expect([first.childRunId, second.childRunId]).toEqual([
        "turn__0",
        "turn__1",
      ]);
      expect(otherAgent.childRunId).toBe("turn__0");
      expect(first.status).toBe("running");
      expect(first.requestMessageIds).toEqual(["msg_1"]);

      const finished = await store.finishTurn({
        tenantId: TENANT,
        turnId: first.id,
        status: "completed",
        sectionRunId: "wfr_section1",
        replyMessageId: "msg_reply",
      });
      expect(finished?.status).toBe("completed");
      expect(finished?.sectionRunId).toBe("wfr_section1");
      expect(finished?.endedAt).not.toBeNull();

      const read = await store.getTurn({ tenantId: TENANT, turnId: first.id });
      expect(read?.replyMessageId).toBe("msg_reply");
      expect(read?.childRunId).toBe("turn__0");

      const listed = await store.listTurns({
        tenantId: TENANT,
        workbenchId: WORKBENCH,
      });
      expect(listed).toHaveLength(3);
    } finally {
      await sql.end();
    }
  });

  test("two dispatches racing for one agent never quietly share a child run id", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleAgentTurnStore(drizzle(sql));
      const input = {
        tenantId: TENANT,
        workbenchId: "run_race",
        agentAddress: AGENT,
        requestMessageIds: ["msg_race"],
      };

      const settled = await Promise.allSettled([
        store.startTurn(input),
        store.startTurn(input),
      ]);
      const opened = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      // Either both won distinct occurrences, or the unique index made
      // the loser fail loudly. What must never happen is two rows
      // claiming the same child run id.
      const childRunIds = opened.map((turn) => turn.childRunId);
      expect(new Set(childRunIds).size).toBe(childRunIds.length);

      const listed = await store.listTurns({
        tenantId: TENANT,
        workbenchId: "run_race",
      });
      expect(new Set(listed.map((turn) => turn.childRunId)).size).toBe(
        listed.length,
      );
    } finally {
      await sql.end();
    }
  });

  // CL-6451: a dispatch the supervisor failed never sends the event
  // that closes its row — a `running` row past the stale cutoff is dead
  // by construction and must read back failed.
  test("a running turn past the stale cutoff reads back failed", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      let clock = Date.now();
      const store = createDrizzleAgentTurnStore(drizzle(sql), {
        now: () => clock,
      });
      const input = {
        tenantId: TENANT,
        workbenchId: "run_stale",
        agentAddress: AGENT,
        requestMessageIds: ["msg_stale"],
      };
      const opened = await store.startTurn(input);

      // `startedAt` is stamped by the database, not the injected clock,
      // so age the clock from a fresh reading with a wide margin.
      clock = Date.now() + AGENT_TURN_STALE_MS + 60_000;

      expect(await store.findRunningTurn(input)).toBeUndefined();
      const read = await store.getTurn({
        tenantId: TENANT,
        turnId: opened.id,
      });
      expect(read?.status).toBe("failed");
      expect(read?.error).not.toBeNull();
      expect(read?.endedAt).not.toBeNull();
    } finally {
      await sql.end();
    }
  });

  // CL-6396: the in-memory store already names a specific occurrence when
  // `childRunId` is given. This is that same lookup against the production
  // Drizzle store — `eq(agentTurns.childRunId)` must pick the named row,
  // never the newest-occurrence fallback, while two rows are still running.
  test("findRunningTurn names a specific occurrence when childRunId is given", async () => {
    const sql = postgres(scratchUrl, { max: 5, onnotice: () => undefined });
    try {
      const store = createDrizzleAgentTurnStore(drizzle(sql));
      const input = {
        tenantId: TENANT,
        workbenchId: "run_child_run_id",
        agentAddress: AGENT,
        requestMessageIds: ["msg_lookup"],
      };
      const first = await store.startTurn(input);
      const second = await store.startTurn(input);
      expect(first.childRunId).toBe("turn__0");
      expect(second.childRunId).toBe("turn__1");
      expect(first.status).toBe("running");
      expect(second.status).toBe("running");

      expect((await store.findRunningTurn(input))?.id).toBe(second.id);
      expect(
        (await store.findRunningTurn({ ...input, childRunId: "turn__0" }))?.id,
      ).toBe(first.id);
      expect(
        (await store.findRunningTurn({ ...input, childRunId: "turn__1" }))?.id,
      ).toBe(second.id);
      expect(
        await store.findRunningTurn({ ...input, childRunId: "turn__9" }),
      ).toBeUndefined();
    } finally {
      await sql.end();
    }
  });
});
