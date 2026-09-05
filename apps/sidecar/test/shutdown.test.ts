import { expect, test } from "bun:test";
import {
  attachShutdownRejectionHandler,
  drainWithTimeout,
  runSidecarShutdown,
} from "../src/shutdown";

function capturingLog() {
  const errors: string[] = [];
  return {
    errors,
    info(_strings: TemplateStringsArray, ..._values: unknown[]): void {},
    error(strings: TemplateStringsArray, ...values: unknown[]): void {
      errors.push(String.raw({ raw: strings }, ...values));
    },
  };
}

test("resolves drained when the drain completes inside the bound", async () => {
  const outcome = await drainWithTimeout(() => Promise.resolve(), 1_000);
  expect(outcome).toEqual({ kind: "drained" });
});

test("resolves timed-out when the drain outlives the bound", async () => {
  const outcome = await drainWithTimeout(
    () => new Promise<void>(() => undefined),
    10,
  );
  expect(outcome).toEqual({ kind: "timed-out" });
});

test("resolves failed with the thrown error when the drain throws", async () => {
  const error = new Error("drain fault");
  const outcome = await drainWithTimeout(() => Promise.reject(error), 1_000);
  expect(outcome).toEqual({ kind: "failed", error });
});

test("a throw from close exits 1 and does not reject", async () => {
  const exits: number[] = [];
  const log = capturingLog();
  let drained = false;
  const promise = runSidecarShutdown({
    signal: "SIGTERM",
    close: () => {
      throw new Error("close failed");
    },
    drain: async () => {
      drained = true;
    },
    drainTimeoutMs: 1_000,
    exit: (code) => {
      exits.push(code);
    },
    log,
  });
  await expect(promise).resolves.toBeUndefined();
  expect(exits).toEqual([1]);
  expect(drained).toBe(false);
  expect(log.errors.some((line) => line.includes("close failed"))).toBe(true);
});

test("a drain failure reports through reportError and exits 1 without rejecting", async () => {
  const exits: number[] = [];
  const error = new Error("drain fault");
  const reported: unknown[] = [];
  const contexts: unknown[] = [];
  const promise = runSidecarShutdown({
    signal: "SIGINT",
    close: () => undefined,
    drain: async () => {
      throw error;
    },
    drainTimeoutMs: 1_000,
    exit: (code) => {
      exits.push(code);
    },
    log: capturingLog(),
    report: (reportedError, context) => {
      reported.push(reportedError);
      contexts.push(context);
      return "ref-test";
    },
  });
  await expect(promise).resolves.toBeUndefined();
  expect(exits).toEqual([1]);
  expect(reported).toEqual([error]);
  expect(contexts[0]).toMatchObject({
    operation: "sidecar.shutdown",
  });
});

test("a clean drain exits 0", async () => {
  const exits: number[] = [];
  const promise = runSidecarShutdown({
    signal: "SIGTERM",
    close: () => undefined,
    drain: async () => undefined,
    drainTimeoutMs: 1_000,
    exit: (code) => {
      exits.push(code);
    },
    log: capturingLog(),
  });
  await expect(promise).resolves.toBeUndefined();
  expect(exits).toEqual([0]);
});

test("a rejected shutdown promise is caught by the signal handler binding", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const reported: unknown[] = [];
  try {
    attachShutdownRejectionHandler(
      Promise.reject(new Error("escaped")),
      (error) => {
        reported.push(error);
      },
    );
    await Bun.sleep(20);
    expect(reported).toHaveLength(1);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
