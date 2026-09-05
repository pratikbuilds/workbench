import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import type {
  Principal,
  RepoId,
  RepoStore,
} from "@intx/hub-sessions/substrate";
import type { ConversationTurn, PendingOperation } from "@intx/types/runtime";

import {
  createDurableConversationStore,
  durableConversationAgentStateDir,
  durableConversationAgentStatePrefix,
  prepareConversationForOriginatingWorkbench,
  reconstructDurableConversation,
} from "./conversation-state";
import { originatingWorkbenchIdFromRequest } from "./originating-workbench";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs
      .splice(0)
      .map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const WORKFLOW_RUN_REPO_ID: RepoId = { kind: "workflow-run", id: "wfr_iso" };

function userTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as ConversationTurn;
}

function peekTurns(store: { storage: unknown }): ConversationTurn[] {
  const storage = store.storage as { peekTurns: () => ConversationTurn[] };
  return storage.peekTurns();
}

function fsBackedSubstrate(repoDir: string): RepoStore {
  return {
    getRepoDir: () => repoDir,
    writeTreePreservingPrefix: async (
      _principal: Principal,
      _repoId: RepoId,
      _ref: string,
      args: Parameters<RepoStore["writeTreePreservingPrefix"]>[3],
    ) => {
      const prefixDir = path.join(
        repoDir,
        ...args.preservePrefix
          .split("/")
          .filter((seg: string) => seg.length > 0),
      );
      const existing = new Map<string, Uint8Array>();
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(prefixDir);
      } catch (cause) {
        if (!(
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )) {
          throw cause;
        }
      }
      for (const name of names) {
        const full = path.join(prefixDir, name);
        const st = await fs.promises.stat(full);
        if (st.isFile()) {
          existing.set(
            `${args.preservePrefix}${name}`,
            await fs.promises.readFile(full),
          );
        }
      }
      const files = await args.merge(existing);
      await fs.promises.rm(prefixDir, { recursive: true, force: true });
      for (const [rel, content] of Object.entries(files)) {
        const dest = path.join(
          repoDir,
          ...rel.split("/").filter((seg: string) => seg.length > 0),
        );
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, content);
      }
      return { commitSha: "test" };
    },
  } as unknown as RepoStore;
}

async function makeStore(root: string) {
  const repoDir = path.join(root, "repo");
  await fs.promises.mkdir(repoDir, { recursive: true });
  return createDurableConversationStore({
    localStoreDir: path.join(root, "local"),
    signer: () => Promise.resolve("sig"),
    substrate: fsBackedSubstrate(repoDir),
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    workflowRunRef: "refs/heads/main",
    principal: { kind: "workflow-process", anchorRunId: "run_1" } as Principal,
    agentKey: "default",
  }).then((store) => ({ store, repoDir }));
}

test("durable conversation prefix nests workbench under agentKey", () => {
  expect(durableConversationAgentStatePrefix("default", "chan_a")).toBe(
    "agent-state/default/chan_a/",
  );
  expect(durableConversationAgentStatePrefix("step_1", "chan_a")).not.toBe(
    durableConversationAgentStatePrefix("step_2", "chan_a"),
  );
});

test("two rooms of one agent keep isolated turns; a new room starts empty", async () => {
  const root = tmpDir("conv-iso-");
  const { store, repoDir } = await makeStore(root);

  expect(await store.bindOriginatingWorkbench("chan_a")).toBe(true);
  await store.storage.writeTurns([userTurn("room A tool result")]);
  await store.mirrorToSubstrate();

  const roomADir = durableConversationAgentStateDir(
    repoDir,
    "default",
    "chan_a",
  );
  const reconstructedA = await reconstructDurableConversation(
    roomADir,
    "default/chan_a",
  );
  expect(reconstructedA?.turns).toHaveLength(1);

  expect(await store.bindOriginatingWorkbench("chan_b")).toBe(true);
  expect(peekTurns(store)).toEqual([]);

  const mixedLegacy = path.join(
    repoDir,
    "agent-state",
    "default",
    "checkpoint.json",
  );
  expect(fs.existsSync(mixedLegacy)).toBe(false);

  await store.storage.writeTurns([userTurn("room B first infer")]);
  await store.mirrorToSubstrate();

  expect(await store.bindOriginatingWorkbench("chan_a")).toBe(true);
  expect(peekTurns(store)).toEqual([userTurn("room A tool result")]);

  expect(await store.bindOriginatingWorkbench("chan_b")).toBe(true);
  expect(peekTurns(store)).toEqual([userTurn("room B first infer")]);

  expect(await store.bindOriginatingWorkbench("chan_b")).toBe(false);
});

const EMPTY_TOKEN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

test("a retired signal-kind pending op is dropped on restore, not thrown on", async () => {
  const root = tmpDir("conv-retired-kind-");
  const agentStateDir = path.join(root, "agent-state", "default", "chan_a");
  await fs.promises.mkdir(agentStateDir, { recursive: true });

  const survivingOp: PendingOperation = {
    correlationId: "corr-approval",
    kind: "approval",
    registeredAt: 0,
    gateId: "gate-approval",
  };
  const retiredOp = {
    correlationId: "corr-retired",
    kind: "message_response",
    registeredAt: 0,
    gateId: "gate-retired",
  };

  await fs.promises.writeFile(
    path.join(agentStateDir, "checkpoint.json"),
    JSON.stringify({
      turns: [],
      pendingOperations: [survivingOp, retiredOp],
      tokenUsage: EMPTY_TOKEN_USAGE,
      connectorState: null,
    }),
  );
  await fs.promises.writeFile(
    path.join(agentStateDir, "checkpoint.meta.json"),
    JSON.stringify({
      checkpointSeq: 0,
      turnCount: 0,
      pendingOperations: [survivingOp, retiredOp],
      tokenUsage: EMPTY_TOKEN_USAGE,
      connectorState: null,
    }),
  );

  const reconstructed = await reconstructDurableConversation(
    agentStateDir,
    "default/chan_a",
  );

  expect(reconstructed?.pendingOperations).toEqual([survivingOp]);
});

test("two queued mails bind and mirror under each message's From not a later origin", async () => {
  const root = tmpDir("conv-queued-");
  const { store } = await makeStore(root);
  const registry = {
    acquire: () => Promise.resolve(store),
    get: () => store,
    peek: () => store,
  };
  const mailRequest = (from: string) => ({
    input: {
      headers: { from, to: ["myra@alice.localhost"] },
      rawHeaders: {},
      parts: [],
    },
  });
  // Both inbound mails exist (enqueued) before the first invokeStep. A
  // latest-wins origin file would now name chan_b for both binds.
  const fromA = originatingWorkbenchIdFromRequest(
    mailRequest("chan_a@alice.localhost"),
  );
  const fromB = originatingWorkbenchIdFromRequest(
    mailRequest("chan_b@alice.localhost"),
  );
  expect(fromA).toBe("chan_a");
  expect(fromB).toBe("chan_b");

  await prepareConversationForOriginatingWorkbench({
    registry: registry as never,
    agentKey: "default",
    originatingWorkbenchId: fromA,
  });
  await store.storage.writeTurns([userTurn("from A")]);
  await store.mirrorToSubstrate();

  await prepareConversationForOriginatingWorkbench({
    registry: registry as never,
    agentKey: "default",
    originatingWorkbenchId: fromB,
  });
  expect(peekTurns(store)).toEqual([]);
  await store.storage.writeTurns([userTurn("from B")]);
  await store.mirrorToSubstrate();

  await prepareConversationForOriginatingWorkbench({
    registry: registry as never,
    agentKey: "default",
    originatingWorkbenchId: fromA,
  });
  expect(peekTurns(store)).toEqual([userTurn("from A")]);
});

test("prepareConversationForOriginatingWorkbench evicts the warm agent on room change only", async () => {
  const evictions: string[] = [];
  const store = {
    bindOriginatingWorkbench: (id: string) => Promise.resolve(id === "chan_b"),
    boundOriginatingWorkbenchId: () => null,
  };
  const registry = {
    acquire: () => Promise.resolve(store),
    get: () => store,
    peek: () => store,
  };
  const warmCache = {
    evictAll: (reason: string) => {
      evictions.push(reason);
      return Promise.resolve();
    },
  };

  const swappedA = await prepareConversationForOriginatingWorkbench({
    registry: registry as never,
    agentKey: "default",
    originatingWorkbenchId: "chan_a",
    warmCache,
  });
  expect(swappedA).toBe(false);
  expect(evictions).toEqual([]);

  const swappedB = await prepareConversationForOriginatingWorkbench({
    registry: registry as never,
    agentKey: "default",
    originatingWorkbenchId: "chan_b",
    warmCache,
  });
  expect(swappedB).toBe(true);
  expect(evictions).toHaveLength(1);
  expect(evictions[0]).toContain("chan_b");
});
