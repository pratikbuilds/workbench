// Per-item bulk failures must reach reportError even when the caller
// omits onError — otherwise mark-all-read / clear-done swallow a row
// with no refId (the catch used to only bump `failed`).
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const reportErrorCalls: {
  error: unknown;
  context: Record<string, unknown>;
}[] = [];

mock.module("@corbits/error-sink", () => ({
  reportError: (error: unknown, context: Record<string, unknown>) => {
    reportErrorCalls.push({ error, context });
    return "ref_test";
  },
  generateRefId: () => "ref_test",
  makeErrorEnvelope: (args: {
    code: string;
    userMessage: string;
    refId?: string;
  }) => ({
    error: {
      code: args.code,
      message: args.userMessage,
      refId: args.refId ?? "ref_test",
    },
  }),
  parseErrorEnvelope: () => null,
}));

const { runBulkOperation } = await import("../src/bulk-run");

beforeEach(() => {
  reportErrorCalls.length = 0;
});
afterAll(() => {
  mock.restore();
});

describe("runBulkOperation reportError", () => {
  test("a thrown item is reported even when onError is omitted", async () => {
    const boom = new Error("transient write failure");
    const result = await runBulkOperation(["a", "b"], async (id) => {
      if (id === "b") throw boom;
    });

    expect(result).toEqual({ succeeded: 1, failed: 1 });
    expect(reportErrorCalls).toHaveLength(1);
    expect(reportErrorCalls[0]?.error).toBe(boom);
    expect(reportErrorCalls[0]?.context).toEqual({
      operation: "inbox.bulk",
    });
  });

  test("caller-supplied operation and tenantId ride on the report", async () => {
    const boom = new Error("row locked");
    await runBulkOperation(
      [{ id: "msg_1" }],
      async () => {
        throw boom;
      },
      {
        operation: "inbox_mark_all_read_item",
        tenantId: "tnt_1",
        extraFor: (item) => ({ id: item.id }),
      },
    );

    expect(reportErrorCalls).toHaveLength(1);
    expect(reportErrorCalls[0]?.error).toBe(boom);
    expect(reportErrorCalls[0]?.context).toEqual({
      operation: "inbox_mark_all_read_item",
      tenantId: "tnt_1",
      extra: { id: "msg_1" },
    });
  });
});
