import type {
  SidecarProcessRunner,
  SpawnSidecarProcessArgs,
} from "./process-runner";

export type FakeSidecarProcessRunner = SidecarProcessRunner & {
  readonly spawns: SpawnSidecarProcessArgs[];
  readonly signals: { readonly pid: number; readonly signal: string }[];
  /** Marks a pid dead without a signal, standing in for a crashed child. */
  kill(pid: number): void;
};

export type CreateFakeSidecarProcessRunnerOpts = {
  readonly firstPid?: number;
  /** Throws from `spawn` instead of starting a process. */
  readonly spawnError?: Error;
  /** Throws from `signal` instead of delivering it. */
  readonly signalError?: Error;
};

export function createFakeSidecarProcessRunner(
  opts: CreateFakeSidecarProcessRunnerOpts = {},
): FakeSidecarProcessRunner {
  const spawns: SpawnSidecarProcessArgs[] = [];
  const signals: { pid: number; signal: string }[] = [];
  const alive = new Set<number>();
  let nextPid = opts.firstPid ?? 4001;

  return {
    spawns,
    signals,

    spawn(args) {
      if (opts.spawnError !== undefined) throw opts.spawnError;
      spawns.push(args);
      const pid = nextPid;
      nextPid += 1;
      alive.add(pid);
      return pid;
    },

    isAlive(pid) {
      return alive.has(pid);
    },

    signal(pid, signal) {
      if (opts.signalError !== undefined) throw opts.signalError;
      signals.push({ pid, signal });
      if (signal === "SIGTERM" || signal === "SIGKILL") alive.delete(pid);
    },

    kill(pid) {
      alive.delete(pid);
    },
  };
}
