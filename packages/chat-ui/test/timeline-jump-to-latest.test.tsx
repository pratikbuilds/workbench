// Jump-to-latest (CL-6424): when the reader has scrolled up from the live
// tail past `BOTTOM_PIN_THRESHOLD_PX` (40px), the timeline offers a control
// that re-pins and jumps to the bottom. There is no such control while
// pinned, on an empty timeline, or when the reader is still within the
// pin threshold.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import { WorkbenchTimeline } from "../src/timeline";

const realResizeObserver = globalThis.ResizeObserver;

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
});

function items(): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "hello" }],
      sender: { name: "Researcher", address: "researcher@agents.example" },
    },
  ];
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(props?: {
  readonly items?: MessageItem[];
  readonly scrollRestore?: {
    readonly scrollTop: number;
    readonly pinned: boolean;
  };
}) {
  globalThis.ResizeObserver =
    NoopResizeObserver as unknown as typeof ResizeObserver;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={props?.items ?? items()}
        {...(props?.scrollRestore !== undefined
          ? { scrollRestore: props.scrollRestore }
          : {})}
      />,
    );
  });
  const scrollEl = container.querySelector(
    ".chat-timeline",
  ) as HTMLElement | null;
  if (scrollEl !== null) {
    Object.defineProperty(scrollEl, "scrollHeight", {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 200,
      configurable: true,
    });
  }
  return { container, scrollEl };
}

function jumpControl(from: HTMLElement): HTMLButtonElement | null {
  return from.querySelector(".chat-jump-to-latest");
}

describe("WorkbenchTimeline jump-to-latest (CL-6424)", () => {
  test("a pinned reader sees no jump-to-latest control", async () => {
    const { container: el } = await mount();
    expect(jumpControl(el)).toBeNull();
  });

  test("scrolling up past the 40px pin threshold reveals jump-to-latest", async () => {
    const { container: el, scrollEl } = await mount();
    expect(scrollEl).not.toBeNull();
    if (scrollEl === null) return;
    act(() => {
      scrollEl.scrollTop = 100;
      scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const button = jumpControl(el);
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Jump to latest");
  });

  test("staying within 40px of the tail keeps the control hidden", async () => {
    const { container: el, scrollEl } = await mount();
    expect(scrollEl).not.toBeNull();
    if (scrollEl === null) return;
    act(() => {
      // distanceFromBottom = 900 - 660 - 200 = 40, still pinned.
      scrollEl.scrollTop = 660;
      scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(jumpControl(el)).toBeNull();
  });

  test("clicking jump-to-latest re-pins to the bottom and hides the control", async () => {
    const { container: el, scrollEl } = await mount();
    expect(scrollEl).not.toBeNull();
    if (scrollEl === null) return;
    act(() => {
      scrollEl.scrollTop = 100;
      scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const button = jumpControl(el);
    expect(button).not.toBeNull();
    act(() => {
      button?.click();
    });
    expect(scrollEl.scrollTop).toBe(900);
    expect(jumpControl(el)).toBeNull();
  });

  test("an unpinned scroll restore shows jump-to-latest on mount", async () => {
    const { container: el } = await mount({
      scrollRestore: { scrollTop: 100, pinned: false },
    });
    expect(jumpControl(el)).not.toBeNull();
  });

  test("an empty timeline never offers jump-to-latest", async () => {
    const { container: el, scrollEl } = await mount({ items: [] });
    expect(scrollEl).toBeNull();
    expect(jumpControl(el)).toBeNull();
    expect(el.textContent).toContain("No messages yet");
  });
});
