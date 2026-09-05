// CL-5879: a message the reader just sent must render exactly like a
// normal message immediately (full opacity, no restyling) with only a
// small clock glyph while in flight, and never disappear or get replaced
// once the send fails.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

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

async function mount(
  items: readonly TimelineMessageItem[],
  pendingActions?: PendingActions,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={items}
        {...(pendingActions !== undefined ? { pendingActions } : {})}
      />,
    );
  });
  return container;
}

describe("pending send lifecycle", () => {
  test("a sending message renders its bubble with no dimming style and a clock glyph", async () => {
    const el = await mount([
      {
        id: "pending_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hello there" }],
        sender: { name: null, address: "prn_self1@agents.example" },
        pendingStatus: "sending",
        pendingNonce: "nonce_1",
      },
    ]);

    const bubble = el.querySelector(".chat-bubble");
    expect(bubble?.textContent).toContain("hello there");
    expect(bubble?.getAttribute("style")).toBeNull();
    expect(el.querySelector(".chat-pending-glyph")).not.toBeNull();
  });

  // CL-6251 reopened: a pending send used to render through its own
  // avatar-less, timestamp-less tier below the real timeline — the exact
  // mechanism the owner read as "unsent -> sent". It now renders through
  // the same path (`MessageParts`/`TextBubble`) any confirmed message
  // does: full avatar, sender name, and local timestamp, with only the
  // clock glyph as the one "still sending" cue.
  test("a sending message renders full-fidelity — avatar, sender name, and a real timestamp — not a stripped-down bubble", async () => {
    const el = await mount([
      {
        id: "pending_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hello there" }],
        sender: { name: null, address: "prn_self1@agents.example" },
        pendingStatus: "sending",
        pendingNonce: "nonce_1",
      },
    ]);

    expect(el.querySelector(".sender-avatar-button")).not.toBeNull();
    expect(el.querySelector(".chat-bubble-time")?.textContent).not.toBe("");
    expect(el.querySelector(".chat-message-actions")).toBeNull();
  });

  test("a failed send keeps the bubble text visible and adds a retry row, without removing it", async () => {
    const el = await mount(
      [
        {
          id: "pending_2",
          createdAt: "2026-01-01T00:00:00.000Z",
          parts: [{ kind: "text", text: "will retry" }],
          sender: { name: null, address: "prn_self1@agents.example" },
          pendingStatus: "failed",
          pendingNonce: "nonce_2",
        },
      ],
      { onRetry: () => {}, onDiscard: () => {} },
    );

    expect(el.querySelector(".chat-bubble-text")?.textContent).toBe(
      "will retry",
    );
    expect(el.querySelector(".chat-pending-failed-label")?.textContent).toBe(
      "Not sent",
    );
    expect(el.querySelector(".chat-pending-retry")).not.toBeNull();
  });
});
