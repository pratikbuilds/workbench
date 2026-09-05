// DOM tests for CL-6332/CL-6376's failed-turn strip: the server's
// undelivered-turn notice (`postUndeliveredNotice`, `@corbits/chat`'s
// `workbench-service.ts`) marks its text part `turnFailed: true`; the
// general chat timeline renders that part as its own quiet inline system
// row (`.chat-turn-failed`, CL-6376) instead of an ordinary text bubble —
// or, before the CL-6376 redesign, `PrFailedTurnStrip`'s bordered banner.
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import { WorkbenchTimeline } from "../src/timeline";

if (typeof document === "undefined") {
  GlobalRegistrator.register();
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function failedTurnItem(): MessageItem[] {
  return [
    {
      id: "msg_ok",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "hi @echo" }],
      sender: { name: null, address: "prn_alice@agents.example" },
    },
    {
      id: "msg_notice",
      createdAt: "2026-01-01T00:00:05.000Z",
      parts: [
        {
          kind: "text",
          text: "I didn't get that one — send it again and I'll pick it up.",
          turnFailed: true,
        },
      ],
      sender: { name: null, address: "ins_echo1@agents.example" },
    },
  ];
}

describe("the failed-turn notice renders through PrFailedTurnStrip", () => {
  test("shows the strip, not a plain text bubble, for the agent's own address", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedTurnItem()}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
        />,
      );
    });

    const strip = container.querySelector(".chat-turn-failed");
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute("role")).toBe("status");
    expect(strip?.textContent).toContain("Echo");
    expect(strip?.textContent).toContain("didn't reply");

    // Never the old bordered-banner treatment.
    expect(container.querySelector(".chat-pr-failed")).toBeNull();

    // The notice never renders as an ordinary bubble alongside the strip.
    const bubbles = container.querySelectorAll(".chat-bubble");
    expect(
      [...bubbles].some((bubble) =>
        bubble.textContent?.includes("send it again"),
      ),
    ).toBe(false);
  });

  test("Retry and what-happened invoke the host's own actions with the failed item", async () => {
    const retried: string[] = [];
    const whatHappened: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedTurnItem()}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
          onRetryFailedTurn={(item) => {
            retried.push(item.id);
          }}
          onWhatHappenedFailedTurn={(item) => whatHappened.push(item.id)}
        />,
      );
    });

    const buttons = container.querySelectorAll(".chat-turn-failed button");
    expect(buttons).toHaveLength(2);
    act(() => {
      (buttons[0] as HTMLButtonElement).click();
    });
    act(() => {
      (buttons[1] as HTMLButtonElement).click();
    });

    expect(retried).toEqual(["msg_notice"]);
    expect(whatHappened).toEqual(["msg_notice"]);
  });

  test("an ordinary text part with no turnFailed flag still renders as a plain bubble", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={[
            {
              id: "msg_ok",
              createdAt: "2026-01-01T00:00:00.000Z",
              parts: [{ kind: "text", text: "hello" }],
              sender: { name: null, address: "prn_alice@agents.example" },
            },
          ]}
        />,
      );
    });

    expect(container.querySelector(".chat-turn-failed")).toBeNull();
    expect(container.querySelector(".chat-bubble")).not.toBeNull();
  });

  test("the expanded detail shows the notice's own cause-aware text, not a generic guess", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const items: MessageItem[] = [
      {
        id: "msg_ok",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi @echo" }],
        sender: { name: null, address: "prn_alice@agents.example" },
      },
      {
        id: "msg_notice",
        createdAt: "2026-01-01T00:00:05.000Z",
        parts: [
          {
            kind: "text",
            text: "I can't reach a model right now — add or check your model key in Settings, then I'll pick this up.",
            turnFailed: true,
          },
        ],
        sender: { name: null, address: "ins_echo1@agents.example" },
      },
    ];
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={items}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
        />,
      );
    });

    act(() => {
      container
        ?.querySelector(".chat-turn-failed-disclosure")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const detail = container.querySelector(".chat-turn-failed-detail");
    expect(detail?.textContent).toBe(
      "I can't reach a model right now — add or check your model key in Settings, then I'll pick this up.",
    );
    // Never the fixed guess this strip used to always show, regardless of cause.
    expect(detail?.textContent).not.toBe(
      "No reply arrived — the agent may be unavailable.",
    );
  });

  test("the expanded detail never shows HTTP status or a raw provider dump", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const items: MessageItem[] = [
      {
        id: "msg_ok",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi @echo" }],
        sender: { name: null, address: "prn_alice@agents.example" },
      },
      {
        id: "msg_notice",
        createdAt: "2026-01-01T00:00:05.000Z",
        parts: [
          {
            kind: "text",
            text: "This agent could not complete your request due to a credential error [HTTP 401]: API key is invalid.",
            turnFailed: true,
          },
        ],
        sender: { name: null, address: "ins_echo1@agents.example" },
      },
    ];
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={items}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
        />,
      );
    });

    act(() => {
      container
        ?.querySelector(".chat-turn-failed-disclosure")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const detail = container.querySelector(".chat-turn-failed-detail");
    expect(detail?.textContent).toBe(
      "This didn't go through. Try again, or check the connection in Settings.",
    );
    expect(detail?.textContent).not.toMatch(/credential error/i);
    expect(detail?.textContent).not.toMatch(/\[HTTP/);
    expect(detail?.textContent).not.toContain("401");
    expect(detail?.textContent).not.toContain("API key is invalid");
  });

  test("Retry auto-resends the recovered request text — no composer round trip", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const retried: (string | undefined)[] = [];
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedTurnItem()}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
          onRetryFailedTurn={(_item, retryText) => {
            retried.push(retryText);
          }}
        />,
      );
    });

    act(() => {
      (
        container?.querySelector(".chat-turn-failed-retry") as HTMLButtonElement
      ).click();
    });

    // The strip hands the recovered text straight to the host's resend
    // action — the host (chat-workspace.tsx) sends it through the normal
    // send path itself; the strip never touches a composer.
    expect(retried).toEqual(["hi @echo"]);
  });

  test("Retry disables itself while the resend is in flight, and re-enables once it settles", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const calls: (string | undefined)[] = [];
    let resolveSend: (() => void) | undefined;
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedTurnItem()}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
          onRetryFailedTurn={(_item, retryText) => {
            calls.push(retryText);
            return new Promise<void>((resolve) => {
              resolveSend = resolve;
            });
          }}
        />,
      );
    });

    const retryButton = () =>
      container?.querySelector(".chat-turn-failed-retry") as HTMLButtonElement;

    act(() => {
      retryButton().click();
    });
    // A second click while the first resend is still in flight must not
    // fire a second send.
    act(() => {
      retryButton().click();
    });

    expect(calls).toEqual(["hi @echo"]);
    expect(retryButton().disabled).toBe(true);

    await act(async () => {
      resolveSend?.();
      await Promise.resolve();
    });

    expect(retryButton().disabled).toBe(false);
  });

  test("a model-unavailable notice shows named copy, a picker, and a real Settings hop", async () => {
    const applied: string[] = [];
    const retried: (string | undefined)[] = [];
    const opened: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={[
            {
              id: "msg_ok",
              createdAt: "2026-01-01T00:00:00.000Z",
              parts: [{ kind: "text", text: "hi @echo" }],
              sender: { name: null, address: "prn_alice@agents.example" },
            },
            {
              id: "msg_notice",
              createdAt: "2026-01-01T00:00:05.000Z",
              parts: [
                {
                  kind: "text",
                  text: "This agent's model isn't available here. (ref abc)",
                  turnFailed: true,
                  turnFailedReason: "model_unavailable",
                },
              ],
              sender: { name: "Jimmy", address: "ins_echo1@agents.example" },
            },
          ]}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
          failedTurnRecovery={{
            models: [
              { canonicalName: "anthropic/claude-sonnet", label: "Sonnet" },
              { canonicalName: "openai/gpt-4.1", label: "GPT-4.1" },
              { canonicalName: "google/gemini-2.5-pro", label: "Gemini" },
            ],
            definitionIdByAddress: {
              "ins_echo1@agents.example": "wfd_echo",
            },
            onApplyModel: ({ canonicalName }) => {
              applied.push(canonicalName);
            },
            onOpenAgentSettings: (definitionId) => {
              opened.push(definitionId);
            },
          }}
          onRetryFailedTurn={(_item, retryText) => {
            retried.push(retryText);
          }}
        />,
      );
    });

    const strip = container.querySelector(".chat-turn-failed");
    expect(strip?.textContent).toContain("Jimmy's model isn't available here.");
    expect(strip?.textContent).not.toContain("didn't reply");
    expect(strip?.textContent).not.toMatch(/HTTP/);
    expect(strip?.textContent).not.toContain("wfd_echo");
    expect(container.querySelector(".chat-turn-failed-retry")).toBeNull();

    const select = container.querySelector(
      ".chat-turn-failed-models",
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Pick a model",
      "Sonnet",
      "GPT-4.1",
      "Gemini",
    ]);

    await act(async () => {
      select.value = "openai/gpt-4.1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(applied).toEqual(["openai/gpt-4.1"]);
    expect(retried).toEqual(["hi @echo"]);

    act(() => {
      (
        container?.querySelector(
          ".chat-turn-failed-settings",
        ) as HTMLButtonElement
      ).click();
    });
    expect(opened).toEqual(["wfd_echo"]);
  });

  test("a tools-unsupported notice shows honest copy, a tool-capable picker, and More in Settings", async () => {
    const applied: string[] = [];
    const retried: (string | undefined)[] = [];
    const opened: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={[
            {
              id: "msg_ok",
              createdAt: "2026-01-01T00:00:00.000Z",
              parts: [{ kind: "text", text: "hi @echo" }],
              sender: { name: null, address: "prn_alice@agents.example" },
            },
            {
              id: "msg_notice",
              createdAt: "2026-01-01T00:00:05.000Z",
              parts: [
                {
                  kind: "text",
                  text: "This agent's model can't use tools. (ref abc)",
                  turnFailed: true,
                  turnFailedReason: "tools_unsupported",
                },
              ],
              sender: { name: "Jimmy", address: "ins_echo1@agents.example" },
            },
          ]}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
          failedTurnRecovery={{
            models: [
              { canonicalName: "openai/gpt-4.1", label: "GPT-4.1" },
              { canonicalName: "google/gemini-2.5-flash", label: "Flash" },
            ],
            toolCapableModels: [
              { canonicalName: "anthropic/claude-sonnet", label: "Sonnet" },
              { canonicalName: "openai/gpt-4.1", label: "GPT-4.1" },
            ],
            definitionIdByAddress: {
              "ins_echo1@agents.example": "wfd_echo",
            },
            onApplyModel: ({ canonicalName }) => {
              applied.push(canonicalName);
            },
            onOpenAgentSettings: (definitionId) => {
              opened.push(definitionId);
            },
          }}
          onRetryFailedTurn={(_item, retryText) => {
            retried.push(retryText);
          }}
        />,
      );
    });

    const strip = container.querySelector(".chat-turn-failed");
    expect(strip?.textContent).toContain("Jimmy's model can't use tools.");
    expect(strip?.textContent).not.toContain("didn't reply");
    expect(strip?.textContent).not.toContain("isn't available here");
    expect(strip?.textContent).not.toMatch(/HTTP/);
    expect(strip?.textContent).not.toContain("function-calling");
    expect(strip?.textContent).not.toContain("wfd_echo");
    expect(container.querySelector(".chat-turn-failed-retry")).toBeNull();

    const select = container.querySelector(
      ".chat-turn-failed-models",
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Pick a model",
      "Sonnet",
      "GPT-4.1",
    ]);
    expect(
      [...select.options].map((option) => option.textContent),
    ).not.toContain("Flash");

    await act(async () => {
      select.value = "anthropic/claude-sonnet";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(applied).toEqual(["anthropic/claude-sonnet"]);
    expect(retried).toEqual(["hi @echo"]);

    const settings = container.querySelector(
      ".chat-turn-failed-settings",
    ) as HTMLButtonElement;
    expect(settings.textContent).toBe("More in Settings");
    act(() => {
      settings.click();
    });
    expect(opened).toEqual(["wfd_echo"]);
  });
});
