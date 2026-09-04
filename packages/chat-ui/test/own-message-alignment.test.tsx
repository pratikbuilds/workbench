// The owner reversed CL-6488's flat, no-alignment timeline (itself matching
// the shell mock's "no right-alignment for you" spec, mock-spec.md §12.2):
// a shared workbench is multiplayer, so "your messages on the right" has to
// be evaluated per viewer, never baked into the message itself. The same
// server-issued item renders `data-own="true"` for the principal who sent
// it and `data-own="false"` for every other reader of that same bench —
// including a message an agent or teammate sent, which is never "own" for
// anyone but its author.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import type { CurrentUser } from "../src/timeline";
import { WorkbenchTimeline } from "../src/timeline";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(items: readonly MessageItem[], currentUser?: CurrentUser) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={items}
        {...(currentUser !== undefined ? { currentUser } : {})}
      />,
    );
  });
  return container;
}

function messageFrom(address: string): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "ship it" }],
      sender: { name: "Sawyer", address },
    },
  ];
}

describe("own-message alignment is per viewer, not per message", () => {
  test("a message authored by the viewing user renders right-aligned", async () => {
    const el = await mount(messageFrom("sawyer@agents.example"), {
      principalId: "sawyer",
    });
    const group = el.querySelector(".chat-message-group");
    const row = el.querySelector(".chat-bubble-row");
    const bubble = el.querySelector(".chat-bubble");
    expect(group?.getAttribute("data-own")).toBe("true");
    expect(row?.getAttribute("data-own")).toBe("true");
    expect(bubble?.hasAttribute("data-own")).toBe(false);
  });

  test("the same message viewed by a different user renders left-aligned", async () => {
    const el = await mount(messageFrom("sawyer@agents.example"), {
      principalId: "pontus",
    });
    const group = el.querySelector(".chat-message-group");
    const row = el.querySelector(".chat-bubble-row");
    const bubble = el.querySelector(".chat-bubble");
    expect(group?.getAttribute("data-own")).toBe("false");
    expect(row?.getAttribute("data-own")).toBe("false");
    expect(bubble?.hasAttribute("data-own")).toBe(false);
  });

  test("a system event line never gets own-message alignment, even when the current user caused it", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        sender: { name: "Sawyer", address: "sawyer@agents.example" },
        parts: [
          {
            kind: "event",
            event: "workbench.settings-changed",
            data: {
              changed: { "chat/name": "Launch plan" },
              previous: { "chat/name": "Untitled" },
            },
          },
        ],
      },
    ];
    const el = await mount(items, { principalId: "sawyer" });
    // System notices align left for every viewer (CL-6772 / DESIGN.md) —
    // even when this reader caused the event. Marking the group as own
    // would put them on the signed-in user's right edge.
    expect(
      el.querySelector(".chat-message-group")?.getAttribute("data-own"),
    ).toBe("false");
    expect(el.querySelector(".chat-event-line")).not.toBeNull();
    expect(el.querySelector(".chat-bubble-row")).toBeNull();
  });

  test("a join event posted under the viewing user's address stays left-aligned, never own", async () => {
    const items: MessageItem[] = [
      {
        id: "join_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        sender: { name: null, address: "sawyer@agents.example" },
        parts: [
          {
            kind: "event",
            event: "workbench.agent-joined",
            data: { address: "ins_scout@agents.example" },
          },
        ],
      },
    ];
    const el = await mount(items, { principalId: "sawyer" });
    expect(
      el.querySelector(".chat-message-group")?.getAttribute("data-own"),
    ).toBe("false");
    expect(el.querySelector(".chat-event-line")).not.toBeNull();
    expect(el.querySelector(".chat-bubble-row")).toBeNull();
  });

  test("no signed-in currentUser means nothing renders as own", async () => {
    const el = await mount(messageFrom("sawyer@agents.example"));
    expect(
      el.querySelector(".chat-message-group")?.getAttribute("data-own"),
    ).toBe("false");
  });

  test("own-authored text plus tool activity plus a gen-UI block keeps tools and the block outside the bubble", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        sender: { name: "Sawyer", address: "sawyer@agents.example" },
        parts: [
          { kind: "text", text: "ship it" },
          {
            kind: "tool-trace",
            name: "search",
            input: { q: "x" },
            status: "success",
          },
          {
            kind: "block",
            block: {
              type: "steps",
              data: {
                title: "Migration",
                steps: [{ label: "Snapshot", state: "done" }],
              },
            },
          },
        ],
      },
    ];
    const el = await mount(items, { principalId: "sawyer" });
    const group = el.querySelector(".chat-message-group");
    const row = el.querySelector(".chat-bubble-row");
    const bubble = el.querySelector(".chat-bubble");
    const tool = el.querySelector(".chat-tool-activity");
    const block = el.querySelector(".chat-block");
    expect(group?.getAttribute("data-own")).toBe("true");
    expect(row?.getAttribute("data-own")).toBe("true");
    expect(bubble?.hasAttribute("data-own")).toBe(false);
    expect(tool).not.toBeNull();
    expect(block).not.toBeNull();
    expect(bubble?.contains(tool)).toBe(false);
    expect(bubble?.contains(block)).toBe(false);
    expect(group?.contains(tool)).toBe(true);
    expect(group?.contains(block)).toBe(true);
  });

  test("own messages put Tailwind utilities on the thread affordance instead of a styles.css rule", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={messageFrom("sawyer@agents.example")}
          currentUser={{ principalId: "sawyer" }}
          onOpenThread={() => undefined}
          threadMetaByMessageId={
            new Map([
              [
                "m1",
                {
                  replyCount: 2,
                  lastActivityAt: null,
                  participantAddresses: ["sawyer@agents.example"],
                },
              ],
            ])
          }
        />,
      );
    });

    const ownAffordance = container.querySelector(".chat-thread-affordance");
    expect(ownAffordance?.className).toContain("ml-auto");
    expect(ownAffordance?.className).toContain("mr-[2.9rem]");
    expect(ownAffordance?.className).toContain("max-w-fit");
    expect(ownAffordance?.className).toContain("flex");
    expect(
      container.querySelector(".chat-thread-open")?.className,
    ).toContain("ml-0");

    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={messageFrom("sawyer@agents.example")}
          currentUser={{ principalId: "pontus" }}
          onOpenThread={() => undefined}
          threadMetaByMessageId={
            new Map([
              [
                "m1",
                {
                  replyCount: 2,
                  lastActivityAt: null,
                  participantAddresses: ["sawyer@agents.example"],
                },
              ],
            ])
          }
        />,
      );
    });

    const otherAffordance = container.querySelector(".chat-thread-affordance");
    expect(otherAffordance?.className).toContain("ml-[2.9rem]");
    expect(otherAffordance?.className).toContain("max-w-full");
    expect(otherAffordance?.className).not.toContain("ml-auto");
    expect(
      container.querySelector(".chat-thread-open")?.className,
    ).toContain("ml-auto");
  });
});
