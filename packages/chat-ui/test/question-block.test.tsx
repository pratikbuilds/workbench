// DOM tests for the interview-question card: open state (lettered options,
// optional free-text field), answered state (collapsed with a checkmark,
// controls disabled), retry after a failed notify (the route persists the
// answer before notify, so `own` is set with `notifiedAt: null` even when
// submit returns an error — including after remount), persist failure (no
// `own`, open form + generic error), and keyboard navigation over the
// option buttons (native tab order — no custom key handling needed since
// each option is a plain `<button>`).
// Mirrors `poll-block.test.tsx`'s stateful-fake pattern: the render always
// reflects the last `getResponses` read, never a click's own optimistic guess.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  BlockResponseActions,
  BlockResponseQuery,
} from "../src/blocks/block-responses";
import type { MessageItem } from "../src/api";
import { CHAT_STRINGS } from "../src/strings";
import { WorkbenchTimeline } from "../src/timeline";

function messageWithQuestionBlock(allowFreeText = false): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          kind: "block",
          block: {
            type: "question",
            data: {
              questionId: "blk_q1",
              question: "Which environment should this deploy to?",
              subtitle: "Pick the closest match.",
              options: ["Staging", "Production", "Canary"],
              allowFreeText,
            },
          },
        },
      ],
      sender: { name: "Researcher", address: "researcher@agents.example" },
    },
  ];
}

function fakeBackend(opts?: {
  readonly failSubmits?: number;
  readonly persistFails?: boolean;
}) {
  let answer: {
    answer: string;
    optionIndex?: number;
    notifiedAt: string | null;
  } | null = null;
  const submitCalls: { answer: string; optionIndex: number | undefined }[] = [];
  let remainingFails = opts?.failSubmits ?? 0;

  const actions: BlockResponseActions = {
    getResponses: async (): Promise<BlockResponseQuery> => ({
      kind: "ready",
      tally: {},
      total: 0,
      own:
        answer === null
          ? null
          : {
              kind: "question",
              answer: answer.answer,
              ...(answer.optionIndex !== undefined
                ? { optionIndex: answer.optionIndex }
                : {}),
              notifiedAt: answer.notifiedAt,
            },
    }),
    submitPoll: async () => ({ kind: "submitted" }),
    submitForm: async () => ({ kind: "submitted" }),
    submitQuestion: async (
      _messageId,
      _blockId,
      submittedAnswer,
      optionIndex,
    ) => {
      submitCalls.push({ answer: submittedAnswer, optionIndex });
      if (opts?.persistFails === true) {
        return { kind: "error", message: "persist_failed" };
      }
      // The route persists the answer before notify; a failed notify still
      // leaves `own` with `notifiedAt: null` on the subsequent GET.
      const failing = remainingFails > 0;
      if (failing) remainingFails -= 1;
      answer = {
        answer: submittedAnswer,
        ...(optionIndex !== undefined ? { optionIndex } : {}),
        notifiedAt: failing ? null : "2026-01-01T00:00:00.000Z",
      };
      if (failing) {
        return { kind: "error", message: "notify_failed" };
      }
      return { kind: "submitted" };
    },
  };

  return { actions, submitCalls };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(actions: BlockResponseActions, allowFreeText = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={messageWithQuestionBlock(allowFreeText)}
        blockResponses={actions}
      />,
    );
  });
  return container;
}

function choiceButton(el: HTMLElement, label: string): HTMLButtonElement {
  const button = [...el.querySelectorAll(".chat-block-question-choice")].find(
    (node) => node.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
  if (button === undefined) throw new Error(`expected ${label}`);
  return button;
}

async function remount(actions: BlockResponseActions, allowFreeText = false) {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  return mount(actions, allowFreeText);
}

describe("question card — open state", () => {
  test("with no port, options render disabled with no answer state", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<WorkbenchTimeline items={messageWithQuestionBlock()} />);
    });

    const buttons = container.querySelectorAll(".chat-block-question-choice");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  test("renders lettered options and the subtitle", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions);

    expect(el.textContent).toContain("Pick the closest match.");
    const buttons = [...el.querySelectorAll(".chat-block-question-choice")];
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.textContent).toContain("A");
    expect(buttons[0]?.textContent).toContain("Staging");
    expect(buttons[1]?.textContent).toContain("B");
    expect(buttons[2]?.textContent).toContain("C");
  });

  test("free-text field renders only when allowFreeText is set", async () => {
    const backend = fakeBackend();
    const withFreeText = await mount(backend.actions, true);
    expect(
      withFreeText.querySelector(".chat-block-question-freetext"),
    ).not.toBeNull();

    const mounted = root;
    if (mounted !== null) act(() => mounted.unmount());
    container?.remove();
    container = null;
    root = null;

    const withoutFreeText = await mount(backend.actions, false);
    expect(
      withoutFreeText.querySelector(".chat-block-question-freetext"),
    ).toBeNull();
  });

  test("options are focusable buttons in document order (native tab nav)", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions);
    const buttons = [
      ...el.querySelectorAll("button.chat-block-question-choice"),
    ] as HTMLButtonElement[];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      expect(button.disabled).toBe(false);
    }
  });
});

describe("question card — answering", () => {
  test("clicking an option submits it and collapses to the answered state with a check", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions);

    await act(async () => {
      choiceButton(el, "Production").click();
    });

    expect(backend.submitCalls).toEqual([
      { answer: "Production", optionIndex: 1 },
    ]);
    expect(el.querySelector('[data-answered="true"]')).not.toBeNull();
    expect(el.querySelector(".chat-block-question-check")).not.toBeNull();
    expect(el.textContent).toContain("Production");
    expect(el.querySelectorAll(".chat-block-question-choice")).toHaveLength(0);
  });

  test("free-text submission collapses to the answered state with no optionIndex", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions, true);

    const input = el.querySelector(
      ".chat-block-question-freetext input",
    ) as HTMLInputElement;
    const form = el.querySelector(
      ".chat-block-question-freetext",
    ) as HTMLFormElement;

    await act(async () => {
      setInputValue(input, "Somewhere else entirely");
    });
    await act(async () => {
      form.requestSubmit();
    });

    expect(backend.submitCalls).toEqual([
      { answer: "Somewhere else entirely", optionIndex: undefined },
    ]);
    expect(el.textContent).toContain("Somewhere else entirely");
    expect(el.querySelector(".chat-block-question-check")).not.toBeNull();
  });

  test("a failed notify keeps a retry so the saved answer can still reach the agent", async () => {
    const backend = fakeBackend({ failSubmits: 1 });
    const el = await mount(backend.actions);

    await act(async () => {
      choiceButton(el, "Production").click();
    });

    expect(backend.submitCalls).toEqual([
      { answer: "Production", optionIndex: 1 },
    ]);
    expect(el.querySelector('[data-answered="true"]')).not.toBeNull();
    expect(el.textContent).toContain("Production");
    expect(el.querySelector(".chat-block-question-check")).toBeNull();
    const alert = el.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe(CHAT_STRINGS.blockQuestionNotifyFailed);

    const retry = el.querySelector(
      "[data-question-retry]",
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    expect(retry?.disabled).toBe(false);

    await act(async () => {
      retry?.click();
    });

    expect(backend.submitCalls).toEqual([
      { answer: "Production", optionIndex: 1 },
      { answer: "Production", optionIndex: 1 },
    ]);
    expect(el.querySelector("[role='alert']")).toBeNull();
    expect(el.querySelector("[data-question-retry]")).toBeNull();
    expect(el.querySelector('[data-answered="true"]')).not.toBeNull();
    expect(el.querySelector(".chat-block-question-check")).not.toBeNull();
    expect(el.querySelectorAll(".chat-block-question-choice")).toHaveLength(0);
  });

  test("remount after notify_failed still offers retry from GET own", async () => {
    const backend = fakeBackend({ failSubmits: 1 });
    const el = await mount(backend.actions);

    await act(async () => {
      choiceButton(el, "Production").click();
    });
    expect(el.querySelector("[data-question-retry]")).not.toBeNull();

    const remounted = await remount(backend.actions);
    expect(remounted.querySelector('[data-answered="true"]')).not.toBeNull();
    expect(remounted.querySelector(".chat-block-question-check")).toBeNull();
    const alert = remounted.querySelector("[role='alert']");
    expect(alert?.textContent).toBe(CHAT_STRINGS.blockQuestionNotifyFailed);
    const retry = remounted.querySelector(
      "[data-question-retry]",
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();

    await act(async () => {
      retry?.click();
    });
    expect(backend.submitCalls).toEqual([
      { answer: "Production", optionIndex: 1 },
      { answer: "Production", optionIndex: 1 },
    ]);
    expect(remounted.querySelector("[data-question-retry]")).toBeNull();
    expect(
      remounted.querySelector(".chat-block-question-check"),
    ).not.toBeNull();
  });

  test("free-text notify-failed retry resubmits the same string without optionIndex", async () => {
    const backend = fakeBackend({ failSubmits: 1 });
    const el = await mount(backend.actions, true);

    const input = el.querySelector(
      ".chat-block-question-freetext input",
    ) as HTMLInputElement;
    const form = el.querySelector(
      ".chat-block-question-freetext",
    ) as HTMLFormElement;

    await act(async () => {
      setInputValue(input, "Somewhere else entirely");
    });
    await act(async () => {
      form.requestSubmit();
    });

    expect(backend.submitCalls).toEqual([
      { answer: "Somewhere else entirely", optionIndex: undefined },
    ]);
    const retry = el.querySelector(
      "[data-question-retry]",
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();

    await act(async () => {
      retry?.click();
    });

    expect(backend.submitCalls).toEqual([
      { answer: "Somewhere else entirely", optionIndex: undefined },
      { answer: "Somewhere else entirely", optionIndex: undefined },
    ]);
    expect(el.querySelector("[data-question-retry]")).toBeNull();
  });

  test("persist failure with no own still shows the open form and a generic error", async () => {
    const backend = fakeBackend({ persistFails: true });
    const el = await mount(backend.actions);

    await act(async () => {
      choiceButton(el, "Production").click();
    });

    expect(backend.submitCalls).toEqual([
      { answer: "Production", optionIndex: 1 },
    ]);
    expect(el.querySelector('[data-answered="true"]')).toBeNull();
    expect(el.querySelector("[data-question-retry]")).toBeNull();
    expect(el.querySelectorAll(".chat-block-question-choice")).toHaveLength(3);
    const alert = el.querySelector("[role='alert']");
    expect(alert?.textContent).toBe(CHAT_STRINGS.blockQuestionAnswerError);
  });
});
