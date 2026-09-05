import { describe, expect, test } from "bun:test";
import type { WorkbenchThread, MessageItem } from "@corbits/chat-ui";

import type { PendingApproval } from "./pending-approvals";
import {
  computeTimelineDayKpis,
  filterTimelineEvents,
  groupTimelineByDay,
  mergeTimelineEvents,
  toApprovalEvents,
  toMessageEvents,
  toThreadForkEvents,
  type TimelineEvent,
} from "./workbench-timeline-merge";

function message(overrides: Partial<MessageItem> = {}): MessageItem {
  return {
    id: "msg-1",
    createdAt: "2026-08-17T10:00:00.000Z",
    parts: [{ kind: "text", text: "hello there" }],
    sender: { name: "Sawyer", address: "sawyer@bench-1" },
    ...overrides,
  } as MessageItem;
}

function thread(overrides: Partial<WorkbenchThread> = {}): WorkbenchThread {
  return {
    id: "thread-1",
    kind: "reply",
    parentMessageId: "msg-1",
    parentThreadId: null,
    runRef: null,
    title: "A fork",
    createdAt: "2026-08-17T10:05:00.000Z",
    ...overrides,
  } as WorkbenchThread;
}

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "approval-1",
    agentName: "Researcher",
    benchName: "Acme",
    headline: "Send the email",
    arguments: {},
    status: "pending",
    createdAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  } as PendingApproval;
}

describe("toMessageEvents", () => {
  test("joins text parts and truncates the excerpt at 120 chars", () => {
    const long = "a".repeat(200);
    const [event] = toMessageEvents([
      message({ parts: [{ kind: "text", text: long }] }),
    ]);
    expect(event?.excerpt.length).toBe(121);
    expect(event?.excerpt.endsWith("…")).toBe(true);
  });

  test("falls back to the sender's local part, never the raw address", () => {
    const [event] = toMessageEvents([
      message({ sender: { name: null, address: "echo@workbench-1" } }),
    ]);
    expect(event?.senderName).toBe("echo");
  });

  test("marks an agent sender via its @-shaped address", () => {
    const [event] = toMessageEvents([
      message({ sender: { name: null, address: "researcher@workbench-1" } }),
    ]);
    expect(event?.isAgent).toBe(true);
  });

  test("marks a human sender (no @) as not an agent", () => {
    const [event] = toMessageEvents([
      message({ sender: { name: "Sawyer", address: "principal-123" } }),
    ]);
    expect(event?.isAgent).toBe(false);
  });

  test("empty parts render an honest placeholder, never a blank excerpt", () => {
    const [event] = toMessageEvents([message({ parts: [] })]);
    expect(event?.excerpt).toBe("(no text)");
  });
});

describe("toThreadForkEvents", () => {
  test("drops the root thread", () => {
    const events = toThreadForkEvents([
      thread({ id: "root-1", kind: "root" }),
      thread({ id: "fork-1", kind: "reply" }),
    ]);
    expect(events.map((e) => e.id)).toEqual(["fork-1"]);
  });

  test("titles a fork with no title 'Thread'", () => {
    const [event] = toThreadForkEvents([thread({ title: null })]);
    expect(event?.title).toBe("Thread");
  });
});

describe("toApprovalEvents", () => {
  test("carries every pending approval through unfiltered", () => {
    const events = toApprovalEvents([approval()]);
    expect(events).toEqual([
      {
        kind: "approval",
        id: "approval-1",
        at: "2026-08-17T12:00:00.000Z",
        agentName: "Researcher",
        headline: "Send the email",
      },
    ]);
  });
});

describe("mergeTimelineEvents", () => {
  test("sorts every kind onto one oldest-first spine", () => {
    const merged = mergeTimelineEvents({
      messages: toMessageEvents([
        message({ id: "m1", createdAt: "2026-08-17T10:00:00.000Z" }),
      ]),
      threadForks: toThreadForkEvents([
        thread({ id: "f1", createdAt: "2026-08-17T09:30:00.000Z" }),
      ]),
      approvals: toApprovalEvents([
        approval({ id: "a1", createdAt: "2026-08-17T12:00:00.000Z" }),
      ]),
    });
    expect(merged.map((e) => e.id)).toEqual(["f1", "m1", "a1"]);
  });

  test("drops an event with an unparseable timestamp instead of sorting it arbitrarily", () => {
    const merged = mergeTimelineEvents({
      messages: toMessageEvents([
        message({ id: "m1", createdAt: "not-a-date" }),
      ]),
      threadForks: [],
      approvals: [],
    });
    expect(merged).toEqual([]);
  });
});

describe("groupTimelineByDay", () => {
  test("buckets an already-sorted spine by UTC calendar day, oldest day first", () => {
    const events: TimelineEvent[] = [
      {
        kind: "message",
        id: "m1",
        at: "2026-08-16T23:00:00.000Z",
        senderName: "A",
        excerpt: "x",
        isAgent: false,
      },
      {
        kind: "message",
        id: "m2",
        at: "2026-08-17T01:00:00.000Z",
        senderName: "A",
        excerpt: "y",
        isAgent: false,
      },
      {
        kind: "message",
        id: "m3",
        at: "2026-08-17T02:00:00.000Z",
        senderName: "A",
        excerpt: "z",
        isAgent: false,
      },
    ];
    const groups = groupTimelineByDay(events);
    expect(groups.map((g) => g.day)).toEqual(["2026-08-16", "2026-08-17"]);
    expect(groups[0]?.events.map((e) => e.id)).toEqual(["m1"]);
    expect(groups[1]?.events.map((e) => e.id)).toEqual(["m2", "m3"]);
  });
});

describe("computeTimelineDayKpis", () => {
  test("counts messages, agent turns, and approvals per day", () => {
    const events: TimelineEvent[] = [
      {
        kind: "message",
        id: "m1",
        at: "2026-08-17T09:00:00.000Z",
        senderName: "A",
        excerpt: "x",
        isAgent: false,
      },
      {
        kind: "message",
        id: "m2",
        at: "2026-08-17T09:05:00.000Z",
        senderName: "researcher",
        excerpt: "y",
        isAgent: true,
      },
      {
        kind: "approval",
        id: "a1",
        at: "2026-08-17T09:15:00.000Z",
        agentName: "Researcher",
        headline: "Do it",
      },
      {
        kind: "thread-fork",
        id: "f1",
        at: "2026-08-17T09:25:00.000Z",
        threadKind: "reply",
        title: "Fork",
        parentMessageId: null,
      },
    ];
    const [kpi] = computeTimelineDayKpis(events);
    expect(kpi).toMatchObject({
      messages: 2,
      agentTurns: 1,
      approvals: 1,
    });
  });
});

describe("filterTimelineEvents", () => {
  const events: TimelineEvent[] = [
    {
      kind: "message",
      id: "m1",
      at: "2026-08-17T09:00:00.000Z",
      senderName: "A",
      excerpt: "x",
      isAgent: false,
    },
    {
      kind: "thread-fork",
      id: "f1",
      at: "2026-08-17T09:01:00.000Z",
      threadKind: "reply",
      title: "Fork",
      parentMessageId: null,
    },
    {
      kind: "approval",
      id: "a1",
      at: "2026-08-17T09:04:00.000Z",
      agentName: "Researcher",
      headline: "Do it",
    },
  ];

  test("all keeps everything", () => {
    expect(filterTimelineEvents(events, "all")).toHaveLength(3);
  });

  test("messages keeps messages and thread forks", () => {
    expect(filterTimelineEvents(events, "messages").map((e) => e.id)).toEqual([
      "m1",
      "f1",
    ]);
  });

  test("approvals keeps only approvals", () => {
    expect(filterTimelineEvents(events, "approvals").map((e) => e.id)).toEqual([
      "a1",
    ]);
  });
});
