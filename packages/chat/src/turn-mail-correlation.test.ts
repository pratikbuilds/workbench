// Unit tests for the turn-mail correlation store (CL-6314): the framing
// normalizer, and the in-memory store's record/find contract —
// first-writer-wins on conflict, tenant isolation, unknown ids miss. The
// drizzle implementation's own race safety gets a DB-gated proof in
// `test/turn-mail-correlation.drizzle.test.ts`, mirroring how
// `write-claims` splits its unit and drizzle coverage.
import { describe, expect, test } from "bun:test";

import {
  createInMemoryTurnMailCorrelationStore,
  mailIdFromBracketMessageId,
} from "./turn-mail-correlation";

describe("mailIdFromBracketMessageId", () => {
  test("strips the MIME framing the reactor reports the bracket in", () => {
    expect(
      mailIdFromBracketMessageId(
        "<0f1e2d3c-4b5a-6789-abcd-ef0123456789@ten1.workbench.test>",
      ),
    ).toBe("0f1e2d3c-4b5a-6789-abcd-ef0123456789");
  });

  test("a bare mail id passes through unchanged", () => {
    expect(mailIdFromBracketMessageId("mail_1")).toBe("mail_1");
  });

  test("an id from another transport misses the lookup instead of crashing it", () => {
    expect(mailIdFromBracketMessageId("deadbeef")).toBe("deadbeef");
    expect(mailIdFromBracketMessageId("")).toBe("");
    expect(mailIdFromBracketMessageId("<>")).toBe("<>");
  });
});

describe("createInMemoryTurnMailCorrelationStore", () => {
  test("records a dispatch mail's source and reads it back", async () => {
    const store = createInMemoryTurnMailCorrelationStore();
    await store.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_1",
      workbenchId: "ins_workbench1",
      sourceMessageId: "msg_1",
    });

    expect(
      await store.findTurnMailSource({ tenantId: "ten_1", mailId: "mail_1" }),
    ).toEqual({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sourceMessageId: "msg_1",
    });
  });

  test("an unrecorded mail resolves to undefined, never a guess", async () => {
    const store = createInMemoryTurnMailCorrelationStore();
    expect(
      await store.findTurnMailSource({ tenantId: "ten_1", mailId: "mail_x" }),
    ).toBeUndefined();
  });

  test("the same mail id under another tenant is a different correlation", async () => {
    const store = createInMemoryTurnMailCorrelationStore();
    await store.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_1",
      workbenchId: "ins_workbench1",
      sourceMessageId: "msg_1",
    });

    expect(
      await store.findTurnMailSource({ tenantId: "ten_2", mailId: "mail_1" }),
    ).toBeUndefined();
  });

  test("a second record for the same mail keeps the first source", async () => {
    const store = createInMemoryTurnMailCorrelationStore();
    await store.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_1",
      workbenchId: "ins_workbench1",
      sourceMessageId: "msg_1",
    });
    await store.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_1",
      workbenchId: "ins_workbench1",
      sourceMessageId: "msg_2",
    });

    expect(
      await store.findTurnMailSource({ tenantId: "ten_1", mailId: "mail_1" }),
    ).toMatchObject({ sourceMessageId: "msg_1" });
  });
});
