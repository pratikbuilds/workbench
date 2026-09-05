// CL-7450 (finding 1): a message dispatched to an agent for a turn is
// itself mail, so it must carry the same RFC 5322 threading the human
// write path already stamps onto the timeline row — its own `Message-ID`,
// derived from the row (`mailMessageIdFor`, never minted separately), and
// `In-Reply-To` naming the row it replies to. Before this landed,
// `dispatchTurn`'s `sendMail` call carried none of that: the frame an
// agent actually receives named no row at all.
import { describe, expect, test } from "bun:test";
import type { MailContent } from "../src/codec";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { createInMemoryThreadStore } from "../src/threads";
import { createWorkbenchTurnQueue } from "../src/turn-queue";
import { createInMemoryTurnClaimStore } from "../src/turn-claims";
import { createTurnCancelRegistry } from "../src/turn-cancellation";
import { dispatchTurn, sendWorkbenchMessage } from "../src/workbench-service";
import { mailMessageIdFor } from "../src/mail-headers";
import type { MailboxWriter } from "../src/mailbox-fanout";

const TENANT_ID = "tnt_1";
const WORKBENCH_ID = "wb_1";
const DOMAIN = "acme.example";
const SENDER = "prn_alice";
const AGENT_ADDRESS = "ins_echo1@acme.example";

function noopMailbox() {
  const writer: MailboxWriter = {
    async writeBatch(items) {
      return items.map((_item, index) => ({
        messageKey: String(index),
        id: `mbx_${String(index)}`,
      }));
    },
  };
  return {
    writer,
    resolveKnownPrincipalIds: async () => new Set<string>([SENDER]),
    resolveTenantDomain: async () => DOMAIN,
  };
}

function participants() {
  return [
    { address: SENDER, handle: SENDER },
    { address: AGENT_ADDRESS, handle: "echo" },
  ];
}

async function makeDeps(sentMail: MailContent[]) {
  const store = createInMemoryChatStore();
  const roomMessages = createInMemoryRoomMessageStore();
  const threads = createInMemoryThreadStore();
  const claims = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
  const turnQueue = createWorkbenchTurnQueue({
    claims,
    publish: () => undefined,
  });
  const turnCancellation = createTurnCancelRegistry();

  await store.createWorkbenchSettings({
    tenantId: TENANT_ID,
    workbenchId: WORKBENCH_ID,
    updatedBy: SENDER,
    settings: { "chat/participants": participants() },
  });

  const deps = {
    store,
    roomMessages,
    threads,
    publish: () => undefined,
    platform: {
      async sendMail(input: { content: MailContent }) {
        sentMail.push(input.content);
        return { id: "mail_agent_1", createdAt: new Date().toISOString() };
      },
    },
    turnQueue,
    turnCancellation,
    mailbox: noopMailbox(),
  };
  return { deps, roomMessages, threads };
}

describe("dispatchTurn's RFC 5322 threading (CL-7450)", () => {
  test("the dispatched frame's messageId equals the stored row's own mailMessageId", async () => {
    const sentMail: MailContent[] = [];
    const { deps, roomMessages } = await makeDeps(sentMail);

    const posted = await sendWorkbenchMessage(deps, {
      tenantId: TENANT_ID,
      principalId: SENDER,
      senderAddress: `${SENDER}@${DOMAIN}`,
      workbenchId: WORKBENCH_ID,
      messageParts: [{ kind: "text", text: "hello" }],
    });
    await posted.fanoutDelivered;

    const stored = await roomMessages.getMessage({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      messageId: posted.id,
    });
    expect(stored?.mailMessageId).toBe(`<${posted.id}@${DOMAIN}>`);

    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]?.messageId).toBe(stored?.mailMessageId ?? undefined);
    expect(sentMail[0]?.inReplyTo).toBeUndefined();
  });

  // Exercises `dispatchTurn` directly rather than through
  // `sendWorkbenchMessage`'s async fan-out: the reply-thread membership a
  // dispatch's ancestry reads must already be assigned by the time it
  // fires, which is exactly the ordering `routeMessage`'s doc comment
  // promises never blocks the sender — assigning it upfront here is what
  // isolates the ancestry-walk behavior from that unrelated race.
  test("a reply's dispatched frame names its parent row's Message-ID in In-Reply-To and References", async () => {
    const sentMail: MailContent[] = [];
    const { deps, threads } = await makeDeps(sentMail);

    const parentMessageId = "msg_parent";
    const childMessageId = "msg_child";
    const replyThread = await threads.openReplyThread({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      parentMessageId,
    });
    await threads.assignMessage({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      threadId: replyThread.id,
      messageId: childMessageId,
    });

    await dispatchTurn(deps, {
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      principalId: SENDER,
      agentAddress: AGENT_ADDRESS,
      parts: [{ kind: "text", text: "reply" }],
      requestMessageIds: [childMessageId],
    });

    const expectedMessageId = mailMessageIdFor(childMessageId, DOMAIN);
    const expectedParentId = mailMessageIdFor(parentMessageId, DOMAIN);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]?.messageId).toBe(expectedMessageId);
    expect(sentMail[0]?.inReplyTo).toBe(expectedParentId);
    expect(sentMail[0]?.references).toEqual([expectedParentId]);
  });
});
