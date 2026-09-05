// Unit tests for the RFC 5322 threading headers a dispatched timeline row
// carries (CL-7104): the derived `Message-ID`, the `References` chain the
// thread parentage produces, and the parent an inbound reply names.
import { describe, expect, test } from "bun:test";

import {
  mailMessageIdFor,
  mailThreadHeaders,
  parentMailMessageId,
  parseReferences,
  rowIdFromMailMessageId,
} from "./mail-headers";

describe("mailMessageIdFor", () => {
  test("frames the row id against the mail domain", () => {
    expect(mailMessageIdFor("msg_1", "ten1.workbench.test")).toBe(
      "<msg_1@ten1.workbench.test>",
    );
  });

  test("round-trips back to the row it names", () => {
    expect(
      rowIdFromMailMessageId(mailMessageIdFor("msg_1", "ten1.workbench.test")),
    ).toBe("msg_1");
  });

  test("an id from another transport misses the row instead of crashing", () => {
    expect(rowIdFromMailMessageId("deadbeef")).toBe("deadbeef");
    expect(rowIdFromMailMessageId("")).toBe("");
    expect(rowIdFromMailMessageId("<>")).toBe("<>");
  });
});

describe("mailThreadHeaders", () => {
  test("a root-feed row threads under nothing", () => {
    expect(
      mailThreadHeaders({ rowId: "msg_1", domain: "d.test", ancestors: [] }),
    ).toEqual({ messageId: "<msg_1@d.test>" });
  });

  test("a depth-1 reply names its anchor in both headers", () => {
    expect(
      mailThreadHeaders({
        rowId: "msg_2",
        domain: "d.test",
        ancestors: ["msg_1"],
      }),
    ).toEqual({
      messageId: "<msg_2@d.test>",
      inReplyTo: "<msg_1@d.test>",
      references: ["<msg_1@d.test>"],
    });
  });

  test("a sub-thread row carries the full ancestry, root first", () => {
    expect(
      mailThreadHeaders({
        rowId: "msg_3",
        domain: "d.test",
        ancestors: ["msg_1", "msg_2"],
      }),
    ).toEqual({
      messageId: "<msg_3@d.test>",
      inReplyTo: "<msg_2@d.test>",
      references: ["<msg_1@d.test>", "<msg_2@d.test>"],
    });
  });
});

describe("parentMailMessageId", () => {
  test("In-Reply-To names the parent", () => {
    expect(parentMailMessageId({ inReplyTo: "<msg_1@d.test>" })).toBe(
      "<msg_1@d.test>",
    );
  });

  test("References' tail names the parent when In-Reply-To is absent", () => {
    expect(
      parentMailMessageId({
        references: ["<msg_1@d.test>", "<msg_2@d.test>"],
      }),
    ).toBe("<msg_2@d.test>");
  });

  test("a reply threading under nothing resolves to no parent", () => {
    expect(parentMailMessageId({})).toBeUndefined();
    expect(
      parentMailMessageId({ inReplyTo: "", references: [] }),
    ).toBeUndefined();
  });
});

describe("parseReferences", () => {
  test("splits a folded header value into its Message-IDs", () => {
    expect(parseReferences("<a@d.test>\r\n  <b@d.test> <c@d.test>")).toEqual([
      "<a@d.test>",
      "<b@d.test>",
      "<c@d.test>",
    ]);
  });

  test("an empty header value carries no references", () => {
    expect(parseReferences("   ")).toEqual([]);
  });
});
