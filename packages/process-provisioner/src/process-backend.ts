import {
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { reportError } from "@corbits/error-sink";
import {
  BackendOperationError,
  type SidecarBackend,
  type StartUnitArgs,
} from "@corbits/sandbox-sidecar";

import type { ProcessProvisionerConfig } from "./config";
import type { SidecarProcessRunner } from "./process-runner";

const PID_FILE_NAME = "sidecar.pid";
const SIDECAR_DATA_DIR_NAME = "data";
const UNIT_DIR_PREFIX = "gen-";
// An allocation id names a directory on the hub host, so it may only be
// the id-shaped text Interchange actually issues — never a traversal.
const ALLOCATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_MS = 100;

/**
 * Implements `@corbits/sandbox-sidecar`'s `SidecarBackend` port by running
 * one `apps/sidecar` process per allocation on the hub host itself. This
 * is the backend an install with no `SIDECAR_PROVISIONERS` configured
 * gets, so one server hosts many chats and workflows with no container
 * runtime and no remote sandbox account.
 *
 * Layout under the hub's data dir, one directory per started unit:
 *
 *     <allocationsDir>/<allocationId>/gen-<generation>/sidecar.pid
 *     <allocationsDir>/<allocationId>/gen-<generation>/data/
 *
 * `data/` is that sidecar's own `SIDECAR_DATA_DIR`. The pid file is what
 * makes this backend survive a hub restart: the child handle is gone, but
 * `findUnitsByAllocation` still finds every live unit from disk, so the
 * core can sweep a superseded generation and destroy can still clean up
 * after a unit this process never started. Scoping a unit by generation
 * (rather than one pid file per allocation) is what keeps that sweep
 * honest — a new generation's pid never overwrites the record of the one
 * it is replacing.
 */
export function createProcessBackend(
  runner: SidecarProcessRunner,
  config: ProcessProvisionerConfig,
): SidecarBackend {
  function allocationDirOf(allocationId: string): string {
    if (!ALLOCATION_ID_PATTERN.test(allocationId)) {
      throw new BackendOperationError(
        "invalid_allocation_id",
        `allocationId ${JSON.stringify(allocationId)} is not a valid directory name`,
        false,
      );
    }
    return resolve(config.allocationsDir, allocationId);
  }

  function unitDirOf(allocationId: string, generation: number): string {
    return resolve(
      allocationDirOf(allocationId),
      `${UNIT_DIR_PREFIX}${String(generation)}`,
    );
  }

  return {
    async startUnit(args: StartUnitArgs): Promise<string> {
      const unitDir = unitDirOf(args.allocationId, args.generation);
      const sidecarDataDir = resolve(unitDir, SIDECAR_DATA_DIR_NAME);
      const env = sidecarEnvFor(args, sidecarDataDir);
      try {
        await mkdir(sidecarDataDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        throw operationalFailure(
          error,
          "allocation_dir_failed",
          `unable to create unit directory ${unitDir}`,
          args.allocationId,
        );
      }

      let pid: number;
      try {
        pid = runner.spawn({
          command: [config.runtimePath, config.sidecarEntryPath],
          cwd: dirname(config.sidecarEntryPath),
          env,
        });
      } catch (error) {
        throw operationalFailure(
          error,
          "sidecar_spawn_failed",
          `unable to spawn ${config.sidecarEntryPath}`,
          args.allocationId,
        );
      }

      try {
        await writeFile(resolve(unitDir, PID_FILE_NAME), `${String(pid)}\n`, {
          mode: 0o600,
        });
      } catch (error) {
        await terminate(runner, pid);
        throw operationalFailure(
          error,
          "pid_file_write_failed",
          `unable to record pid ${String(pid)} for allocation ${args.allocationId}`,
          args.allocationId,
        );
      }
      return externalRefOf(args.allocationId, args.generation, pid);
    },

    async stopUnit(externalRef: string): Promise<void> {
      const unit = parseExternalRef(externalRef);
      if (unit === null) {
        throw new BackendOperationError(
          "invalid_external_ref",
          `external ref ${JSON.stringify(externalRef)} is not <allocationId>:<generation>:<pid>`,
          false,
        );
      }
      try {
        await terminate(runner, unit.pid);
      } catch (error) {
        throw operationalFailure(
          error,
          "sidecar_terminate_failed",
          `unable to terminate pid ${String(unit.pid)}`,
          unit.allocationId,
        );
      }
      const unitDir = unitDirOf(unit.allocationId, unit.generation);
      try {
        await rm(unitDir, { recursive: true, force: true });
        // The allocation's own directory goes once its last unit does;
        // a still-running newer generation keeps it, which is why this
        // is an rmdir and not a recursive remove.
        await rmdir(allocationDirOf(unit.allocationId)).catch(
          ignoreNonEmptyOrMissing,
        );
      } catch (error) {
        throw operationalFailure(
          error,
          "allocation_dir_cleanup_failed",
          `unable to remove unit directory ${unitDir}`,
          unit.allocationId,
        );
      }
    },

    async findUnitsByAllocation(
      allocationId: string,
    ): Promise<readonly string[]> {
      const allocationDir = allocationDirOf(allocationId);
      let entries: string[];
      try {
        entries = await readdir(allocationDir);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return [];
        throw operationalFailure(
          error,
          "allocation_dir_read_failed",
          `unable to list units under ${allocationDir}`,
          allocationId,
        );
      }

      const refs: string[] = [];
      for (const entry of entries) {
        const generation = generationOf(entry);
        if (generation === null) continue;
        const pid = await readPidFile(
          resolve(allocationDir, entry),
          allocationId,
        );
        if (pid === null || !runner.isAlive(pid)) continue;
        refs.push(externalRefOf(allocationId, generation, pid));
      }
      return refs;
    },
  };
}

/**
 * The sidecar's own boot config (`apps/sidecar/src/config.ts`) requires
 * `SIDECAR_DATA_DIR`, `HUB_WS_URL`, `SIDECAR_ID`, `SIDECAR_TOKEN` and
 * `PATH`, and forwards `HOME`/`TMPDIR` into each workflow-process child.
 * Nothing else of the hub's environment is inherited: a sidecar learns
 * everything else over the wire.
 */
function sidecarEnvFor(
  args: StartUnitArgs,
  sidecarDataDir: string,
): Record<string, string> {
  const path = process.env["PATH"];
  if (path === undefined || path === "") {
    const error = new Error(
      "the hub process has no PATH to forward; a spawned sidecar cannot resolve its runtime",
    );
    reportError(error, {
      operation: "process-provisioner.missing_path",
      extra: { allocationId: args.allocationId },
    });
    throw new BackendOperationError("missing_path", error.message, false);
  }
  const home = process.env["HOME"];
  const tmpdir = process.env["TMPDIR"];
  return {
    SIDECAR_DATA_DIR: sidecarDataDir,
    HUB_WS_URL: args.hubWebSocketUrl,
    SIDECAR_ID: args.sidecarId,
    SIDECAR_TOKEN: args.token,
    PATH: path,
    ...(home === undefined ? {} : { HOME: home }),
    ...(tmpdir === undefined ? {} : { TMPDIR: tmpdir }),
  };
}

/**
 * Sends SIGTERM and waits out the grace period so the sidecar can flush
 * its own state, escalating to SIGKILL only if it is still alive. A pid
 * that is already gone is success — destroy has to stay idempotent.
 */
async function terminate(
  runner: SidecarProcessRunner,
  pid: number,
): Promise<void> {
  if (!runner.isAlive(pid)) return;
  runner.signal(pid, "SIGTERM");
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (runner.isAlive(pid) && Date.now() < deadline) {
    await sleep(TERMINATION_POLL_MS);
  }
  if (runner.isAlive(pid)) runner.signal(pid, "SIGKILL");
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function readPidFile(
  unitDir: string,
  allocationId: string,
): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(resolve(unitDir, PID_FILE_NAME), "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw operationalFailure(
      error,
      "pid_file_read_failed",
      `unable to read the pid file under ${unitDir}`,
      allocationId,
    );
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function externalRefOf(
  allocationId: string,
  generation: number,
  pid: number,
): string {
  return `${allocationId}:${String(generation)}:${String(pid)}`;
}

function parseExternalRef(externalRef: string): {
  allocationId: string;
  generation: number;
  pid: number;
} | null {
  const parts = externalRef.split(":");
  if (parts.length !== 3) return null;
  const [allocationId, generationText, pidText] = parts;
  if (allocationId === undefined || allocationId === "") return null;
  const generation = Number(generationText);
  const pid = Number(pidText);
  if (!Number.isInteger(generation) || generation <= 0) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { allocationId, generation, pid };
}

function generationOf(entryName: string): number | null {
  if (!entryName.startsWith(UNIT_DIR_PREFIX)) return null;
  const generation = Number(entryName.slice(UNIT_DIR_PREFIX.length));
  return Number.isInteger(generation) && generation > 0 ? generation : null;
}

function ignoreNonEmptyOrMissing(error: unknown): void {
  if (
    isErrnoCode(error, "ENOTEMPTY") ||
    isErrnoCode(error, "EEXIST") ||
    isErrnoCode(error, "ENOENT")
  ) {
    return;
  }
  throw error;
}

/**
 * Reports a caught OS failure with its allocation context and returns the
 * classified error to throw, so the shared provisioner core turns it into
 * a retryable rejection carrying a `refId` support can quote.
 */
function operationalFailure(
  error: unknown,
  code: string,
  message: string,
  allocationId: string,
): BackendOperationError {
  if (error instanceof BackendOperationError) return error;
  const refId = reportError(error, {
    operation: `process-provisioner.${code}`,
    extra: { allocationId },
  });
  const detail = error instanceof Error ? error.message : String(error);
  return new BackendOperationError(
    code,
    `${message}: ${detail} (${refId})`,
    true,
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
