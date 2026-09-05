export type SpawnSidecarProcessArgs = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
};

/**
 * The narrow OS port this backend needs: start a detached child, ask
 * whether a pid is still alive, and signal it. Injected so the unit
 * suite exercises the full ensure/destroy lifecycle — including
 * generation fencing and directory cleanup — without starting a real
 * sidecar.
 */
export interface SidecarProcessRunner {
  spawn(args: SpawnSidecarProcessArgs): number;
  isAlive(pid: number): boolean;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

/**
 * Bun implementation. The child is spawned with its own stdio inherited
 * from the hub so a local operator sees sidecar logs in the same
 * terminal, and `unref`ed so a hub shutdown is not blocked waiting on
 * it — a still-running sidecar is reconciled (or destroyed) on the next
 * boot from its pid file.
 */
export function createBunSidecarProcessRunner(): SidecarProcessRunner {
  return {
    spawn(args) {
      const child = Bun.spawn([...args.command], {
        cwd: args.cwd,
        env: args.env,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      child.unref();
      return child.pid;
    },

    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // A signal-0 probe answers the liveness question through its
        // errno: ESRCH means no such process, EPERM means the process
        // exists but belongs to another user. Anything else is a real
        // failure and must not be read as "dead".
        if (isErrnoCode(error, "ESRCH")) return false;
        if (isErrnoCode(error, "EPERM")) return true;
        throw error;
      }
    },

    signal(pid, signal) {
      process.kill(pid, signal);
    },
  };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
