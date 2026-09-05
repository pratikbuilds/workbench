// Durable correlation between a dispatch mail and the workbench message
// it answers (CL-6314): `dispatchTurn` records the `SentMail.id` its own
// `sendMail` returned next to the source message id, and the orchestrator
// reads it back when the agent's `message.run.started` bracket names that
// same mail — so a reply lands in the source message's thread no matter
// which agent answered, and the delegation hop needs no map of its own.
//
// A record means "this mail was sent for that message", written once per
// dispatch right after its send resolves. Redelivery-safe by
// construction: the insert is `ON CONFLICT DO NOTHING` on the primary
// key, the same atomic-dedup shape `WriteClaimStore` uses, so recording
// the same mail twice keeps the first source rather than throwing or
// overwriting it.
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { localPartOf } from "./agent-address";
import { turnMailCorrelation } from "./schema";

export type TurnMailSource = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly sourceMessageId: string;
};

export type RecordTurnMailInput = TurnMailSource & {
  /** The `SentMail.id` the dispatch's own `sendMail` returned — the bare
   * mail id, without the `<id@domain>` MIME framing the reactor later
   * reports it in (see `mailIdFromBracketMessageId`). */
  readonly mailId: string;
};

export type TurnMailCorrelationStore = {
  /**
   * Records which workbench message a dispatch mail answers. Insert-only:
   * a second record for the same mail is a no-op that keeps the first
   * source, so a retried dispatch can never re-point a mail another
   * delivery already claimed.
   */
  recordTurnMail(input: RecordTurnMailInput): Promise<void>;
  /** The source a mail was recorded for, or undefined when nothing was
   * ever recorded for it (a mail no workbench dispatch sent). */
  findTurnMailSource(input: {
    readonly tenantId: string;
    readonly mailId: string;
  }): Promise<TurnMailSource | undefined>;
};

export type TurnMailCorrelationDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

/**
 * Production store over `turnMailCorrelation`. One atomic
 * `INSERT ... ON CONFLICT DO NOTHING`, never a select-then-branch: two
 * dispatches racing the same mail both attempt the insert, Postgres
 * serializes them at the row lock, and the loser keeps the winner's
 * source rather than throwing a PK-violation — the same fix
 * `createDrizzleWriteClaimStore` (`./write-claims.ts`) uses.
 */
export function createDrizzleTurnMailCorrelationStore<
  TSchema extends Record<string, unknown>,
>(db: TurnMailCorrelationDb<TSchema>): TurnMailCorrelationStore {
  return {
    async recordTurnMail(input) {
      await db
        .insert(turnMailCorrelation)
        .values({
          tenantId: input.tenantId,
          mailId: input.mailId,
          workbenchId: input.workbenchId,
          sourceMessageId: input.sourceMessageId,
        })
        .onConflictDoNothing({
          target: [turnMailCorrelation.tenantId, turnMailCorrelation.mailId],
        });
    },

    async findTurnMailSource(input) {
      const [row] = await db
        .select()
        .from(turnMailCorrelation)
        .where(
          and(
            eq(turnMailCorrelation.tenantId, input.tenantId),
            eq(turnMailCorrelation.mailId, input.mailId),
          ),
        )
        .limit(1);
      return row === undefined
        ? undefined
        : {
            tenantId: row.tenantId,
            workbenchId: row.workbenchId,
            sourceMessageId: row.sourceMessageId,
          };
    },
  };
}

/**
 * In-memory `TurnMailCorrelationStore`, for tests only. Constructed
 * outside the orchestrator and handed in as a dependency — like
 * `createInMemoryWriteClaimStore`, so a test can hold the same store
 * across two separately-constructed instances to prove a correlation
 * survives what a hub restart looks like from the reply path's point
 * of view, which process-local state never could.
 */
export function createInMemoryTurnMailCorrelationStore(): TurnMailCorrelationStore {
  const sources = new Map<string, TurnMailSource>();
  const keyOf = (tenantId: string, mailId: string) => `${tenantId}::${mailId}`;
  return {
    async recordTurnMail(input) {
      const key = keyOf(input.tenantId, input.mailId);
      if (sources.has(key)) return;
      sources.set(key, {
        tenantId: input.tenantId,
        workbenchId: input.workbenchId,
        sourceMessageId: input.sourceMessageId,
      });
    },
    async findTurnMailSource(input) {
      return sources.get(keyOf(input.tenantId, input.mailId));
    },
  };
}

/**
 * Strips the MIME framing back to the bare id `sendMail` returned.
 * `sendFoldedMail` delivers with `Message-ID: <mailId@domain>` and the
 * reactor opens its per-message bracket with exactly that header value,
 * so the bracket's `messageId` never equals the recorded `mailId`
 * without this step. A value with no framing (or no `@`) is returned
 * unchanged, so an id from any other transport simply misses the lookup
 * and its reply posts unthreaded rather than crashing the match.
 */
export function mailIdFromBracketMessageId(messageId: string): string {
  const framed =
    messageId.startsWith("<") && messageId.endsWith(">") && messageId.length > 2
      ? messageId.slice(1, -1)
      : messageId;
  return localPartOf(framed);
}
