// The turn projection: one row per agent turn, written by the dispatch
// seam as the turn starts and closed as it settles (CL-6329). This is
// deliberately OUR projection rather than a read of the platform's own
// run tables — the same shape gtm's event collector settled on — because
// traceability is a product concern: a room needs to answer "which run
// produced this reply, and how did that turn end" from its own rows, at
// timeline speed, whether or not the execution plane is reachable.
//
// A turn's identity is the pair (warm section run, occurrence). The
// workflow runtime names an occurrence's child run `turn__<n>` and
// assigns `n` sequentially per section run; this store allocates the
// same sequence per (workbench, agent) so a row's `childRunId` is the id
// the reply message actually carries.
import {
  AGENT_RUNTIME_SECTION_ID,
  agentRuntimeTurnRunId,
} from "@corbits/agent-runtime";
import { and, desc, eq, lt, sql } from "drizzle-orm";

import { agentTurns } from "./schema";
import type { ChatDb } from "./store";
import { CHAT_TURN_TIMEOUT_MS } from "./turn-claims";

export type AgentTurnStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentTurn {
  readonly id: string;
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly agentAddress: string;
  /** The warm (agent, workbench) section run, when the dispatch reached
   * far enough to learn it; null for a turn that never got that far. */
  readonly sectionRunId: string | null;
  /** `turn__<occurrence>` — what the reply message's `run_id` carries. */
  readonly childRunId: string;
  readonly occurrence: number;
  /** The room messages this turn was asked to answer, in arrival order. */
  readonly requestMessageIds: readonly string[];
  /** The message this turn produced — a reply or a failed-turn notice. */
  readonly replyMessageId: string | null;
  readonly status: AgentTurnStatus;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface StartAgentTurnInput {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly agentAddress: string;
  readonly requestMessageIds: readonly string[];
}

export interface FinishAgentTurnInput {
  readonly tenantId: string;
  readonly turnId: string;
  readonly status: Exclude<AgentTurnStatus, "running">;
  readonly sectionRunId?: string;
  readonly replyMessageId?: string;
  readonly error?: string;
}

export interface AgentTurnStore {
  /**
   * Opens the next turn for (workbench, agent), allocating the
   * occurrence — and therefore the child run id — the section run will
   * use. Called before the execution plane is touched, so an in-flight
   * turn is on the projection from its first moment.
   */
  startTurn(input: StartAgentTurnInput): Promise<AgentTurn>;
  /**
   * Closes a turn — compare-and-set on `status === "running"` (CL-7193),
   * so two closes racing the same turn (a dispatch deadline closing it
   * `failed` the instant it fires, the turn's own late reply closing it
   * `completed` once it lands) can never clobber each other: exactly one
   * applies, and the loser reads back `undefined` rather than
   * overwriting the winner's `replyMessageId`. Also undefined for a
   * turn id this store does not hold.
   */
  finishTurn(input: FinishAgentTurnInput): Promise<AgentTurn | undefined>;
  /**
   * The newest turn still `running` for (workbench, agent), or — when
   * `childRunId` is present — that exact occurrence. The reply path stamps
   * the row it finds onto the message it posts. An old sidecar's
   * `agent.event` frames omit `childRunId`; those callers keep the
   * newest-occurrence pick, which is the one documented fallback.
   *
   * `waitUntilFree` (below) is what `dispatchTurn` (`./workbench-service.ts`)
   * calls before opening a second occurrence for the same (workbench,
   * agent) — the one-in-flight-turn-per-workbench claim (`./turn-queue.ts`)
   * is a different, coarser guarantee (it only spans the fast dispatch
   * handoff, not the agent's actual reply) and on its own was NOT enough:
   * two messages sent to the same agent a few seconds apart could each win
   * that claim in turn and open a second `running` row while the first
   * agent turn was still generating (CL-6670), making the newest pick a
   * coin flip between the two turns' real replies.
   */
  findRunningTurn(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly agentAddress: string;
    /**
     * When present, this is an exact occurrence lookup — the row whose
     * `childRunId` matches, still `running`. An old sidecar's `agent.event`
     * frames omit this (CL-6396); those callers keep the newest-occurrence
     * pick below, which is the one documented fallback, not a second path
     * that posts a late reply.
     */
    readonly childRunId?: string;
  }): Promise<AgentTurn | undefined>;
  /**
   * Every `running` turn for a workbench, across every agent — the
   * cancel endpoint's own read (CL-7201): a workbench can have more than
   * one agent turn in flight at once (`dispatchTurnBatch` fans out
   * concurrently), and settling "the" in-flight turn means settling all
   * of them. Deliberately not built on `listTurns`: that method has no
   * status filter and pages to `AGENT_TURNS_PAGE_SIZE`, so a busy
   * workbench could silently leave an older running turn off the page
   * and therefore unsettled.
   */
  findRunningTurns(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
  }): Promise<readonly AgentTurn[]>;
  /**
   * Resolves once (workbench, agent) has no `running` turn — immediately
   * if none is running right now, otherwise when the current one closes
   * via `finishTurn`, or (backstop) once it ages past `AGENT_TURN_STALE_MS`
   * and this store's own staleness sweep would fail it anyway. `dispatchTurn`
   * awaits this before opening a new occurrence for an agent, so two
   * messages to the SAME agent — one arriving mid-generation of the
   * other's reply — serialize into two turns in arrival order instead of
   * two simultaneously-`running` rows that `findRunningTurn` could only
   * guess between (CL-6670). Never blocks a DIFFERENT agent's own
   * dispatch: this is scoped to one (workbench, agent) pair, so two
   * different agents mentioned in the same message still turn
   * concurrently.
   *
   * CL-7193: an aborted `signal` makes the wait stop polling and throw
   * — never resolve as though the agent were free — so a caller whose
   * own deadline already fired never mistakes an abandoned wait for a
   * green light to dispatch.
   */
  waitUntilFree(
    input: {
      readonly tenantId: string;
      readonly workbenchId: string;
      readonly agentAddress: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  listTurns(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly limit?: number;
  }): Promise<readonly AgentTurn[]>;
  getTurn(input: {
    readonly tenantId: string;
    readonly turnId: string;
  }): Promise<AgentTurn | undefined>;
}

/** Newest-first page size a turns listing serves. */
export const AGENT_TURNS_PAGE_SIZE = 50;

/**
 * When a `running` row stops being believable (CL-6451). An occurrence
 * cannot legitimately outlive the per-turn timeout the section body
 * enforces (`CHAT_TURN_TIMEOUT_MS`, see `./turn-claims.ts`) — a row
 * still running past it plus a settle grace means the dispatch was
 * interrupted (the supervisor's terminal-or-park backstop failed it, or
 * the process died mid-turn) and the closing event is never coming.
 * Both stores fail such rows on their next read or write instead of
 * showing a turn — and its typing indicator — as running forever.
 */
export const AGENT_TURN_STALE_MS = CHAT_TURN_TIMEOUT_MS + 60_000;

const STALE_TURN_ERROR =
  "The turn was interrupted and never finished — its dispatch reported nothing back.";

export type AgentTurnStoreOptions = {
  /** Injectable clock, for tests that age turns without waiting. */
  readonly now?: () => number;
};

function newTurnId(): string {
  return `turn_${crypto.randomUUID().replace(/-/g, "")}`;
}

function sectionKey(input: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly agentAddress: string;
}): string {
  return `${input.tenantId} ${input.workbenchId} ${input.agentAddress}`;
}

/**
 * Newest-first order shared by `listTurns` and `findRunningTurn`
 * (CL-7200): `startedAt` descending, then `occurrence` descending as
 * the deterministic tiebreak when two turns share a timestamp. Listing
 * used to sort by the started-at string alone and the running-turn
 * resolver by occurrence alone, so same-millisecond rows could disagree
 * on which turn was newest.
 */
function compareTurnsNewestFirst(left: AgentTurn, right: AgentTurn): number {
  const byStarted = right.startedAt.localeCompare(left.startedAt);
  return byStarted !== 0 ? byStarted : right.occurrence - left.occurrence;
}

/**
 * The process-local pubsub `waitUntilFree` is built on: a (workbench,
 * agent) key's waiters all resolve the moment `notify` fires for that
 * key, or on their own individual backstop timer, whichever comes
 * first — so a `finishTurn` that never lands (a crashed dispatch) still
 * releases every waiter once the blocking turn would have gone stale
 * anyway. Deliberately process-local, not durable: both `AgentTurnStore`
 * implementations below are already single-process-only concepts (the
 * in-memory one by construction, the Drizzle one because this hub runs
 * as a single replica — see `AGENT_TURN_STALE_MS`'s own doc comment for
 * the ceiling this backstop mirrors).
 *
 * CL-7193: each waiter used to be a bare `resolve` — `notify` deleted
 * the whole per-key Set and called every one, but never cleared their
 * individual backstop timers, and a backstop firing first (the key kept
 * timing out, `notify` never came) never removed its own entry either.
 * A key that kept timing out accumulated one abandoned waiter per
 * attempt forever. Every waiter now owns its full teardown — clearing
 * its own timer, removing itself from the Set, detaching its abort
 * listener — so whichever of {`notify`, the backstop, an aborted
 * `signal`} reaches it first is the only one that ever runs it.
 */
export function createTurnFreedSignal(): {
  notify(key: string): void;
  wait(key: string, backstopMs: number, signal?: AbortSignal): Promise<void>;
  /** Waiters still pending for `key` — diagnostic, and what proves the
   * Set never grows unboundedly across repeated timeouts. */
  waiterCount(key: string): number;
} {
  type Waiter = {
    readonly settle: () => void;
    readonly timer: ReturnType<typeof setTimeout>;
  };
  // A waiter's own settle() needs to remove that same waiter from its
  // Set -- an id minted before the waiter object exists gives it a way
  // to name itself without the object having to reference its own
  // not-yet-created binding.
  const waiters = new Map<string, Map<number, Waiter>>();
  let nextWaiterId = 0;

  function forget(key: string, id: number): void {
    const byId = waiters.get(key);
    if (byId === undefined) return;
    byId.delete(id);
    if (byId.size === 0) waiters.delete(key);
  }

  return {
    notify(key) {
      const byId = waiters.get(key);
      if (byId === undefined) return;
      for (const waiter of [...byId.values()]) waiter.settle();
    },
    wait(key, backstopMs, signal) {
      return new Promise((resolve) => {
        const byId = waiters.get(key) ?? new Map<number, Waiter>();
        waiters.set(key, byId);
        const id = nextWaiterId++;
        const settle = () => {
          clearTimeout(byId.get(id)?.timer);
          forget(key, id);
          signal?.removeEventListener("abort", settle);
          resolve();
        };
        byId.set(id, { settle, timer: setTimeout(settle, backstopMs) });
        signal?.addEventListener("abort", settle, { once: true });
      });
    },
    waiterCount(key) {
      return waiters.get(key)?.size ?? 0;
    },
  };
}

export function createInMemoryAgentTurnStore(
  options: AgentTurnStoreOptions = {},
): AgentTurnStore {
  const rows = new Map<string, AgentTurn>();
  const nextOccurrence = new Map<string, number>();
  const now = options.now ?? Date.now;
  const freed = createTurnFreedSignal();

  function expireStaleTurns(): void {
    const cutoff = now() - AGENT_TURN_STALE_MS;
    for (const [id, turn] of rows) {
      if (turn.status !== "running") continue;
      if (Date.parse(turn.startedAt) > cutoff) continue;
      rows.set(id, {
        ...turn,
        status: "failed",
        error: STALE_TURN_ERROR,
        endedAt: new Date(now()).toISOString(),
      });
      freed.notify(sectionKey(turn));
    }
  }

  function runningTurn(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly agentAddress: string;
    readonly childRunId?: string;
  }): AgentTurn | undefined {
    expireStaleTurns();
    return [...rows.values()]
      .filter(
        (turn) =>
          turn.tenantId === input.tenantId &&
          turn.workbenchId === input.workbenchId &&
          turn.agentAddress === input.agentAddress &&
          turn.status === "running" &&
          (input.childRunId === undefined ||
            turn.childRunId === input.childRunId),
      )
      .sort(compareTurnsNewestFirst)[0];
  }

  return {
    async startTurn(input) {
      expireStaleTurns();
      const key = sectionKey(input);
      const occurrence = nextOccurrence.get(key) ?? 0;
      nextOccurrence.set(key, occurrence + 1);
      const childRunId = agentRuntimeTurnRunId(occurrence);
      const turn: AgentTurn = {
        id: newTurnId(),
        tenantId: input.tenantId,
        workbenchId: input.workbenchId,
        agentAddress: input.agentAddress,
        sectionRunId: null,
        childRunId,
        occurrence,
        requestMessageIds: [...input.requestMessageIds],
        replyMessageId: null,
        status: "running",
        error: null,
        startedAt: new Date(now()).toISOString(),
        endedAt: null,
      };
      rows.set(turn.id, turn);
      return turn;
    },

    async finishTurn(input) {
      const existing = rows.get(input.turnId);
      if (existing === undefined || existing.tenantId !== input.tenantId) {
        return undefined;
      }
      // CL-7193: compare-and-set on status -- a turn already closed
      // (by a dispatch deadline's abort close, or an earlier finishTurn)
      // never gets clobbered by a second close racing in behind it.
      if (existing.status !== "running") {
        return undefined;
      }
      const finished: AgentTurn = {
        id: existing.id,
        tenantId: existing.tenantId,
        workbenchId: existing.workbenchId,
        agentAddress: existing.agentAddress,
        sectionRunId: input.sectionRunId ?? existing.sectionRunId,
        childRunId: existing.childRunId,
        occurrence: existing.occurrence,
        requestMessageIds: existing.requestMessageIds,
        replyMessageId: input.replyMessageId ?? existing.replyMessageId,
        status: input.status,
        error: input.error ?? null,
        startedAt: existing.startedAt,
        endedAt: new Date(now()).toISOString(),
      };
      rows.set(finished.id, finished);
      freed.notify(sectionKey(finished));
      return finished;
    },

    async findRunningTurn(input) {
      return runningTurn(input);
    },

    async findRunningTurns(input) {
      expireStaleTurns();
      return [...rows.values()].filter(
        (turn) =>
          turn.tenantId === input.tenantId &&
          turn.workbenchId === input.workbenchId &&
          turn.status === "running",
      );
    },

    async waitUntilFree(input, signal) {
      for (;;) {
        if (signal?.aborted) throw signal.reason;
        const running = runningTurn(input);
        if (running === undefined) return;
        const staleAt = Date.parse(running.startedAt) + AGENT_TURN_STALE_MS;
        const backstopMs = Math.max(0, staleAt - now()) + 50;
        await freed.wait(sectionKey(input), backstopMs, signal);
      }
    },

    async listTurns(input) {
      expireStaleTurns();
      return [...rows.values()]
        .filter(
          (turn) =>
            turn.tenantId === input.tenantId &&
            turn.workbenchId === input.workbenchId,
        )
        .sort(compareTurnsNewestFirst)
        .slice(0, input.limit ?? AGENT_TURNS_PAGE_SIZE);
    },

    async getTurn(input) {
      const found = rows.get(input.turnId);
      return found !== undefined && found.tenantId === input.tenantId
        ? found
        : undefined;
    },
  };
}

type AgentTurnRow = {
  id: string;
  tenantId: string;
  workbenchId: string;
  agentAddress: string;
  sectionRunId: string | null;
  childRunId: string;
  occurrence: number;
  requestMessageIds: unknown;
  replyMessageId: string | null;
  status: string;
  error: string | null;
  startedAt: Date;
  endedAt: Date | null;
};

function toAgentTurn(row: AgentTurnRow): AgentTurn {
  const requested = Array.isArray(row.requestMessageIds)
    ? row.requestMessageIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const status: AgentTurnStatus =
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "cancelled"
      ? row.status
      : "running";
  return {
    id: row.id,
    tenantId: row.tenantId,
    workbenchId: row.workbenchId,
    agentAddress: row.agentAddress,
    sectionRunId: row.sectionRunId,
    childRunId: row.childRunId,
    occurrence: row.occurrence,
    requestMessageIds: requested,
    replyMessageId: row.replyMessageId,
    status,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
  };
}

/**
 * The Postgres-backed projection. Occurrence allocation happens inside
 * the insert (`max(occurrence) + 1` over the section's own rows) with a
 * unique constraint behind it, so two dispatches racing for one agent
 * cannot both claim the same child run id — one of them fails loudly
 * rather than two turns quietly sharing a run id.
 */
export function createDrizzleAgentTurnStore<
  TSchema extends Record<string, unknown>,
>(db: ChatDb<TSchema>, options: AgentTurnStoreOptions = {}): AgentTurnStore {
  const now = options.now ?? Date.now;
  const freed = createTurnFreedSignal();

  async function expireStaleTurns(scope: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly agentAddress?: string;
  }): Promise<void> {
    const cutoff = new Date(now() - AGENT_TURN_STALE_MS);
    await db
      .update(agentTurns)
      .set({
        status: "failed",
        error: STALE_TURN_ERROR,
        endedAt: new Date(now()),
      })
      .where(
        and(
          eq(agentTurns.tenantId, scope.tenantId),
          eq(agentTurns.workbenchId, scope.workbenchId),
          ...(scope.agentAddress !== undefined
            ? [eq(agentTurns.agentAddress, scope.agentAddress)]
            : []),
          eq(agentTurns.status, "running"),
          lt(agentTurns.startedAt, cutoff),
        ),
      );
  }

  async function resolveRunningTurn(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly agentAddress: string;
    readonly childRunId?: string;
  }): Promise<AgentTurn | undefined> {
    await expireStaleTurns(input);
    const [row] = await db
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.tenantId, input.tenantId),
          eq(agentTurns.workbenchId, input.workbenchId),
          eq(agentTurns.agentAddress, input.agentAddress),
          eq(agentTurns.status, "running"),
          ...(input.childRunId !== undefined
            ? [eq(agentTurns.childRunId, input.childRunId)]
            : []),
        ),
      )
      .orderBy(desc(agentTurns.startedAt), desc(agentTurns.occurrence))
      .limit(1);
    return row === undefined ? undefined : toAgentTurn(row as AgentTurnRow);
  }

  return {
    async startTurn(input) {
      await expireStaleTurns(input);
      const occurrenceSql = sql<number>`(
        SELECT COALESCE(MAX(${agentTurns.occurrence}) + 1, 0)
        FROM ${agentTurns}
        WHERE ${agentTurns.tenantId} = ${input.tenantId}
          AND ${agentTurns.workbenchId} = ${input.workbenchId}
          AND ${agentTurns.agentAddress} = ${input.agentAddress}
      )`;
      const [row] = await db
        .insert(agentTurns)
        .values({
          id: sql`concat('turn_', gen_random_uuid()::text)`,
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          agentAddress: input.agentAddress,
          sectionRunId: null,
          childRunId: sql`concat(${`${AGENT_RUNTIME_SECTION_ID}__`}::text, ${occurrenceSql}::text)`,
          occurrence: occurrenceSql,
          requestMessageIds: [...input.requestMessageIds],
          replyMessageId: null,
          status: "running",
          error: null,
        })
        .returning();
      if (row === undefined) {
        throw new Error("startTurn inserted no row");
      }
      return toAgentTurn(row as AgentTurnRow);
    },

    async finishTurn(input) {
      // CL-7193: compare-and-set on status -- a turn already closed
      // (by a dispatch deadline's abort close, or an earlier finishTurn)
      // never gets clobbered by a second close racing in behind it.
      const [row] = await db
        .update(agentTurns)
        .set({
          status: input.status,
          endedAt: new Date(),
          ...(input.sectionRunId !== undefined
            ? { sectionRunId: input.sectionRunId }
            : {}),
          ...(input.replyMessageId !== undefined
            ? { replyMessageId: input.replyMessageId }
            : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        })
        .where(
          and(
            eq(agentTurns.id, input.turnId),
            eq(agentTurns.tenantId, input.tenantId),
            eq(agentTurns.status, "running"),
          ),
        )
        .returning();
      const finished =
        row === undefined ? undefined : toAgentTurn(row as AgentTurnRow);
      if (finished !== undefined) freed.notify(sectionKey(finished));
      return finished;
    },

    async findRunningTurn(input) {
      return resolveRunningTurn(input);
    },

    async findRunningTurns(input) {
      await expireStaleTurns(input);
      const rows = await db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.tenantId, input.tenantId),
            eq(agentTurns.workbenchId, input.workbenchId),
            eq(agentTurns.status, "running"),
          ),
        );
      return rows.map((row) => toAgentTurn(row as AgentTurnRow));
    },

    async waitUntilFree(input, signal) {
      for (;;) {
        if (signal?.aborted) throw signal.reason;
        const running = await resolveRunningTurn(input);
        if (running === undefined) return;
        const staleAt = Date.parse(running.startedAt) + AGENT_TURN_STALE_MS;
        const backstopMs = Math.max(0, staleAt - now()) + 50;
        await freed.wait(sectionKey(input), backstopMs, signal);
      }
    },

    async listTurns(input) {
      await expireStaleTurns(input);
      const rows = await db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.tenantId, input.tenantId),
            eq(agentTurns.workbenchId, input.workbenchId),
          ),
        )
        .orderBy(desc(agentTurns.startedAt), desc(agentTurns.occurrence))
        .limit(input.limit ?? AGENT_TURNS_PAGE_SIZE);
      return rows.map((row) => toAgentTurn(row as AgentTurnRow));
    },

    async getTurn(input) {
      const [row] = await db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.id, input.turnId),
            eq(agentTurns.tenantId, input.tenantId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : toAgentTurn(row as AgentTurnRow);
    },
  };
}
