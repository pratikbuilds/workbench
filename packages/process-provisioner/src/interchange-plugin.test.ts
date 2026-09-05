import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import type { EnsureSidecarRequest } from "@intx/hub-sessions";

import type { ProcessProvisionerConfig } from "./config";
import {
  createFakeSidecarProcessRunner,
  type FakeSidecarProcessRunner,
} from "./fake-process-runner";
import { createProcessSidecarProvisioner } from "./interchange-plugin";

const HUB_WS_URL = "ws://127.0.0.1:3000/api/sidecars/ws";
const SIDECAR_ENTRY = "/srv/workbench/apps/sidecar/src/index.ts";

async function configIn(dataDir: string): Promise<ProcessProvisionerConfig> {
  return {
    runtimePath: "/usr/local/bin/bun",
    sidecarEntryPath: SIDECAR_ENTRY,
    allocationsDir: resolve(dataDir, "allocations"),
    stateFilePath: resolve(dataDir, "state.json"),
    hubWebSocketUrl: HUB_WS_URL,
  };
}

async function harness(
  opts: Parameters<typeof createFakeSidecarProcessRunner>[0] = {},
): Promise<{
  provisioner: ReturnType<typeof createProcessSidecarProvisioner>;
  runner: FakeSidecarProcessRunner;
  config: ProcessProvisionerConfig;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "process-provisioner-"));
  const config = await configIn(dataDir);
  const runner = createFakeSidecarProcessRunner(opts);
  return {
    provisioner: createProcessSidecarProvisioner({ config, runner }),
    runner,
    config,
  };
}

function ensureRequest(
  overrides: Partial<EnsureSidecarRequest> = {},
): EnsureSidecarRequest {
  return {
    allocationId: "alloc-1",
    generation: 1,
    tenantId: "tenant-1",
    anchorRunId: "run-1",
    sidecarId: "sidecar-1",
    token: "token-abc",
    hubWebSocketUrl: HUB_WS_URL,
    ...overrides,
  };
}

describe("createProcessSidecarProvisioner", () => {
  test("declares the process backend identity and a fingerprint over entry point and hub URL", async () => {
    const { provisioner } = await harness();
    expect(provisioner.id).toBe("process");
    expect(provisioner.apiVersion).toBe(1);
    expect(provisioner.bindingFingerprint).toBe(
      `process:v1:${SIDECAR_ENTRY}:${HUB_WS_URL}`,
    );
  });

  test("ensure spawns the sidecar entry with the allocation's own token, data dir, and hub URL", async () => {
    const { provisioner, runner, config } = await harness();

    const result = await provisioner.ensure(ensureRequest());

    expect(result.kind).toBe("accepted");
    expect(runner.spawns).toHaveLength(1);
    const spawn = runner.spawns[0];
    expect(spawn?.command).toEqual([
      "/usr/local/bin/bun",
      "/srv/workbench/apps/sidecar/src/index.ts",
    ]);
    expect(spawn?.env["HUB_WS_URL"]).toBe(HUB_WS_URL);
    expect(spawn?.env["SIDECAR_TOKEN"]).toBe("token-abc");
    expect(spawn?.env["SIDECAR_ID"]).toBe("sidecar-1");
    expect(spawn?.env["SIDECAR_DATA_DIR"]).toBe(
      resolve(config.allocationsDir, "alloc-1", "gen-1", "data"),
    );
    expect(spawn?.env["PATH"]).toBe(process.env["PATH"]);
  });

  test("ensure records the pid so a restarted hub can still find the unit", async () => {
    const { provisioner, config } = await harness({ firstPid: 5150 });

    const result = await provisioner.ensure(ensureRequest());

    expect(result).toMatchObject({
      kind: "accepted",
      externalRef: "alloc-1:1:5150",
    });
    const pidFile = await readFile(
      resolve(config.allocationsDir, "alloc-1", "gen-1", "sidecar.pid"),
      "utf8",
    );
    expect(pidFile.trim()).toBe("5150");
  });

  test("ensure is idempotent for the same allocation and generation", async () => {
    const { provisioner, runner } = await harness();

    const first = await provisioner.ensure(ensureRequest());
    const second = await provisioner.ensure(ensureRequest());

    expect(first).toEqual(second);
    expect(runner.spawns).toHaveLength(1);
  });

  test("ensure rejects a generation older than one already observed", async () => {
    const { provisioner, runner } = await harness();

    await provisioner.ensure(ensureRequest({ generation: 3 }));
    const stale = await provisioner.ensure(ensureRequest({ generation: 2 }));

    expect(stale).toMatchObject({ kind: "rejected", code: "stale_generation" });
    expect(runner.spawns).toHaveLength(1);
  });

  test("a newer generation replaces the previous process for the allocation", async () => {
    const { provisioner, runner } = await harness({ firstPid: 700 });

    await provisioner.ensure(ensureRequest({ generation: 1 }));
    const next = await provisioner.ensure(ensureRequest({ generation: 2 }));

    expect(next).toMatchObject({
      kind: "accepted",
      externalRef: "alloc-1:2:701",
    });
    expect(runner.spawns).toHaveLength(2);
    expect(runner.signals).toEqual([{ pid: 700, signal: "SIGTERM" }]);
  });

  test("ensure rejects, without spawning, when the process cannot start", async () => {
    const { provisioner, runner } = await harness({
      spawnError: new Error("EAGAIN: out of process slots"),
    });

    const result = await provisioner.ensure(ensureRequest());

    expect(result).toMatchObject({
      kind: "rejected",
      code: "sidecar_spawn_failed",
      retryable: true,
    });
    expect(runner.spawns).toHaveLength(0);
  });

  test("destroy terminates the process and removes the allocation directory", async () => {
    const { provisioner, runner, config } = await harness({ firstPid: 900 });
    await provisioner.ensure(ensureRequest());
    const allocationDir = resolve(config.allocationsDir, "alloc-1");
    expect((await stat(allocationDir)).isDirectory()).toBe(true);

    const result = await provisioner.destroy({
      allocationId: "alloc-1",
      generation: 1,
      sidecarId: "sidecar-1",
    });

    expect(result).toEqual({ kind: "destroyed" });
    expect(runner.signals).toEqual([{ pid: 900, signal: "SIGTERM" }]);
    expect(runner.isAlive(900)).toBe(false);
    await expect(stat(allocationDir)).rejects.toThrow();
  });

  test("destroy is idempotent and fences a later ensure of the destroyed generation", async () => {
    const { provisioner, runner } = await harness();
    await provisioner.ensure(ensureRequest());
    const destroyRequest = {
      allocationId: "alloc-1",
      generation: 1,
      sidecarId: "sidecar-1",
    };

    expect(await provisioner.destroy(destroyRequest)).toEqual({
      kind: "destroyed",
    });
    expect(await provisioner.destroy(destroyRequest)).toEqual({
      kind: "destroyed",
    });
    const revived = await provisioner.ensure(ensureRequest());
    expect(revived).toMatchObject({
      kind: "rejected",
      code: "generation_destroyed",
    });
    expect(runner.spawns).toHaveLength(1);
  });

  test("an allocation id that is not a safe directory name is rejected outright", async () => {
    const { provisioner, runner } = await harness();

    const result = await provisioner.ensure(
      ensureRequest({ allocationId: "../escape" }),
    );

    expect(result).toMatchObject({
      kind: "rejected",
      code: "invalid_allocation_id",
      retryable: false,
    });
    expect(runner.spawns).toHaveLength(0);
  });
});
