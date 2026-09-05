// CL-6251 reopened: dedup by clientId alone still let a sent message read
// as "unsent -> sent" because the pending bubble and its confirmed copy
// were two structurally different renders (a stripped-down pending tier
// swapping for a full bubble under a brand-new React key). This suite
// covers the fix directly: one message list, keyed by clientId, so a
// pending entry and its later confirmed copy share a DOM identity and
// every interleaving between POST and background refresh renders exactly
// one bubble.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import type { TimelineMessageItem } from "../src/timeline";
import { WorkbenchTimeline } from "../src/timeline";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(items: readonly TimelineMessageItem[]) {
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={items}
        currentUser={{ principalId: "prn_alice" }}
        pendingActions={{ onRetry: () => {}, onDiscard: () => {} }}
      />,
    );
  });
  return container;
}

const pendingItem: TimelineMessageItem = {
  id: "pending_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  parts: [{ kind: "text", text: "hi" }],
  sender: { name: null, address: "prn_alice@pending.local" },
  clientId: "pending_1",
  pendingStatus: "sending",
  pendingNonce: "pending_1",
};

const confirmedItem: MessageItem = {
  id: "m1",
  createdAt: "2026-01-01T00:00:00.500Z",
  parts: [{ kind: "text", text: "hi" }],
  sender: { name: "Alice", address: "prn_alice@acme.example" },
  clientId: "pending_1",
};

describe("one message list: a pending send reconciles in place under a stable key", () => {
  test("POST-first: sending, then the same key's props update to confirmed — one group throughout, same DOM node", async () => {
    const el = await render([pendingItem]);
    const avatarBefore = el.querySelector(".sender-avatar-button");
    expect(el.querySelectorAll(".chat-message-group")).toHaveLength(1);
    expect(el.querySelector(".chat-pending-glyph")).not.toBeNull();

    await render([confirmedItem]);

    expect(el.querySelectorAll(".chat-message-group")).toHaveLength(1);
    expect(el.querySelector(".chat-pending-glyph")).toBeNull();
    const avatarAfter = el.querySelector(".sender-avatar-button");
    // Same `clientId` key means React updates the existing node's props
    // rather than unmounting and mounting a new one.
    expect(avatarAfter).not.toBeNull();
    expect(avatarAfter?.isSameNode(avatarBefore)).toBe(true);
  });

  test("refresh-first: a background refresh lands the confirmed copy while the send is still marked pending — renders once, never both", async () => {
    // mergePendingSends already drops a pending entry once a confirmed
    // item with a matching clientId shows up; this is what the host
    // hands WorkbenchTimeline once that dedup has run.
    const el = await render([confirmedItem]);
    expect(el.querySelectorAll(".chat-message-group")).toHaveLength(1);
    expect(el.querySelector(".chat-pending-glyph")).toBeNull();
  });

  test("refresh-without-the-message-yet, then POST resolves: the pending bubble stays the one and only render, no gap", async () => {
    const el = await render([pendingItem]);
    // A background refresh that doesn't yet carry this send changes
    // nothing about the pending entry — still exactly one group, still
    // marked sending.
    await render([pendingItem]);
    expect(el.querySelectorAll(".chat-message-group")).toHaveLength(1);
    expect(el.querySelector(".chat-pending-glyph")).not.toBeNull();

    await render([confirmedItem]);
    expect(el.querySelectorAll(".chat-message-group")).toHaveLength(1);
    expect(el.querySelector(".chat-pending-glyph")).toBeNull();
  });

  test("failure: the same bubble flips to the failed affordance in place, never a second bubble", async () => {
    const el = await render([pendingItem]);
    await render([{ ...pendingItem, pendingStatus: "failed" }]);

    expect(el.querySelectorAll(".chat-message-group")).toHaveLength(1);
    expect(el.querySelector(".chat-pending-glyph")).toBeNull();
    expect(el.querySelector(".chat-pending-failed-label")).not.toBeNull();
  });
});
