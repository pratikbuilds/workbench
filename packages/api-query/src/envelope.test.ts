import { describe, expect, mock, test } from "bun:test";

import {
  ApiQueryError,
  describeApiError,
  describeQueryError,
  toAPIQuery,
  UnauthenticatedError,
} from "./envelope";

describe("ApiQueryError", () => {
  test("carries an optional status", () => {
    const withStatus = new ApiQueryError("boom", 409);
    expect(withStatus.message).toBe("boom");
    expect(withStatus.status).toBe(409);

    const withoutStatus = new ApiQueryError("network down");
    expect(withoutStatus.status).toBeUndefined();
  });

  test("carries an optional refId from a hub error envelope", () => {
    const withRef = new ApiQueryError("boom", 500, "/api/x", "ref_sink_1");
    expect(withRef.refId).toBe("ref_sink_1");

    const withoutRef = new ApiQueryError("boom", 500, "/api/x");
    expect(withoutRef.refId).toBeUndefined();
  });
});

describe("UnauthenticatedError", () => {
  test("defaults to a stable name and message", () => {
    const error = new UnauthenticatedError();
    expect(error.name).toBe("UnauthenticatedError");
    expect(error.message).toBe("unauthenticated");
  });
});

describe("describeQueryError", () => {
  test("maps a network failure (TypeError) to connectivity copy", () => {
    expect(describeQueryError(new TypeError("Failed to fetch"))).toBe(
      "Can't reach the server. Check your connection.",
    );
  });

  test("maps everything else to generic retry copy", () => {
    expect(describeQueryError(new Error("boom"))).toBe(
      "Something went wrong. Try again.",
    );
    expect(describeQueryError(new ApiQueryError("boom", 500))).toBe(
      "Something went wrong. Try again.",
    );
  });
});

describe("describeApiError", () => {
  const pathBearing = new ApiQueryError(
    "The server answered 404 for /api/tenants/9f2c-real-tenant/artifacts/42.",
    404,
  );

  test("never echoes a path, tenant id, or status from the error message", () => {
    const message = describeApiError(pathBearing, "loading this");
    expect(message).not.toMatch(/\/api\//);
    expect(message).not.toContain("9f2c-real-tenant");
    expect(message).not.toContain("404");
  });

  test("401 and 403 read as an access problem", () => {
    expect(
      describeApiError(new ApiQueryError("boom", 401), "loading this"),
    ).toBe("You don't have access to this.");
    expect(
      describeApiError(new ApiQueryError("boom", 403), "loading this"),
    ).toBe("You don't have access to this.");
  });

  test("404 reads as gone, not as a generic failure", () => {
    expect(describeApiError(pathBearing, "loading this")).toBe(
      "This isn't here anymore.",
    );
  });

  test("5xx and network failures share the same actionable copy, named around the task", () => {
    expect(
      describeApiError(new ApiQueryError("boom", 500), "uploading this file"),
    ).toBe("Something went wrong uploading this file. Try again.");
    expect(
      describeApiError(new TypeError("Failed to fetch"), "starting that task"),
    ).toBe("Something went wrong starting that task. Try again.");
  });

  test("an error with no status falls back to the same generic copy", () => {
    expect(describeApiError(new Error("boom"), "saving this")).toBe(
      "Something went wrong saving this. Try again.",
    );
  });
});

describe("toAPIQuery", () => {
  test("loading while fetch is in flight with no data", () => {
    expect(
      toAPIQuery({
        isLoading: true,
        isError: false,
        error: null,
        data: undefined,
        isPending: true,
        fetchStatus: "fetching",
        refetch: mock(() => undefined),
      }),
    ).toEqual({ kind: "loading" });
  });

  test("maps UnauthenticatedError to unauthenticated", () => {
    expect(
      toAPIQuery({
        isLoading: false,
        isError: true,
        error: new UnauthenticatedError(),
        data: undefined,
        isPending: false,
        fetchStatus: "idle",
        refetch: mock(() => undefined),
      }),
    ).toEqual({ kind: "unauthenticated" });
  });

  test("maps unknown errors to plain, actionable copy — never the raw message", () => {
    const result = toAPIQuery({
      isLoading: false,
      isError: true,
      error: new Error("boom"),
      data: undefined,
      isPending: false,
      fetchStatus: "idle",
      refetch: mock(() => undefined),
    });
    expect(result).toEqual({
      kind: "error",
      message: "Something went wrong. Try again.",
      retry: expect.any(Function),
    });
  });

  test("maps a network failure (TypeError) to connectivity copy", () => {
    const result = toAPIQuery({
      isLoading: false,
      isError: true,
      error: new TypeError("Failed to fetch"),
      data: undefined,
      isPending: false,
      fetchStatus: "idle",
      refetch: mock(() => undefined),
    });
    expect(result).toEqual({
      kind: "error",
      message: "Can't reach the server. Check your connection.",
      retry: expect.any(Function),
    });
  });

  test("threads an ApiQueryError's status onto the error kind", () => {
    const result = toAPIQuery({
      isLoading: false,
      isError: true,
      error: new ApiQueryError("not found", 404),
      data: undefined,
      isPending: false,
      fetchStatus: "idle",
      refetch: mock(() => undefined),
    });
    expect(result).toEqual({
      kind: "error",
      message: "Something went wrong. Try again.",
      retry: expect.any(Function),
      status: 404,
    });
  });

  test("error's retry calls the query's own refetch", () => {
    const refetch = mock(() => undefined);
    const result = toAPIQuery({
      isLoading: false,
      isError: true,
      error: new Error("boom"),
      data: undefined,
      isPending: false,
      fetchStatus: "idle",
      refetch,
    });
    if (result.kind !== "error") throw new Error("expected error kind");
    result.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test("ready when data is present", () => {
    expect(
      toAPIQuery({
        isLoading: false,
        isError: false,
        error: null,
        data: { ok: true },
        isPending: false,
        fetchStatus: "idle",
        refetch: mock(() => undefined),
      }),
    ).toEqual({ kind: "ready", data: { ok: true } });
  });

  test("disabled / idle with no data still reports loading", () => {
    expect(
      toAPIQuery({
        isLoading: false,
        isError: false,
        error: null,
        data: undefined,
        isPending: true,
        fetchStatus: "idle",
        refetch: mock(() => undefined),
      }),
    ).toEqual({ kind: "loading" });
  });
});
