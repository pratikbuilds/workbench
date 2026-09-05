import { isAbsolute, resolve } from "node:path";

import { type } from "arktype";

// The sidecar entry this provisioner spawns, relative to this package's
// own directory: the same `apps/sidecar/src/index.ts` that `bun run dev`
// starts. Resolved from `import.meta.dir` rather than the process cwd so
// the hub can be launched from anywhere on the host.
const DEFAULT_SIDECAR_ENTRY = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "apps",
  "sidecar",
  "src",
  "index.ts",
);

const Environment = type({
  "PROCESS_PROVISIONER_SIDECAR_ENTRY?": "string > 0",
  "PROCESS_PROVISIONER_RUNTIME?": "string > 0",
});

export type ProcessProvisionerConfig = {
  /** The executable that runs the sidecar entry — `bun` by default. */
  readonly runtimePath: string;
  /** Absolute path to the sidecar entry point this backend spawns. */
  readonly sidecarEntryPath: string;
  /**
   * Hub-side root for per-allocation directories. Each allocation gets
   * `<allocationsDir>/<allocationId>/`, holding the pid file this backend
   * recovers units from after a hub restart plus the sidecar's own
   * `SIDECAR_DATA_DIR`. Destroying an allocation removes that directory.
   */
  readonly allocationsDir: string;
  /** Where the shared allocation state store keeps generation fences. */
  readonly stateFilePath: string;
  /** The ws(s):// URL provisioned sidecars dial back on; part of the
   * binding fingerprint, since a hub moved to a new address is a
   * different backend binding even with the same entry point. */
  readonly hubWebSocketUrl: string;
};

export type ReadProcessProvisionerConfigArgs = {
  readonly env: Record<string, string | undefined>;
  /**
   * The HUB's own state directory for this backend, derived from
   * `HUB_DATA_DIR` by the caller — never an environment variable an
   * operator could point somewhere unrelated. Matches how the docker and
   * e2b backends receive theirs.
   */
  readonly dataDir: string;
  readonly hubWebSocketUrl: string;
};

/**
 * Parse the process provisioner's configuration. Both environment keys
 * are optional: an unconfigured install spawns this repository's own
 * `apps/sidecar` entry with the running `bun`, which is what makes
 * "no provisioner configured" work on a single server with no operator
 * setup at all.
 */
export function readProcessProvisionerConfig(
  args: ReadProcessProvisionerConfigArgs,
): ProcessProvisionerConfig {
  const parsed = Environment(args.env);
  if (parsed instanceof type.errors) {
    throw new Error(
      `invalid process provisioner environment: ${parsed.summary}`,
    );
  }
  if (!isAbsolute(args.dataDir)) {
    throw new Error(
      "process provisioner data dir must be an absolute path; got " +
        JSON.stringify(args.dataDir),
    );
  }
  const sidecarEntryPath = resolve(
    parsed.PROCESS_PROVISIONER_SIDECAR_ENTRY ?? DEFAULT_SIDECAR_ENTRY,
  );
  return {
    runtimePath: parsed.PROCESS_PROVISIONER_RUNTIME ?? process.execPath,
    sidecarEntryPath,
    allocationsDir: resolve(args.dataDir, "allocations"),
    stateFilePath: resolve(args.dataDir, "state.json"),
    hubWebSocketUrl: args.hubWebSocketUrl,
  };
}
