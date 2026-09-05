import { expect, test } from "bun:test";

import type { Principal, RepoId, RepoStore } from "@intx/hub-sessions";

import {
  createDeploymentAddressRegistry,
  createWorkflowRunPackPushingRepoStore,
  type WorkflowRunPackClient,
} from "./workflow-run-pack-client";

const REF = "refs/heads/main";
const DEPLOYMENT_ID = "dep-reclaim";
const AGENT_ADDRESS = "run_reclaim@bench.localhost";
const REPO_ID: RepoId = { kind: "workflow-run", id: DEPLOYMENT_ID };
const PRINCIPAL: Principal = { kind: "hub" };

function stubRepoStore(): RepoStore {
  const result = { commitSha: "sha", newlyTerminalRuns: [] };
  const unused = async () => result;
  return {
    initRepo: async () => undefined,
    writeTree: unused,
    writeTreePreservingPrefix: unused,
    writeTreeDelta: unused,
    receivePack: async () => ({ newlyTerminalRuns: [] }),
    createPack: async () => ({ pack: new Uint8Array(), commitSha: "sha" }),
    commitPackedTip: () => undefined,
    resolveRef: async () => "sha",
    listRefs: async () => [],
    resolveHead: async () => "sha",
    getRepoDir: () => "/tmp",
    subscribe: () => () => undefined,
    openCommittedReads: unused,
    openCommittedReadsAtCommit: unused,
  } as unknown as RepoStore;
}

const deltaArgs = {
  computeDelta: async () => ({ puts: {}, deletes: [] as const }),
  changedPathPrefixes: undefined,
  message: "test",
};

test("unregister reclaim drops the push slot so flush does not wait on an in-flight push", async () => {
  let pushCalls = 0;
  let releaseFirst!: () => void;
  const firstPush = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const packClient: WorkflowRunPackClient = {
    async push() {
      pushCalls += 1;
      if (pushCalls === 1) await firstPush;
    },
    markRestored() {},
  };
  const registry = createDeploymentAddressRegistry();
  registry.record(DEPLOYMENT_ID, AGENT_ADDRESS);
  const store = createWorkflowRunPackPushingRepoStore({
    underlying: stubRepoStore(),
    packClient,
    registry,
  });

  await store.writeTreeDelta(PRINCIPAL, REPO_ID, REF, deltaArgs);
  expect(pushCalls).toBe(1);

  store.markAddressUnroutable(AGENT_ADDRESS);
  store.reclaimPushState({
    deploymentId: DEPLOYMENT_ID,
    agentAddress: AGENT_ADDRESS,
  });

  await Promise.race([
    store.flushWorkflowRunPushes(REPO_ID, REF),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("flush hung on a residual slot")), 50);
    }),
  ]);

  registry.record(DEPLOYMENT_ID, AGENT_ADDRESS);
  await store.writeTreeDelta(PRINCIPAL, REPO_ID, REF, deltaArgs);
  expect(pushCalls).toBe(2);

  releaseFirst();
});
