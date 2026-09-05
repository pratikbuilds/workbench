// One-in-flight-turn-per-workbench claims (CL-6331) — the same
// tryClaim/release shape `./write-claims.ts` proved out for
// `chat-orchestrator.ts`'s finalized-turn writes, reused here for a
// different resource: not "has this write already happened" but "is a
// turn already running for this workbench." A claim means "won the
// right to run the next turn", not "the turn finished successfully" —
// `tryClaim` alone can't tell the difference, exactly as write-claims'
// own doc comment notes for its case.
//
// This is deliberately its own store rather than a new
// `WriteClaimSurface` on `finalizedTurnWriteClaim`: that table is a
// durable de-dup ledger scoped to redelivered *writes*, with no notion
// of "this claim has been held too long, let something else through."
// A turn claim is process-local, in-memory state (see
// `./turn-queue.ts`'s own note on why "completion" here means "the
// dispatch call this seam makes settled", not "the agent's turn
// actually finished") and needs exactly that TTL escape hatch, so it
// is its own small store built to the same interface shape rather than
// a table this repo would otherwise have to bend to fit.
export type TurnClaim = {
  readonly workbenchId: string;
};

/**
 * Proof of having won a `tryClaim` call — opaque to callers, meaningful
 * only back to the store that issued it. Required by `release` (and by
 * `turn-queue.ts`'s own `holds` check) so a claim the TTL already
 * reassigned to a second winner can never be released, or mistaken for
 * still-held, by the first winner's stale reference (CL-7129).
 */
export type TurnClaimToken = string;

export type TurnClaimStore = {
  /**
   * Atomically claims `workbenchId`: a token if this call won the claim
   * (the caller should run the next turn, and must present this token
   * to `release`/`holds`), `false` if a turn is already in flight for
   * this workbench (the caller must queue instead, never dispatch).
   */
  tryClaim(claim: TurnClaim): Promise<TurnClaimToken | false>;
  /**
   * Un-claims `workbenchId` — called once the turn that won the claim
   * has settled, success or failure alike, so the next queued batch (or
   * a fresh message) can run. Always returns `false` if `token` is not
   * the current live holder — e.g. the TTL already reassigned the claim
   * to a second winner, in which case releasing here would free a claim
   * this caller no longer owns — but may still evict the entry it
   * found: an already-expired entry carries no live claim for anyone
   * to lose, so finding one is incidental cleanup, never this call's
   * own claim to release. Never left un-called on a path that can
   * still complete; the TTL below is only the backstop for a dispatch
   * that never settles at all.
   */
  release(claim: TurnClaim, token: TurnClaimToken): Promise<boolean>;
  /**
   * Whether `token` is still the current, unexpired holder of
   * `workbenchId`'s claim — how a long-running holder notices the TTL
   * reassigned its claim to someone else without itself calling
   * `tryClaim` again (which would attempt to *take* the claim, not just
   * check it). Observing an expired entry deletes it (CL-7200).
   */
  holds(claim: TurnClaim, token: TurnClaimToken): Promise<boolean>;
};

/**
 * How long one agent turn may run before the room stops waiting on it —
 * the section body's own per-occurrence `timeout` (CL-6329, pinned into
 * a room agent's deployed definition by `./platform-adapter.ts`).
 *
 * CL-7129: this is also the floor `./workbench-service.ts`'s
 * `DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS` is built from — that wait has to
 * tolerate a prior turn legitimately running the full length this
 * constant allows. The claim TTL is no longer this same number (it
 * used to be); it now has to be strictly longer than that wait bound
 * plus the dispatch deadline, so see
 * `./workbench-service.ts`'s `DEFAULT_TURN_CLAIM_TTL_MS` for the actual
 * TTL callers should use.
 */
export const CHAT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * In-memory `TurnClaimStore`, with a TTL escape hatch: a claim older
 * than `ttlMs` is treated as available again even if `release` was
 * never called. This is the honest interim this seam can offer today —
 * `dispatchTurn` (`./workbench-service.ts`) only reaches "the mail was
 * handed to the agent's mailbox", not "the agent's turn finished", so
 * there is no outcome to observe here for the real turn hanging or the
 * process that ran it dying mid-turn. `release` still fires the moment
 * the dispatch call itself settles (the one outcome this seam *can*
 * see), and the TTL exists only to stop a workbench from wedging
 * forever behind a dispatch that never settles at all.
 */
export function createInMemoryTurnClaimStore(options: {
  readonly ttlMs: number;
  readonly now?: () => number;
}): TurnClaimStore {
  const now = options.now ?? Date.now;
  const holders = new Map<string, { token: string; claimedAt: number }>();
  let nextToken = 0;

  function isExpired(holder: { claimedAt: number }): boolean {
    return now() - holder.claimedAt >= options.ttlMs;
  }

  /**
   * The live holder of `workbenchId`, or `undefined` if nobody holds it.
   * An expired entry is deleted here so the map agrees with what
   * `tryClaim`/`holds`/`release` already conclude — rather than lingering
   * until a future `tryClaim` for this workbench happens to overwrite it
   * (CL-7200).
   */
  function liveHolder(
    workbenchId: string,
  ): { token: string; claimedAt: number } | undefined {
    const existing = holders.get(workbenchId);
    if (existing === undefined) return undefined;
    if (isExpired(existing)) {
      holders.delete(workbenchId);
      return undefined;
    }
    return existing;
  }

  return {
    async tryClaim(claim) {
      if (liveHolder(claim.workbenchId) !== undefined) {
        return false;
      }
      const token = String(++nextToken);
      holders.set(claim.workbenchId, { token, claimedAt: now() });
      return token;
    },
    async release(claim, token) {
      const existing = liveHolder(claim.workbenchId);
      if (existing === undefined || existing.token !== token) {
        return false;
      }
      holders.delete(claim.workbenchId);
      return true;
    },
    async holds(claim, token) {
      const existing = liveHolder(claim.workbenchId);
      return existing !== undefined && existing.token === token;
    },
  };
}
