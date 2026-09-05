// CL-7450: a sent human message lands in every human participant's
// mailbox — an "outbound" copy in the sender's own, "inbound" in every
// other human's — all sharing the row's own RFC 5322 Message-ID, all in
// ONE batch (one `@corbits/mailbox` transaction), and the same default
// transport idempotency key makes a retried send a no-op rather than a
// duplicate. Exercised against an in-memory `MailboxWriter`, never a
// live `@corbits/mailbox` schema — see `../src/mailbox-fanout.ts`'s own
// doc comment for why the write is behind that seam.
import { describe, expect, test } from "bun:test";
import {
  writeChatMailboxFanout,
  mailboxBodyOf,
  mailboxSubjectOf,
  MailboxFanoutFailedError,
  type MailboxBatchItem,
  type MailboxBatchResult,
  type MailboxWriter,
} from "../src/mailbox-fanout";
import type { ParticipantRecord } from "../src/participants";
import { sendWorkbenchMessage } from "../src/workbench-service";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { createInMemoryChatStore } from "../src/store";
import { createWorkbenchTurnQueue } from "../src/turn-queue";
import { createInMemoryTurnClaimStore } from "../src/turn-claims";
import { createTurnCancelRegistry } from "../src/turn-cancellation";

function inMemoryWriter(): {
  writer: MailboxWriter;
  rows: MailboxBatchItem[];
  batches: MailboxBatchItem[][];
} {
  const rows: MailboxBatchItem[] = [];
  const batches: MailboxBatchItem[][] = [];
  const seen = new Set<string>();
  function keyOf(item: MailboxBatchItem): string {
    return `${item.tenantId}:${item.principalId}:${item.messageId}:${item.direction}`;
  }
  return {
    rows,
    batches,
    writer: {
      async writeBatch(items) {
        batches.push([...items]);
        const results: MailboxBatchResult[] = [];
        for (const item of items) {
          const key = keyOf(item);
          if (seen.has(key)) {
            results.push({ messageKey: key, id: null });
            continue;
          }
          seen.add(key);
          rows.push(item);
          results.push({ messageKey: key, id: `mail_${String(rows.length)}` });
        }
        return results;
      },
    },
  };
}

function knownPrincipals(ids: readonly string[]) {
  const known = new Set(ids);
  return async (
    _tenantId: string,
    candidateIds: readonly string[],
  ): Promise<ReadonlySet<string>> =>
    new Set(candidateIds.filter((id) => known.has(id)));
}

function domainOf(domain: string) {
  return async (_tenantId: string) => domain;
}

const TENANT_ID = "tnt_1";
const WORKBENCH_ID = "wb_1";
const DOMAIN = "acme.example";
const SENDER = "prn_alice";
const OTHER_HUMANS = ["prn_bob", "prn_carol"];
const AGENT_ADDRESS = "ins_echo1@acme.example";

function participantsOf(
  senderId: string,
  humanIds: readonly string[],
  agentAddress: string,
): ParticipantRecord[] {
  return [
    { address: senderId, handle: senderId },
    ...humanIds.map((id) => ({ address: id, handle: id })),
    { address: agentAddress, handle: "echo" },
  ];
}

describe("writeChatMailboxFanout (CL-7450)", () => {
  test("a send to a three-human, one-agent workbench yields three mailbox writes, in one batch, sharing one Message-ID", async () => {
    const { writer, rows, batches } = inMemoryWriter();
    const senderAddress = `${SENDER}@${DOMAIN}`;

    await writeChatMailboxFanout(
      {
        writer,
        resolveKnownPrincipalIds: knownPrincipals([SENDER, ...OTHER_HUMANS]),
        resolveTenantDomain: domainOf(DOMAIN),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, OTHER_HUMANS, AGENT_ADDRESS),
        messageId: "<msg_1@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    expect(batches).toHaveLength(1);
    expect(rows).toHaveLength(3);
    const messageIds = new Set(rows.map((row) => row.messageId));
    expect(messageIds).toEqual(new Set(["<msg_1@acme.example>"]));

    const byPrincipal = new Map(rows.map((row) => [row.principalId, row]));
    expect(byPrincipal.get(SENDER)?.direction).toBe("outbound");
    expect(byPrincipal.get("prn_bob")?.direction).toBe("inbound");
    expect(byPrincipal.get("prn_carol")?.direction).toBe("inbound");

    // The agent never gets a mailbox row — its inbox is its run's own
    // mail queue, dispatched separately through `WorkbenchMail.sendMail`.
    expect(byPrincipal.has(AGENT_ADDRESS)).toBe(false);

    for (const row of rows) {
      expect(row.refs).toEqual([{ kind: "workbench", id: WORKBENCH_ID }]);
      expect(row.address).toBe(`${row.principalId}@${DOMAIN}`);
    }
  });

  test("a retried send is idempotent on the default transport key", async () => {
    const { writer, rows } = inMemoryWriter();
    const senderAddress = `${SENDER}@${DOMAIN}`;
    const input = {
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      senderAddress,
      senderPrincipalId: SENDER,
      participants: participantsOf(SENDER, OTHER_HUMANS, AGENT_ADDRESS),
      messageId: "<msg_2@acme.example>",
      subject: "hello",
      body: "hello",
    };
    const deps = {
      writer,
      resolveKnownPrincipalIds: knownPrincipals([SENDER, ...OTHER_HUMANS]),
      resolveTenantDomain: domainOf(DOMAIN),
    };

    await writeChatMailboxFanout(deps, input);
    await writeChatMailboxFanout(deps, input);

    expect(rows).toHaveLength(3);
  });

  test("skips a participant address with no known principal, reporting rather than writing", async () => {
    const { writer, rows } = inMemoryWriter();
    const senderAddress = `${SENDER}@${DOMAIN}`;

    await writeChatMailboxFanout(
      {
        writer,
        // "prn_bob" is a participant, but not a known tenant principal —
        // a stale or removed member.
        resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_carol"]),
        resolveTenantDomain: domainOf(DOMAIN),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, OTHER_HUMANS, AGENT_ADDRESS),
        messageId: "<msg_3@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    const principalIds = rows.map((row) => row.principalId);
    expect(principalIds).toContain(SENDER);
    expect(principalIds).toContain("prn_carol");
    expect(principalIds).not.toContain("prn_bob");
  });

  test("a same-tenant sender gets its own outbound copy", async () => {
    const { writer, rows } = inMemoryWriter();

    await writeChatMailboxFanout(
      {
        writer,
        resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_bob"]),
        resolveTenantDomain: domainOf(DOMAIN),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress: `${SENDER}@${DOMAIN}`,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, ["prn_bob"], AGENT_ADDRESS),
        messageId: "<msg_same_tenant@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    const bySender = rows.find((row) => row.principalId === SENDER);
    expect(bySender?.direction).toBe("outbound");
    expect(bySender?.address).toBe(`${SENDER}@${DOMAIN}`);
  });

  test("a share member sending into a bench it has no principal in skips its own copy quietly, but every other human still gets theirs", async () => {
    const { writer, rows } = inMemoryWriter();

    // The sender ("prn_dave") is a projected-tenant share member: not a
    // known principal in the workbench's OWNING tenant, unlike every
    // other (real bench-tenant) human participant.
    await writeChatMailboxFanout(
      {
        writer,
        resolveKnownPrincipalIds: knownPrincipals(OTHER_HUMANS),
        resolveTenantDomain: domainOf(DOMAIN),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress: `prn_dave@projected.example`,
        senderPrincipalId: "prn_dave",
        participants: participantsOf("prn_dave", OTHER_HUMANS, AGENT_ADDRESS),
        messageId: "<msg_share_member@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    const principalIds = rows.map((row) => row.principalId);
    expect(principalIds).not.toContain("prn_dave");
    expect(principalIds.sort()).toEqual([...OTHER_HUMANS].sort());
    // Every other human is addressed under the OWNER tenant's domain,
    // not the share member's own (projected) tenant's domain.
    for (const row of rows) {
      expect(row.address.endsWith(`@${DOMAIN}`)).toBe(true);
      expect(row.direction).toBe("inbound");
    }
  });

  test("propagates a batch write failure rather than swallowing it, as a MailboxFanoutFailedError carrying its own refId", async () => {
    const failing: MailboxWriter = {
      async writeBatch() {
        throw new Error("db exploded");
      },
    };

    let caught: unknown;
    try {
      await writeChatMailboxFanout(
        {
          writer: failing,
          resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_bob"]),
          resolveTenantDomain: domainOf(DOMAIN),
        },
        {
          tenantId: TENANT_ID,
          workbenchId: WORKBENCH_ID,
          senderAddress: `${SENDER}@${DOMAIN}`,
          senderPrincipalId: SENDER,
          participants: participantsOf(SENDER, ["prn_bob"], AGENT_ADDRESS),
          messageId: "<msg_4@acme.example>",
          subject: "hello",
          body: "hello",
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MailboxFanoutFailedError);
    const failure = caught as MailboxFanoutFailedError;
    expect(typeof failure.refId).toBe("string");
    expect((failure.cause as Error)?.message).toBe("db exploded");
  });

  test("inReplyTo threads through to every recipient's write", async () => {
    const { writer, rows } = inMemoryWriter();

    await writeChatMailboxFanout(
      {
        writer,
        resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_bob"]),
        resolveTenantDomain: domainOf(DOMAIN),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress: `${SENDER}@${DOMAIN}`,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, ["prn_bob"], AGENT_ADDRESS),
        messageId: "<msg_6@acme.example>",
        inReplyTo: "<msg_5@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    for (const row of rows) {
      expect(row.inReplyTo).toBe("<msg_5@acme.example>");
    }
  });

  test("references threads through to every recipient's write (CL-7450 finding 2)", async () => {
    const { writer, rows } = inMemoryWriter();

    await writeChatMailboxFanout(
      {
        writer,
        resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_bob"]),
        resolveTenantDomain: domainOf(DOMAIN),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress: `${SENDER}@${DOMAIN}`,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, ["prn_bob"], AGENT_ADDRESS),
        messageId: "<msg_7@acme.example>",
        inReplyTo: "<msg_6@acme.example>",
        references: ["<msg_5@acme.example>", "<msg_6@acme.example>"],
        subject: "hello",
        body: "hello",
      },
    );

    for (const row of rows) {
      expect(row.references).toEqual([
        "<msg_5@acme.example>",
        "<msg_6@acme.example>",
      ]);
    }
  });

  test("a root-feed send carries no references at all", async () => {
    const { writer, rows } = inMemoryWriter();

    await writeChatMailboxFanout(
      {
        writer,
        resolveKnownPrincipalIds: knownPrincipals([SENDER, "prn_bob"]),
        resolveTenantDomain: domainOf(DOMAIN),
      },
      {
        tenantId: TENANT_ID,
        workbenchId: WORKBENCH_ID,
        senderAddress: `${SENDER}@${DOMAIN}`,
        senderPrincipalId: SENDER,
        participants: participantsOf(SENDER, ["prn_bob"], AGENT_ADDRESS),
        messageId: "<msg_8@acme.example>",
        subject: "hello",
        body: "hello",
      },
    );

    for (const row of rows) {
      expect(row.references).toBeUndefined();
    }
  });
});

describe("sendWorkbenchMessage's mailbox fan-out wiring (CL-7450)", () => {
  test("posting a message stamps the row's mail Message-ID and fans it into every human participant's mailbox, before the row publishes", async () => {
    const { writer, rows } = inMemoryWriter();
    const store = createInMemoryChatStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const claims = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    const publishedIds: string[] = [];
    const turnQueue = createWorkbenchTurnQueue({
      claims,
      publish: () => undefined,
    });
    const turnCancellation = createTurnCancelRegistry();

    await store.createWorkbenchSettings({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      updatedBy: SENDER,
      settings: {
        "chat/participants": participantsOf(
          SENDER,
          OTHER_HUMANS,
          AGENT_ADDRESS,
        ),
      },
    });

    const result = await sendWorkbenchMessage(
      {
        store,
        roomMessages,
        publish: (_workbenchId, event) => {
          if (event.type === "chat.message") {
            publishedIds.push((event.data as { id: string }).id);
          }
        },
        platform: {
          async sendMail() {
            return { id: "mail_agent_1", createdAt: new Date().toISOString() };
          },
        },
        turnQueue,
        turnCancellation,
        mailbox: {
          writer,
          resolveKnownPrincipalIds: knownPrincipals([SENDER, ...OTHER_HUMANS]),
          resolveTenantDomain: domainOf(DOMAIN),
        },
      },
      {
        tenantId: TENANT_ID,
        principalId: SENDER,
        senderAddress: `${SENDER}@${DOMAIN}`,
        workbenchId: WORKBENCH_ID,
        messageParts: [{ kind: "text", text: "hello everyone" }],
      },
    );
    await result.fanoutDelivered;

    const stored = await roomMessages.getMessage({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      messageId: result.id,
    });
    expect(stored?.mailMessageId).toBe(`<${result.id}@${DOMAIN}>`);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.messageId).toBe(`<${result.id}@${DOMAIN}>`);
    }

    // The publish happened — proving the row is visible once fan-out
    // succeeds — and named exactly this message.
    expect(publishedIds).toEqual([result.id]);
  });

  test("a fan-out failure deletes the just-inserted row and never publishes it", async () => {
    const store = createInMemoryChatStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const claims = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    const turnQueue = createWorkbenchTurnQueue({
      claims,
      publish: () => undefined,
    });
    const turnCancellation = createTurnCancelRegistry();
    const publishedIds: string[] = [];

    await store.createWorkbenchSettings({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      updatedBy: SENDER,
      settings: {
        "chat/participants": participantsOf(
          SENDER,
          OTHER_HUMANS,
          AGENT_ADDRESS,
        ),
      },
    });

    const failingWriter: MailboxWriter = {
      async writeBatch() {
        throw new Error("db exploded");
      },
    };

    await expect(
      sendWorkbenchMessage(
        {
          store,
          roomMessages,
          publish: (_workbenchId, event) => {
            if (event.type === "chat.message") {
              publishedIds.push((event.data as { id: string }).id);
            }
          },
          platform: {
            async sendMail() {
              return {
                id: "mail_agent_1",
                createdAt: new Date().toISOString(),
              };
            },
          },
          turnQueue,
          turnCancellation,
          mailbox: {
            writer: failingWriter,
            resolveKnownPrincipalIds: knownPrincipals([
              SENDER,
              ...OTHER_HUMANS,
            ]),
            resolveTenantDomain: domainOf(DOMAIN),
          },
        },
        {
          tenantId: TENANT_ID,
          principalId: SENDER,
          senderAddress: `${SENDER}@${DOMAIN}`,
          workbenchId: WORKBENCH_ID,
          messageParts: [{ kind: "text", text: "hello everyone" }],
        },
      ),
    ).rejects.toBeInstanceOf(MailboxFanoutFailedError);

    expect(publishedIds).toEqual([]);
    const page = await roomMessages.listMessages({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
    });
    expect(page.items).toHaveLength(0);
  });
});

describe("mailboxBodyOf / mailboxSubjectOf", () => {
  test("joins text parts and clips the subject to the first line", () => {
    const body = mailboxBodyOf([
      { kind: "text", text: "line one" },
      { kind: "event" },
      { kind: "text", text: "line two" },
    ]);
    expect(body).toBe("line one\n\nline two");
    expect(mailboxSubjectOf(body)).toBe("line one");
  });

  test("a bodyless message gets a placeholder subject", () => {
    expect(mailboxSubjectOf("")).toBe("(no subject)");
  });

  test("an attachment-only message gets a real subject and a body listing its parts", () => {
    const body = mailboxBodyOf([
      { kind: "file", name: "diagram.png" },
      { kind: "file", name: "notes.txt" },
    ]);
    expect(body).toBe("Attachment: diagram.png\nAttachment: notes.txt");
    expect(mailboxSubjectOf(body)).toBe("Attachment: diagram.png");
  });
});
