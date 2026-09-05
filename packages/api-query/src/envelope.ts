// The hub-query envelope: every page's data fetch reports exactly one of
// these four outcomes, so a page never has to invent its own notion of
// "still loading" vs. "no session" vs. "failed". `toAPIQuery` adapts any
// TanStack-Query-shaped result onto it; `QueryView` (./query-view) renders
// it. Both halves are framework-agnostic about the fetch itself — neither
// imports `@tanstack/react-query` — so a host wires its own query hook to
// this contract instead of the package assuming one.

export type APIQuery<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthenticated" }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly retry: () => void;
      /** The response status when the failure was an HTTP error (absent for
       * network failures) — lets a caller tell "404, genuinely not found"
       * apart from "500, something is actually broken" instead of
       * collapsing every failure into the same generic error state. */
      readonly status?: number;
    }
  | { readonly kind: "ready"; readonly data: T };

/** Thrown from a queryFn on HTTP 401 so a host's retry policy can stop
 * retrying and `toAPIQuery` can map the failure to `kind: "unauthenticated"`. */
export class UnauthenticatedError extends Error {
  constructor(message = "unauthenticated") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/** The one HTTP-query error shape every hub request throws: a human message
 * plus the response status when one exists (absent for network failures),
 * plus the request path for logs — never surfaced in user-facing copy —
 * plus the envelope `refId` when the hub answered through the sink. */
export class ApiQueryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string,
    readonly refId?: string,
  ) {
    super(message);
  }
}

/**
 * Human copy for a failed query, kept plain and actionable — the technical
 * detail (status codes, hub URLs, schema mismatches) stays in `console` /
 * devtools for debugging, never in the primary line a person reads.
 */
export function describeQueryError(error: unknown): string {
  if (error instanceof TypeError) {
    return "Can't reach the server. Check your connection.";
  }
  return "Something went wrong. Try again.";
}

/**
 * Human copy for a failed request, one sentence per status class, named
 * around what the caller was trying to do ("loading your benches",
 * "uploading this file"). Reads only `error.status` (any error-like value
 * carrying one, not just `ApiQueryError`) — never `error.message`, so a
 * request path, tenant id, or raw status text baked into a thrown message
 * can never reach this return value.
 */
export function describeApiError(error: unknown, doing: string): string {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  if (status === 401 || status === 403) {
    return "You don't have access to this.";
  }
  if (status === 404) {
    return "This isn't here anymore.";
  }
  return `Something went wrong ${doing}. Try again.`;
}

/**
 * Map a TanStack-Query-shaped result onto `APIQuery`. `isLoading` (pending +
 * fetching) is the loading state — bare `isPending` would flash skeletons
 * when cached data exists.
 */
export function toAPIQuery<T>(result: {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly data: T | undefined;
  readonly isPending: boolean;
  readonly fetchStatus: "fetching" | "paused" | "idle";
  readonly refetch: () => void;
}): APIQuery<T> {
  if (result.isLoading) return { kind: "loading" };
  if (result.isError) {
    if (result.error instanceof UnauthenticatedError) {
      return { kind: "unauthenticated" };
    }
    if (
      result.error instanceof ApiQueryError &&
      result.error.status !== undefined
    ) {
      return {
        kind: "error",
        message: describeQueryError(result.error),
        retry: result.refetch,
        status: result.error.status,
      };
    }
    return {
      kind: "error",
      message: describeQueryError(result.error),
      retry: result.refetch,
    };
  }
  if (result.data !== undefined) return { kind: "ready", data: result.data };
  // Disabled queries (empty path, unresolved tenant) have no data and are not
  // fetching — still report loading so callers that gate on "ready" stay quiet.
  return { kind: "loading" };
}
