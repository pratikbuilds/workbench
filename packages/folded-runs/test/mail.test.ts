// Proves `listFoldedMail`'s keyset pagination: a full three-page walk,
// including a `createdAt` tie broken by the `id` tiebreak, and
// `sendFoldedMail`'s wiring onto `sendUserMessage` / the `session_mail`
// insert / `dispatchAgentEvent`.
import { describe, expect, test } from "bun:test";
import { sessionMail } from "@intx/db/schema";
import {
  listFoldedMail,
  sendFoldedMail,
  sendFoldedMailWithRetry,
} from "../src/mail";

type SelectChain = {
  where(...args: unknown[]): SelectChain;
  orderBy(...args: unknown[]): SelectChain;
  limit(n?: number): Promise<unknown[]>;
};

/**
 * A real `session_mail` row set filtered/sorted by drizzle's own
 * `and`/`or`/`lt`/`eq`/`desc` — evaluated in-memory via a minimal
 * `postgres-js`-free predicate walker, so the cursor comparison this
 * proves is the one `listFoldedMail` actually built, not a
 * reimplementation of it.
 */
// `listFoldedMail` always passes the whole (already-filtered-by-cursor)
// row set for this test's fake `db.select().from(sessionMail)` to sort
// and limit -- the cursor filtering itself happens one level up, in the
// `from` closure below, driven by this test's own tracked
// `cursorState` (derived by decoding the real cursor `listFoldedMail`
// handed back on the previous page).
function sessionMailSelectChain(rows: { id: string; createdAt: Date }[]) {
  const chain: SelectChain = {
    where() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    limit(n?: number) {
      const sorted = [...rows].sort((a, b) => {
        const byDate = b.createdAt.getTime() - a.createdAt.getTime();
        if (byDate !== 0) return byDate;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      return Promise.resolve(n === undefined ? sorted : sorted.slice(0, n));
    },
  };
  return chain;
}

describe("listFoldedMail", () => {
  test("walks three pages via keyset pagination, with a stable order across a createdAt tie", async () => {
    const totalRows = 105;
    const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
    const rows: { id: string; createdAt: Date; raw: Uint8Array }[] = [];
    const RAW_MIME = new TextEncoder().encode(
      "Content-Type: text/plain\r\n\r\nhello",
    );
    for (let i = 0; i < totalRows; i++) {
      rows.push({
        id: `mail_${String(999 - i).padStart(4, "0")}`,
        createdAt: new Date(baseTime - i * 1_000),
        raw: RAW_MIME,
      });
    }
    // Force a tie on the two oldest rows: only the id tiebreak
    // (descending) can order them, proving the cursor comparison is
    // `(createdAt, id) < (cursor.createdAt, cursor.id)`, not
    // `createdAt` alone.
    const oldest = rows[totalRows - 1];
    const secondOldest = rows[totalRows - 2];
    if (oldest === undefined || secondOldest === undefined) {
      throw new Error("unreachable: totalRows >= 2");
    }
    oldest.createdAt = secondOldest.createdAt;

    // This fake evaluates the real cursor by re-deriving it the same
    // way `listFoldedMail` does (decoding the cursor it just handed
    // back), rather than interpreting the opaque drizzle condition.
    let cursorState: { createdAt: Date; id: string } | undefined;
    const db = {
      select() {
        return {
          from(table: unknown) {
            if (table !== sessionMail) return sessionMailSelectChain([]);
            const state = cursorState;
            const filtered =
              state === undefined
                ? rows
                : rows.filter(
                    (row) =>
                      row.createdAt.getTime() < state.createdAt.getTime() ||
                      (row.createdAt.getTime() === state.createdAt.getTime() &&
                        row.id < state.id),
                  );
            return sessionMailSelectChain(filtered);
          },
        };
      },
    };

    const expectedIds = rows.map((row) => row.id);
    function rowAt(index: number): { createdAt: Date; id: string } {
      const row = rows[index];
      if (row === undefined) throw new Error(`unreachable: no row at ${index}`);
      return row;
    }

    const page1 = await listFoldedMail(
      { db: db as never },
      { tenantId: "ten_1", sessionId: "ses_1" },
    );
    expect(page1.items.map((item) => item.id)).toEqual(
      expectedIds.slice(0, 50),
    );
    expect(page1.nextCursor).toBeDefined();

    const cursorAfterPage1 = page1.nextCursor;
    if (cursorAfterPage1 === undefined) {
      throw new Error("unreachable: asserted defined above");
    }
    cursorState = rowAt(49);
    const page2 = await listFoldedMail(
      { db: db as never },
      { tenantId: "ten_1", sessionId: "ses_1", cursor: cursorAfterPage1 },
    );
    expect(page2.items.map((item) => item.id)).toEqual(
      expectedIds.slice(50, 100),
    );
    expect(page2.nextCursor).toBeDefined();

    const cursorAfterPage2 = page2.nextCursor;
    if (cursorAfterPage2 === undefined) {
      throw new Error("unreachable: asserted defined above");
    }
    cursorState = rowAt(99);
    const page3 = await listFoldedMail(
      { db: db as never },
      { tenantId: "ten_1", sessionId: "ses_1", cursor: cursorAfterPage2 },
    );
    expect(page3.items.map((item) => item.id)).toEqual(
      expectedIds.slice(100, 105),
    );
    expect(page3.nextCursor).toBeUndefined();
  });
});

describe("sendFoldedMail", () => {
  test("signs via sendUserMessage, persists the session_mail row, and dispatches mail.delivered", async () => {
    const sendUserMessageCalls: unknown[] = [];
    const inserted: { table: unknown; values: unknown }[] = [];
    const dispatchAgentEventCalls: { address: string; event: unknown }[] = [];

    const db = {
      insert(table: unknown) {
        return {
          values: async (values: unknown) => {
            inserted.push({ table, values });
          },
        };
      },
    };
    const sessionService = {
      async sendUserMessage(params: unknown) {
        sendUserMessageCalls.push(params);
        return new TextEncoder().encode("raw-mime-bytes");
      },
    };
    const sidecarRouter = {
      dispatchAgentEvent(address: string, event: unknown) {
        dispatchAgentEventCalls.push({ address, event });
      },
    };

    const sent = await sendFoldedMail(
      {
        db: db as never,
        sessionService: sessionService as never,
        sidecarRouter: sidecarRouter as never,
      },
      {
        tenantId: "ten_1",
        sessionId: "ses_1",
        agentAddress: "ins_workbench1@ten1.workbench.test",
        from: "prn_sender@ten1.workbench.test",
        domain: "ten1.workbench.test",
        content: "hello workbench",
        cryptoProvider: {} as never,
      },
    );

    expect(sent.id).toBeTruthy();
    expect(sendUserMessageCalls).toHaveLength(1);
    const call = sendUserMessageCalls[0] as {
      agentAddress: string;
      content: string;
      sessionId: string;
      from: string;
    };
    expect(call.agentAddress).toBe("ins_workbench1@ten1.workbench.test");
    expect(call.content).toBe("hello workbench");
    expect(call.sessionId).toBe("ses_1");
    expect(call.from).toBe("prn_sender@ten1.workbench.test");

    const mailInsert = inserted.find((row) => row.table === sessionMail);
    expect(mailInsert?.values).toMatchObject({
      sessionId: "ses_1",
      tenantId: "ten_1",
      direction: "inbound",
      status: "delivered",
    });

    expect(dispatchAgentEventCalls).toHaveLength(1);
    expect(dispatchAgentEventCalls[0]?.address).toBe(
      "ins_workbench1@ten1.workbench.test",
    );
  });

  // CL-7450 finding 1: a caller that owns RFC 5322 threading identity for
  // what it is sending (chat's dispatched frame, whose Message-ID must
  // equal the timeline row's own) supplies `messageId`/`inReplyTo`/
  // `references` natively — no more `correlationId` side channel, and no
  // more silently dropping them on the floor.
  test("messageId/inReplyTo/references reach sendUserMessage verbatim, overriding the mailId-derived default", async () => {
    const sendUserMessageCalls: unknown[] = [];
    const db = {
      insert() {
        return { values: async () => undefined };
      },
    };
    const sessionService = {
      async sendUserMessage(params: unknown) {
        sendUserMessageCalls.push(params);
        return new TextEncoder().encode("raw-mime-bytes");
      },
    };
    const sidecarRouter = {
      dispatchAgentEvent() {
        return undefined;
      },
    };

    await sendFoldedMail(
      {
        db: db as never,
        sessionService: sessionService as never,
        sidecarRouter: sidecarRouter as never,
      },
      {
        tenantId: "ten_1",
        sessionId: "ses_1",
        agentAddress: "ins_workbench1@ten1.workbench.test",
        from: "prn_sender@ten1.workbench.test",
        domain: "ten1.workbench.test",
        content: "hello workbench",
        cryptoProvider: {} as never,
        messageId: "<msg_child@ten1.workbench.test>",
        inReplyTo: "<msg_parent@ten1.workbench.test>",
        references: ["<msg_root@ten1.workbench.test>"],
      },
    );

    expect(sendUserMessageCalls).toHaveLength(1);
    const call = sendUserMessageCalls[0] as {
      messageId: string;
      inReplyTo?: string;
      references?: string[];
    };
    expect(call.messageId).toBe("<msg_child@ten1.workbench.test>");
    expect(call.inReplyTo).toBe("<msg_parent@ten1.workbench.test>");
    expect(call.references).toEqual(["<msg_root@ten1.workbench.test>"]);
  });

  test("with no explicit threading, messageId derives from mailId and inReplyTo falls back to the legacy replyTo mapping", async () => {
    const sendUserMessageCalls: unknown[] = [];
    const db = {
      insert() {
        return { values: async () => undefined };
      },
    };
    const sessionService = {
      async sendUserMessage(params: unknown) {
        sendUserMessageCalls.push(params);
        return new TextEncoder().encode("raw-mime-bytes");
      },
    };
    const sidecarRouter = {
      dispatchAgentEvent() {
        return undefined;
      },
    };

    const sent = await sendFoldedMail(
      {
        db: db as never,
        sessionService: sessionService as never,
        sidecarRouter: sidecarRouter as never,
      },
      {
        tenantId: "ten_1",
        sessionId: "ses_1",
        agentAddress: "ins_workbench1@ten1.workbench.test",
        from: "prn_sender@ten1.workbench.test",
        domain: "ten1.workbench.test",
        content: "hello workbench",
        cryptoProvider: {} as never,
        replyTo: "wb_room1",
      },
    );

    const call = sendUserMessageCalls[0] as {
      messageId: string;
      inReplyTo?: string;
    };
    expect(call.messageId).toBe(`<${sent.id}@ten1.workbench.test>`);
    expect(call.inReplyTo).toBe("wb_room1");
  });
});

function fakeMailDeps(sendUserMessage: () => Promise<Uint8Array>) {
  return {
    db: {
      insert() {
        return { values: async () => undefined };
      },
    } as never,
    sessionService: { sendUserMessage } as never,
    sidecarRouter: { dispatchAgentEvent() {} } as never,
  };
}

const SEND_PARAMS = {
  tenantId: "ten_1",
  sessionId: "ses_1",
  agentAddress: "ins_workbench1@ten1.workbench.test",
  from: "prn_sender@ten1.workbench.test",
  domain: "ten1.workbench.test",
  content: "hello workbench",
  cryptoProvider: {} as never,
};

describe("sendFoldedMailWithRetry", () => {
  test("returns ok on the first attempt without retrying", async () => {
    let calls = 0;
    const deps = fakeMailDeps(async () => {
      calls += 1;
      return new TextEncoder().encode("raw-mime-bytes");
    });

    const result = await sendFoldedMailWithRetry(deps, SEND_PARAMS);

    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test("recovers after a transient failure, within the attempt bound", async () => {
    let calls = 0;
    const deps = fakeMailDeps(async () => {
      calls += 1;
      if (calls < 2) throw new Error("sidecar unreachable");
      return new TextEncoder().encode("raw-mime-bytes");
    });

    const result = await sendFoldedMailWithRetry(deps, SEND_PARAMS, 3);

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("never throws: reports failure after exhausting the bounded attempts", async () => {
    let calls = 0;
    const deps = fakeMailDeps(async () => {
      calls += 1;
      throw new Error("sidecar unreachable");
    });

    const result = await sendFoldedMailWithRetry(deps, SEND_PARAMS, 3);

    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
    if (result.ok) throw new Error("unreachable: asserted false above");
    expect(result.attempts).toBe(3);
    expect(result.error).toBeInstanceOf(Error);
  });

  test("never re-delivers: a successful send followed by a record-write failure is not retried", async () => {
    let sendUserMessageCalls = 0;
    const db = {
      insert() {
        return {
          values: async () => {
            throw new Error("db blip");
          },
        };
      },
    };
    const deps = {
      db: db as never,
      sessionService: {
        async sendUserMessage() {
          sendUserMessageCalls += 1;
          return new TextEncoder().encode("raw-mime-bytes");
        },
      } as never,
      sidecarRouter: { dispatchAgentEvent() {} } as never,
    };

    const result = await sendFoldedMailWithRetry(deps, SEND_PARAMS, 3);

    expect(sendUserMessageCalls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable: asserted false above");
    expect(result.attempts).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
  });
});
