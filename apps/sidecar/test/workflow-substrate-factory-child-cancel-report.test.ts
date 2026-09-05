// Force handle.cancel to reject during parent abort and prove the
// fire-and-forget call reports through reportError instead of becoming
// an unhandled rejection. Injected via SidecarRunChildDeps test seams
// rather than bun's `mock.module`, whose process-wide registry swap
// cannot be undone for later files in the same `bun test` process.

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineAgent } from "@intx/agent";
import { generateKeyPair } from "@intx/crypto";
import {
  createRepoStore,
  workflowRunKindHandler,
  WORKFLOW_RUN_GITIGNORE_PATH,
} from "@intx/hub-sessions";
import type { AuthorizeFn } from "@intx/hub-sessions";
import type {
  RepoId,
  WorkflowRunWorkflowProcessPrincipal,
} from "@intx/hub-sessions/substrate";
import type { KeyPair } from "@intx/types/runtime";
import {
  createInMemoryRepoStore,
  createInMemoryScheduler,
  defineWorkflow,
  step,
} from "@intx/workflow";
import {
  createWorkflowHostSignalChannel,
  type RunChildWorkflow,
} from "@intx/workflow-host";

import {
  createSidecarRunChild,
  createSidecarSpawnSuspendableChild,
} from "../src/workflow-substrate-factory/child-runtime";

const REF = "refs/heads/main";
const DEPLOYMENT_ID = "deployment-cancel-report";
const WORKFLOW_RUN_REPO_ID: RepoId = {
  kind: "workflow-run",
  id: DEPLOYMENT_ID,
};
const allowAll: AuthorizeFn = () => ({ allowed: true });
const PRINCIPAL: WorkflowRunWorkflowProcessPrincipal = {
  kind: "workflow-process",
  anchorRunId: DEPLOYMENT_ID,
};

const tempDirs: string[] = [];
let signingKey: KeyPair;

beforeAll(async () => {
  signingKey = await generateKeyPair();
});

afterAll(async () => {
  for (const d of tempDirs.splice(0)) {
    await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {
      /* best effort */
    });
  }
});

test("a cancel rejection during abort is reported and is not unhandled", async () => {
  const forced = new Error("forced cancel reject");
  const cancelMock = mock(() => Promise.reject(forced));
  const reportErrorMock = mock(
    (_error: unknown, _context: unknown) => "ref-test",
  );

  const dataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "run-child-cancel-report-"),
  );
  tempDirs.push(dataDir);
  const substrate = createRepoStore({
    dataDir,
    signingKey,
    handlers: { "workflow-run": workflowRunKindHandler },
    authorize: allowAll,
  });
  await substrate.writeTree({ kind: "hub" }, WORKFLOW_RUN_REPO_ID, REF, {
    files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" },
    message: "genesis",
  });

  const runChild: RunChildWorkflow = createSidecarRunChild({
    substrate,
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    workflowRunRef: REF,
    principal: PRINCIPAL,
    scheduler: createInMemoryScheduler({
      repoStore: createInMemoryRepoStore(),
      clock: () => new Date(),
    }),
    invokeStep: async () => ({ output: { done: true } }),
    runtimeRun: () => ({
      runId: "run-child-forced-cancel",
      complete: new Promise(() => undefined),
      cancel: cancelMock,
      signal: async () => undefined,
    }),
    reportError: reportErrorMock,
  });

  const agent = defineAgent({
    id: "child-step",
    systemPrompt: "s",
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: "anthropic", model: "m" }] },
  });
  const definition = defineWorkflow({
    id: "child-wf-cancel-report",
    trigger: { type: "manual" },
    steps: { s: step({ agent }) },
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const abort = new AbortController();
    abort.abort();
    void runChild({
      definition,
      definitionRef: REF,
      childRunId: "run-child-cancel-report",
      input: { text: "event" },
      parentRunId: "run-parent",
      parentStepId: "section",
      signal: abort.signal,
    });
    await Bun.sleep(50);
    expect(cancelMock).toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]?.[0]).toBe(forced);
    expect(reportErrorMock.mock.calls[0]?.[1]).toMatchObject({
      operation: "sidecar.child-runtime.cancel",
    });
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a signalChannel.stop rejection is reported and is not unhandled", async () => {
  const forced = new Error("forced stop reject");
  const stopMock = mock(() => Promise.reject(forced));
  const reportErrorMock = mock(
    (_error: unknown, _context: unknown) => "ref-test",
  );

  const dataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "run-child-stop-report-"),
  );
  tempDirs.push(dataDir);
  const substrate = createRepoStore({
    dataDir,
    signingKey,
    handlers: { "workflow-run": workflowRunKindHandler },
    authorize: allowAll,
  });
  await substrate.writeTree({ kind: "hub" }, WORKFLOW_RUN_REPO_ID, REF, {
    files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" },
    message: "genesis",
  });

  const spawn = createSidecarSpawnSuspendableChild({
    substrate,
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    workflowRunRef: REF,
    principal: PRINCIPAL,
    scheduler: createInMemoryScheduler({
      repoStore: createInMemoryRepoStore(),
      clock: () => new Date(),
    }),
    invokeStep: async () => ({ output: { done: true } }),
    runtimeRun: () => ({
      runId: "run-child-forced-stop",
      complete: Promise.resolve({
        runId: "run-child-forced-stop",
        terminalStatus: "completed" as const,
        outputs: {},
        events: [],
      }),
      cancel: async () => undefined,
      signal: async () => undefined,
    }),
    reportError: reportErrorMock,
    createSignalChannel: (opts) => {
      const channel = createWorkflowHostSignalChannel(opts);
      return { ...channel, stop: stopMock };
    },
  });

  const agent = defineAgent({
    id: "child-step",
    systemPrompt: "s",
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: "anthropic", model: "m" }] },
  });
  const definition = defineWorkflow({
    id: "child-wf-stop-report",
    trigger: { type: "manual" },
    steps: { s: step({ agent }) },
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await spawn(
      {
        definition,
        definitionRef: REF,
        childRunId: "run-child-stop-report",
        input: { text: "event" },
        parentRunId: "run-parent",
        parentStepId: "section",
        signal: new AbortController().signal,
      },
      () => undefined,
    );
    await Bun.sleep(50);
    expect(stopMock).toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]?.[0]).toBe(forced);
    expect(reportErrorMock.mock.calls[0]?.[1]).toMatchObject({
      operation: "sidecar.child-runtime.signal-channel-stop",
    });
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a spawn-suspendable abort cancel rejection is reported and is not unhandled", async () => {
  const forced = new Error("forced suspendable cancel reject");
  const cancelMock = mock(() => Promise.reject(forced));
  const reportErrorMock = mock(
    (_error: unknown, _context: unknown) => "ref-test",
  );

  const dataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "run-suspendable-cancel-report-"),
  );
  tempDirs.push(dataDir);
  const substrate = createRepoStore({
    dataDir,
    signingKey,
    handlers: { "workflow-run": workflowRunKindHandler },
    authorize: allowAll,
  });
  await substrate.writeTree({ kind: "hub" }, WORKFLOW_RUN_REPO_ID, REF, {
    files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "" },
    message: "genesis",
  });

  const spawn = createSidecarSpawnSuspendableChild({
    substrate,
    workflowRunRepoId: WORKFLOW_RUN_REPO_ID,
    workflowRunRef: REF,
    principal: PRINCIPAL,
    scheduler: createInMemoryScheduler({
      repoStore: createInMemoryRepoStore(),
      clock: () => new Date(),
    }),
    invokeStep: async () => ({ output: { done: true } }),
    runtimeRun: () => ({
      runId: "run-suspendable-forced-cancel",
      complete: new Promise(() => undefined),
      cancel: cancelMock,
      signal: async () => undefined,
    }),
    reportError: reportErrorMock,
  });

  const agent = defineAgent({
    id: "child-step",
    systemPrompt: "s",
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: "anthropic", model: "m" }] },
  });
  const definition = defineWorkflow({
    id: "child-wf-suspendable-cancel-report",
    trigger: { type: "manual" },
    steps: { s: step({ agent }) },
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const abort = new AbortController();
    abort.abort();
    await spawn(
      {
        definition,
        definitionRef: REF,
        childRunId: "run-suspendable-cancel-report",
        input: { text: "event" },
        parentRunId: "run-parent",
        parentStepId: "section",
        signal: abort.signal,
      },
      () => undefined,
    );
    await Bun.sleep(50);
    expect(cancelMock).toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock.mock.calls[0]?.[0]).toBe(forced);
    expect(reportErrorMock.mock.calls[0]?.[1]).toMatchObject({
      operation: "sidecar.child-runtime.cancel",
    });
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
