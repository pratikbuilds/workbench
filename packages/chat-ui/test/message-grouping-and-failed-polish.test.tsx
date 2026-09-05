// DOM tests for the CL-6106 timeline polish pass: consecutive same-author
// messages collapse into a grouped run (avatar/name shown once, follow-ups
// indented with a hover-revealed timestamp), and a failed pending bubble's
// Retry/Discard render as proper react-ui buttons rather than underlined
// text links.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import type { PendingActions, TimelineMessageItem } from "../src/timeline";
import { WorkbenchTimeline } from "../src/timeline";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(items: readonly TimelineMessageItem[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WorkbenchTimeline items={items} />);
  });
  return container;
}

describe("consecutive same-author grouping", () => {
  test("a second message from the same author on the same day drops its avatar and header", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "first" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-01T00:00:30.000Z",
        parts: [{ kind: "text", text: "second" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const el = await mount(items);
    const groups = el.querySelectorAll(".chat-message-group");
    expect(groups[0]?.getAttribute("data-grouped")).toBe("false");
    expect(groups[1]?.getAttribute("data-grouped")).toBe("true");

    const rows = el.querySelectorAll(".chat-bubble-row");
    expect(rows[0]?.querySelector(".sender-avatar-button")).not.toBeNull();
    expect(rows[0]?.querySelector(".chat-bubble-head")).not.toBeNull();

    expect(rows[1]?.getAttribute("data-grouped")).toBe("true");
    expect(rows[1]?.querySelector(".sender-avatar-button")).toBeNull();
    expect(rows[1]?.querySelector(".chat-bubble-head")).toBeNull();
    expect(rows[1]?.querySelector(".chat-bubble-time-grouped")).not.toBeNull();
  });

  test("a different author never groups, even immediately after", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-01T00:00:05.000Z",
        parts: [{ kind: "text", text: "hello" }],
        sender: { name: "Ada", address: "ada@agents.example" },
      },
    ];
    const el = await mount(items);
    const groups = el.querySelectorAll(".chat-message-group");
    expect(groups[1]?.getAttribute("data-grouped")).toBe("false");
    expect(
      el
        .querySelectorAll(".chat-bubble-row")[1]
        ?.querySelector(".chat-bubble-head"),
    ).not.toBeNull();
  });

  test("a day divider always resets grouping, even for the same author", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T23:59:00.000Z",
        parts: [{ kind: "text", text: "before midnight" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-02T00:01:00.000Z",
        parts: [{ kind: "text", text: "after midnight" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const el = await mount(items);
    const groups = el.querySelectorAll(".chat-message-group");
    expect(groups[1]?.getAttribute("data-grouped")).toBe("false");
  });

  test("an event line between two messages from the same author breaks the group", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "first" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-01T00:00:10.000Z",
        parts: [
          { kind: "event", event: "workbench.settings-changed", data: {} },
        ],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m3",
        createdAt: "2026-01-01T00:00:20.000Z",
        parts: [{ kind: "text", text: "third" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const el = await mount(items);
    const groups = el.querySelectorAll(".chat-message-group");
    expect(groups[2]?.getAttribute("data-grouped")).toBe("false");
  });
});

describe("failed pending message's inline recovery affordance", () => {
  function failedItem(): TimelineMessageItem[] {
    return [
      {
        id: "pending_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_self1@agents.example" },
        pendingStatus: "failed",
        pendingNonce: "nonce_1",
      },
    ];
  }

  test("Retry and Discard render as real buttons, not underlined links", async () => {
    const pendingActions: PendingActions = {
      onRetry: () => {},
      onDiscard: () => {},
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedItem()}
          currentUser={{ principalId: "prn_self1" }}
          pendingActions={pendingActions}
        />,
      );
    });

    const retry = container.querySelector(".chat-pending-retry");
    const discard = container.querySelector(".chat-pending-discard");
    expect(retry?.tagName).toBe("BUTTON");
    expect(discard?.tagName).toBe("BUTTON");
    expect(retry?.getAttribute("data-slot")).toBe("button");
    expect(discard?.getAttribute("data-slot")).toBe("button");
    expect(retry?.className).not.toContain("underline");
    expect(discard?.className).not.toContain("underline");

    expect(
      container.querySelector(".chat-pending-failed-label")?.textContent,
    ).toBe("Not sent");
  });
});

// CL-6677: the client-side reply-timeout backstop (a cold-waking room —
// PR #327's defer-to-wake path — that never streams a single token back)
// used to render as a bare quiet event line: no ref id, no Retry. It now
// carries a `turnFailed` text part exactly like the server's own
// undelivered-turn notice (`postUndeliveredNotice`, CL-6308/CL-6644), so
// it renders through the same `FailedTurnStrip` — ref id quotable, Retry
// wired — instead of a second, weaker backstop with no actions.
describe("the reply-timed-out notice gets the same ref+Retry treatment as the server-side backstop", () => {
  test("shows the honest 'no reply arrived' copy with a quotable ref id, through FailedTurnStrip", async () => {
    const items: MessageItem[] = [
      {
        id: "notice_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "text",
            text: "No reply arrived — the agent may be unavailable. (ref mt4ewrje-zvbmti)",
            turnFailed: true,
          },
        ],
        sender: { name: null, address: "myra@agents.example" },
      },
    ];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={items}
          participants={[{ address: "myra@agents.example", handle: "myra" }]}
        />,
      );
    });

    const strip = container.querySelector(".chat-turn-failed");
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("didn't reply");

    const retryButton = container.querySelector(".chat-turn-failed-retry");
    expect(retryButton).not.toBeNull();

    act(() => {
      container
        ?.querySelector(".chat-turn-failed-disclosure")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      container.querySelector(".chat-turn-failed-detail")?.textContent,
    ).toContain("(ref mt4ewrje-zvbmti)");

    // Never the old, action-less plain event line for this failure.
    expect(container.querySelector(".chat-event-line")).toBeNull();
  });
});

// CL-6252 #5: `initialsOf("You")` reads as "YO" — a fabricated pair with no
// relationship to the signed-in person. The own-message avatar now derives
// its initials from `currentUser.name`/`handle`, falling back to "•" (never
// "YO") when neither is known, while the "You" label itself is untouched.
describe("own-message avatar initials never fabricate 'YO'", () => {
  function ownItem(): MessageItem[] {
    return [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_self1@agents.example" },
      },
    ];
  }

  async function mountOwn(currentUser: {
    principalId: string;
    name?: string;
    handle?: string;
  }) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline items={ownItem()} currentUser={currentUser} />,
      );
    });
    return container;
  }

  test("a name on currentUser drives real initials, not the 'You' label", async () => {
    const el = await mountOwn({
      principalId: "prn_self1",
      name: "Sawyer Cutler",
    });
    expect(el.querySelector(".sender-avatar")?.textContent).toBe("SC");
    expect(el.querySelector(".chat-bubble-sender")?.textContent).toBe(
      "Sawyer Cutler",
    );
  });

  test("no name but a handle falls back to that handle's first letter", async () => {
    const el = await mountOwn({
      principalId: "prn_self1",
      handle: "sawyer@example.com",
    });
    expect(el.querySelector(".sender-avatar")?.textContent).toBe("S");
    expect(el.querySelector(".chat-bubble-sender")?.textContent).toBe("You");
  });

  test("no name and no handle falls back to the honest unknown glyph, never 'YO'", async () => {
    const el = await mountOwn({ principalId: "prn_self1" });
    expect(el.querySelector(".sender-avatar")?.textContent).toBe("•");
    expect(el.querySelector(".chat-bubble-sender")?.textContent).toBe("You");
  });
});
