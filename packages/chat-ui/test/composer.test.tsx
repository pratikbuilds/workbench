import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as errorSink from "@corbits/error-sink";

import { Composer } from "../src/composer";
import type { ComposerHandle, ComposerSendPayload } from "../src/composer";

// The in-flight send contract survives the icon-only UI: its accessible name
// announces progress and the action remains unavailable until sending ends.
let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function mount(onSend: () => Promise<boolean>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<ComposerHandle>();
  act(() => {
    root?.render(
      createElement(Composer, {
        ref,
        agents: [],
        onSend,
        onInviteAgent: () => undefined,
        onOpenAgentsSettings: () => undefined,
        onCreateRoutineInSpace: () => undefined,
      }),
    );
  });
  return container;
}

function sendButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(
    '[aria-label^="Send"]',
  );
  if (button === null || button === undefined) {
    throw new Error("send button not found");
  }
  return button;
}

function keyboardHint(): Element | null {
  return container?.querySelector(".chat-composer-keyboard-hint") ?? null;
}

describe("Composer send button", () => {
  test("updates its accessible label and stays disabled while sending", async () => {
    let resolveSend: (value: boolean) => void = () => undefined;
    const onSend = () =>
      new Promise<boolean>((resolve) => {
        resolveSend = resolve;
      });
    mount(onSend);

    const textarea = container?.querySelector("textarea");
    if (textarea === null || textarea === undefined) {
      throw new Error("composer textarea not found");
    }
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "hello there");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    expect(sendButton().getAttribute("aria-label")).toBe("Send");

    act(() => {
      sendButton().click();
    });
    await settle();

    expect(sendButton().getAttribute("aria-label")).toBe("Sending…");
    expect(sendButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveSend(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendButton().getAttribute("aria-label")).toBe("Send");
  });
});

test("labels the icon-only attachment action in the composer rail", () => {
  mount(() => Promise.resolve(true));

  expect(
    container?.querySelector('[aria-label="Attach files"]')?.textContent,
  ).toBe("");
});

function textarea(): HTMLTextAreaElement {
  const element = container?.querySelector("textarea");
  if (element === null || element === undefined) {
    throw new Error("composer textarea not found");
  }
  return element;
}

function typeInto(element: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function mountWithMentions(
  onSend: (payload: ComposerSendPayload) => Promise<boolean>,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<ComposerHandle>();
  act(() => {
    root?.render(
      createElement(Composer, {
        ref,
        agents: [],
        participants: [
          { address: "researcher@agents.example", handle: "researcher" },
        ],
        members: [{ id: "prn_bob", displayName: "Bob" }],
        invitableAgents: [
          { id: "wfd_echo", name: "echo", description: "Echo" },
        ],
        onSend,
        onInviteAgent: () => undefined,
        onOpenAgentsSettings: () => undefined,
        onCreateRoutineInSpace: () => undefined,
      }),
    );
  });
  return container;
}

describe("Composer mention popover — Agents and People (CL-5879)", () => {
  test("renders Agents and People sections with name and @handle", async () => {
    mountWithMentions(() => Promise.resolve(true));
    typeInto(textarea(), "@");
    await settle();

    const options = Array.from(
      container?.querySelectorAll(".chat-mention-option") ?? [],
    );
    const rows = options.map((option) => ({
      name: option.querySelector(".chat-mention-name")?.textContent,
      handle: option.querySelector(".chat-mention-handle")?.textContent,
      section: option.getAttribute("data-mention-section"),
    }));
    expect(rows).toEqual([
      { name: "Researcher", handle: "@researcher", section: "agents" },
      { name: "echo", handle: "@echo", section: "agents" },
      { name: "Bob", handle: "@bob", section: "people" },
    ]);

    const groupLabels = Array.from(
      container?.querySelectorAll(".chat-mention-group-label") ?? [],
    ).map((label) => label.textContent);
    expect(groupLabels).toEqual(["Agents", "People"]);
  });

  test("picking a not-yet-participant candidate inserts the mention and marks invite intent on send", async () => {
    const sent: { payload: ComposerSendPayload | null } = { payload: null };
    mountWithMentions((payload) => {
      sent.payload = payload;
      return Promise.resolve(true);
    });
    typeInto(textarea(), "@bo");
    await settle();

    const options = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".chat-mention-option") ??
        [],
    );
    const bobOption = options.find(
      (option) =>
        option.querySelector(".chat-mention-handle")?.textContent === "@bob",
    );
    if (bobOption === undefined) throw new Error("bob option not found");
    act(() => {
      bobOption.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(textarea().value).toBe("@bob ");

    act(() => {
      sendButton().click();
    });
    await settle();

    if (sent.payload === null) throw new Error("payload not sent");
    expect(sent.payload.invite).toEqual([
      { kind: "person", principalId: "prn_bob", name: "Bob" },
    ]);
  });

  test("picking an existing-participant candidate marks no invite intent", async () => {
    const sent: { payload: ComposerSendPayload | null } = { payload: null };
    mountWithMentions((payload) => {
      sent.payload = payload;
      return Promise.resolve(true);
    });
    typeInto(textarea(), "@res");
    await settle();

    const options = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".chat-mention-option") ??
        [],
    );
    const researcherOption = options.find(
      (option) =>
        option.querySelector(".chat-mention-handle")?.textContent ===
        "@researcher",
    );
    if (researcherOption === undefined) {
      throw new Error("researcher option not found");
    }
    act(() => {
      researcherOption.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    act(() => {
      sendButton().click();
    });
    await settle();

    if (sent.payload === null) throw new Error("payload not sent");
    expect(sent.payload.invite).toBeUndefined();
  });
});

describe("Composer keyboard hint", () => {
  test("uses the existing action rail and appears only for a focused non-empty draft", async () => {
    mount(() => Promise.resolve(true));
    expect(keyboardHint()).not.toBeNull();
    expect(keyboardHint()?.getAttribute("data-visible")).toBe("false");
    expect(keyboardHint()?.getAttribute("aria-hidden")).toBe("true");

    act(() => {
      textarea().focus();
    });
    typeInto(textarea(), "hello");
    await settle();

    expect(keyboardHint()?.getAttribute("data-visible")).toBe("true");
    expect(keyboardHint()?.getAttribute("aria-hidden")).toBe("false");
    expect(keyboardHint()?.textContent).toBe("Enter to send");
    expect(
      container?.querySelectorAll(".chat-composer-actions button").length,
    ).toBe(2);
    expect(container?.querySelector(".chat-composer-row > textarea")).toBe(
      textarea(),
    );
  });

  test("hides when the focused draft is cleared", async () => {
    mount(() => Promise.resolve(true));
    act(() => {
      textarea().focus();
    });
    typeInto(textarea(), "hello");
    await settle();
    expect(keyboardHint()?.getAttribute("data-visible")).toBe("true");

    typeInto(textarea(), "");
    await settle();
    expect(keyboardHint()?.getAttribute("data-visible")).toBe("false");
    expect(keyboardHint()?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Composer growth containment (CL-6250)", () => {
  test("the textarea carries the max-height/overflow class and keeps applying its measured inline height", async () => {
    mount(() => Promise.resolve(true));
    expect(textarea().className).toContain("chat-composer-input");

    typeInto(textarea(), "line one\nline two\nline three");
    await settle();
    // The auto-grow effect still measures and writes an inline height on
    // every change — the CSS transition added for CL-6250 smooths that
    // write, it does not replace it.
    expect(textarea().style.height.endsWith("px")).toBe(true);
  });
});

describe("Composer popover entrance (CL-6250)", () => {
  test("the slash popover carries the entrance class", async () => {
    mount(() => Promise.resolve(true));
    typeInto(textarea(), "/");
    await settle();
    const popover = container?.querySelector(".chat-mention-popover");
    expect(popover?.classList.contains("chat-popover-enter")).toBe(true);
  });

  test("the mention popover carries the entrance class", async () => {
    mountWithMentions(() => Promise.resolve(true));
    typeInto(textarea(), "@");
    await settle();
    const popover = container?.querySelector(".chat-mention-popover");
    expect(popover?.classList.contains("chat-popover-enter")).toBe(true);
  });
});

describe("Composer hit targets (CL-6250)", () => {
  test("attach and send buttons carry the extended-hit-area class", () => {
    mount(() => Promise.resolve(true));
    const buttons = container?.querySelectorAll(".chat-composer-icon-button");
    expect(buttons?.length).toBe(2);
  });
});

describe("Composer mention bring-in load error (CL-6839)", () => {
  function mountWithBringInError(bringInLoadError: string) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          agents: [],
          participants: [],
          members: [],
          invitableAgents: [],
          bringInLoadError,
          onSend: () => Promise.resolve(true),
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });
  }

  test("shows the load error instead of an honest empty 'No matches' list", async () => {
    mountWithBringInError("Couldn't load people and agents to bring in");
    typeInto(textarea(), "@");
    await settle();

    const empty = container?.querySelector(".chat-mention-empty");
    expect(empty?.getAttribute("role")).toBe("alert");
    expect(empty?.textContent).toBe(
      "Couldn't load people and agents to bring in",
    );
    expect(container?.textContent).not.toContain("No matches");
  });

  test("keeps in-workbench matches visible and still surfaces the bring-in error", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          agents: [],
          participants: [
            { address: "researcher@agents.example", handle: "researcher" },
          ],
          members: [],
          invitableAgents: [],
          bringInLoadError: "Couldn't load agents to bring in",
          onSend: () => Promise.resolve(true),
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });
    typeInto(textarea(), "@");
    await settle();

    const alert = container?.querySelector('.chat-mention-empty[role="alert"]');
    expect(alert?.textContent).toBe("Couldn't load agents to bring in");
    const handles = Array.from(
      container?.querySelectorAll(".chat-mention-handle") ?? [],
    ).map((node) => node.textContent);
    expect(handles).toEqual(["@researcher"]);
  });
});

describe("ComposerHandle.setText", () => {
  test("replaces the existing draft and focuses with the caret at the end", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const ref = createRef<ComposerHandle>();
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          onSend: () => Promise.resolve(true),
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    typeInto(textarea(), "unsent draft");
    await settle();
    expect(textarea().value).toBe("unsent draft");

    await act(async () => {
      ref.current?.setText("previous prompt");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });

    expect(textarea().value).toBe("previous prompt");
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBe("previous prompt".length);
    expect(textarea().selectionEnd).toBe("previous prompt".length);
  });

  test("Enter after setText sends the copied prompt instead of running a slash command", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const ref = createRef<ComposerHandle>();
    const sent: ComposerSendPayload[] = [];
    let inviteAgentCalls = 0;
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          onSend: (payload) => {
            sent.push(payload);
            return Promise.resolve(true);
          },
          onInviteAgent: () => {
            inviteAgentCalls += 1;
          },
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    typeInto(textarea(), "/");
    await settle();
    expect(container?.querySelector(".chat-mention-popover")).not.toBeNull();

    await act(async () => {
      ref.current?.setText("copied prompt");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    await settle();

    expect(textarea().value).toBe("copied prompt");
    expect(container?.querySelector(".chat-mention-popover")).toBeNull();

    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(inviteAgentCalls).toBe(0);
    expect(sent).toEqual([{ text: "copied prompt", attachments: [] }]);
  });

  test("Enter after setText of an @handle prompt sends instead of opening mention", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const ref = createRef<ComposerHandle>();
    const sent: ComposerSendPayload[] = [];
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          participants: [
            { address: "researcher@agents.example", handle: "researcher" },
          ],
          onSend: (payload) => {
            sent.push(payload);
            return Promise.resolve(true);
          },
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    await act(async () => {
      ref.current?.setText("@researcher");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    await settle();

    expect(container?.querySelector(".chat-mention-popover")).toBeNull();

    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(sent).toEqual([{ text: "@researcher", attachments: [] }]);
  });

  test("Send after setText does not carry leftover bring-in invite intent", async () => {
    const sent: { payload: ComposerSendPayload | null } = { payload: null };
    const ref = createRef<ComposerHandle>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          participants: [
            { address: "researcher@agents.example", handle: "researcher" },
          ],
          members: [{ id: "prn_bob", displayName: "Bob" }],
          invitableAgents: [
            { id: "wfd_echo", name: "echo", description: "Echo" },
          ],
          onSend: (payload) => {
            sent.payload = payload;
            return Promise.resolve(true);
          },
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    typeInto(textarea(), "@bo");
    await settle();
    const options = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".chat-mention-option") ??
        [],
    );
    const bobOption = options.find(
      (option) =>
        option.querySelector(".chat-mention-handle")?.textContent === "@bob",
    );
    if (bobOption === undefined) throw new Error("bob option not found");
    act(() => {
      bobOption.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(textarea().value).toBe("@bob ");

    await act(async () => {
      ref.current?.setText("copied prompt");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    await settle();

    act(() => {
      sendButton().click();
    });
    await settle();

    if (sent.payload === null) throw new Error("payload not sent");
    expect(sent.payload.text).toBe("copied prompt");
    expect(sent.payload.invite).toBeUndefined();
  });

  test("Send after setText does not carry leftover attachments", async () => {
    const sent: ComposerSendPayload[] = [];
    const ref = createRef<ComposerHandle>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          onSend: (payload) => {
            sent.push(payload);
            return Promise.resolve(true);
          },
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    const fileInput = container.querySelector<HTMLInputElement>(
      ".chat-composer-file-input",
    );
    if (fileInput === null) throw new Error("file input not found");

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: {
        0: file,
        length: 1,
        item: (index: number) => (index === 0 ? file : null),
        [Symbol.iterator]: function* () {
          yield file;
        },
      },
    });
    act(() => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    await settle();
    expect(
      container.querySelector(".chat-composer-attachments"),
    ).not.toBeNull();

    await act(async () => {
      ref.current?.setText("copied prompt");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    await settle();

    expect(container.querySelector(".chat-composer-attachments")).toBeNull();

    act(() => {
      sendButton().click();
    });
    await settle();

    expect(sent).toEqual([{ text: "copied prompt", attachments: [] }]);
  });
});

// CL-7201: the composer's Stop affordance. `handleStop` guards against a
// double-click and re-enables itself once the host reports the turn is
// no longer running -- but a REJECTED stop request must also re-enable
// it, or a genuinely failed cancel (not a slow one) leaves the person
// with a permanently disabled button and no way to retry for the rest
// of that turn's life (Critique finding, CL-7201).
function stopButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(
    '[aria-label="Stop"]',
  );
  if (button === null || button === undefined) {
    throw new Error("stop button not found");
  }
  return button;
}

function mountStoppable(
  running: boolean,
  onStop: () => void | Promise<unknown>,
  onSend: (payload: ComposerSendPayload) => Promise<boolean> = () =>
    Promise.resolve(true),
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(Composer, {
        agents: [],
        onSend,
        onInviteAgent: () => undefined,
        onOpenAgentsSettings: () => undefined,
        onCreateRoutineInSpace: () => undefined,
        running,
        onStop,
      }),
    );
  });
  return {
    container,
    rerender: (nextRunning: boolean) => {
      act(() => {
        root?.render(
          createElement(Composer, {
            agents: [],
            onSend,
            onInviteAgent: () => undefined,
            onOpenAgentsSettings: () => undefined,
            onCreateRoutineInSpace: () => undefined,
            running: nextRunning,
            onStop,
          }),
        );
      });
    },
  };
}

describe("Composer stop affordance (CL-7201)", () => {
  test("keeps Stop and Send together in the right-aligned action group", () => {
    mountStoppable(true, () => undefined);

    const actions = container?.querySelector(".chat-composer-actions");
    const submitActions = stopButton().parentElement;
    expect(actions?.children).toHaveLength(3);
    expect(
      submitActions?.classList.contains("chat-composer-submit-actions"),
    ).toBe(true);
    expect(submitActions?.children).toHaveLength(2);
    expect(submitActions?.lastElementChild).toBe(sendButton());
    expect(actions?.lastElementChild).toBe(submitActions);
  });

  test("gives Stop and Send distinct accessible names while both are visible", () => {
    mountStoppable(true, () => undefined);

    expect(stopButton().getAttribute("aria-label")).toBe("Stop");
    expect(sendButton().getAttribute("aria-label")).toBe("Send");
  });

  test("keeps queued sends available while Stop is visible", async () => {
    const sent: ComposerSendPayload[] = [];
    mountStoppable(
      true,
      () => undefined,
      (payload) => {
        sent.push(payload);
        return Promise.resolve(true);
      },
    );

    typeInto(textarea(), "follow-up");
    await settle();

    expect(sendButton().hasAttribute("disabled")).toBe(false);
    act(() => {
      sendButton().click();
    });
    await settle();

    expect(sent).toEqual([{ text: "follow-up", attachments: [] }]);
  });

  test("renders no Stop button when no turn is running", () => {
    mountStoppable(false, () => undefined);
    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
  });

  test("clicking Stop calls onStop and disables the button against a double-click", async () => {
    let calls = 0;
    mountStoppable(true, () => {
      calls += 1;
    });

    expect(stopButton().hasAttribute("disabled")).toBe(false);
    act(() => {
      stopButton().click();
    });
    await settle();

    expect(calls).toBe(1);
    expect(stopButton().hasAttribute("disabled")).toBe(true);

    act(() => {
      stopButton().click();
    });
    await settle();
    expect(calls).toBe(1);
  });

  test("the button re-enables once the host reports the turn is no longer running", async () => {
    const { rerender } = mountStoppable(true, () => undefined);
    act(() => {
      stopButton().click();
    });
    await settle();
    expect(stopButton().hasAttribute("disabled")).toBe(true);

    rerender(false);
    expect(container?.querySelector('[aria-label="Stop"]')).toBeNull();
  });

  test("a stop request that REJECTS re-enables the button instead of leaving it stuck", async () => {
    let reject: (err: unknown) => void = () => undefined;
    mountStoppable(
      true,
      () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        }),
    );

    act(() => {
      stopButton().click();
    });
    await settle();
    expect(stopButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      reject(new Error("network error"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The turn is still running (the cancel request itself failed, not
    // the turn) -- the button must come back so the user can try again.
    expect(stopButton().hasAttribute("disabled")).toBe(false);
  });
});

describe("Composer dictate", () => {
  const recognitions: FakeSpeechRecognition[] = [];

  class FakeSpeechRecognition {
    continuous = false;
    interimResults = false;
    onresult: ((event: { results: FakeSpeechResult[] }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    resultOnStop: readonly { isFinal: boolean; transcript: string }[] | null =
      null;

    constructor() {
      recognitions.push(this);
    }

    start() {
      this.started = true;
    }

    stop() {
      this.started = false;
      if (this.resultOnStop !== null) {
        this.emit(this.resultOnStop);
        this.resultOnStop = null;
      }
      this.onend?.();
    }

    abort() {
      this.started = false;
      this.onend?.();
    }

    emit(segments: readonly { isFinal: boolean; transcript: string }[]) {
      const results = segments.map((segment) => ({
        isFinal: segment.isFinal,
        length: 1,
        0: { transcript: segment.transcript },
      }));
      this.onresult?.({ results });
    }
  }

  type FakeSpeechResult = {
    readonly isFinal: boolean;
    readonly length: number;
    readonly 0: { readonly transcript: string };
  };

  function installSpeechRecognition() {
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      writable: true,
      value: FakeSpeechRecognition,
    });
  }

  afterEach(() => {
    recognitions.length = 0;
    Reflect.deleteProperty(window, "SpeechRecognition");
  });

  test("hides the dictate control when speech recognition is unavailable", () => {
    mount(() => Promise.resolve(true));
    expect(container?.querySelector('[aria-label="Dictate"]')).toBeNull();
  });

  test("starts recognition, inserts a transcript on a word boundary, and stops", async () => {
    installSpeechRecognition();
    mount(() => Promise.resolve(true));
    typeInto(textarea(), "hello");
    textarea().setSelectionRange(5, 5);
    await settle();

    const dictate = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate"]',
    );
    if (dictate === null || dictate === undefined) {
      throw new Error("dictate button not found");
    }

    act(() => {
      dictate.click();
    });
    await settle();

    expect(recognitions.at(-1)?.started).toBe(true);
    expect(recognitions.at(-1)?.continuous).toBe(true);
    expect(recognitions.at(-1)?.interimResults).toBe(true);
    expect(dictate.getAttribute("aria-label")).toBe("Stop dictating");
    expect(dictate.getAttribute("aria-pressed")).toBe("true");
    expect(dictate.getAttribute("data-listening")).toBe("true");

    act(() => {
      recognitions.at(-1)?.emit([{ isFinal: true, transcript: "world" }]);
    });
    await settle();

    expect(textarea().value).toBe("hello world");

    act(() => {
      dictate.click();
    });
    await settle();

    expect(recognitions.at(-1)?.started).toBe(false);
    const idle = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate"]',
    );
    expect(idle?.getAttribute("aria-pressed")).toBe("false");
    expect(idle?.getAttribute("data-listening")).toBe("false");
  });

  test("user Stop flushes a late final result into the draft", async () => {
    installSpeechRecognition();
    mount(() => Promise.resolve(true));
    typeInto(textarea(), "hello");
    textarea().setSelectionRange(5, 5);
    await settle();

    const dictate = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate"]',
    );
    if (dictate === null || dictate === undefined) {
      throw new Error("dictate button not found");
    }

    act(() => {
      dictate.click();
    });
    await settle();

    const rec = recognitions.at(-1);
    if (rec === undefined) {
      throw new Error("speech recognition was not constructed");
    }
    rec.resultOnStop = [{ isFinal: true, transcript: "world" }];

    act(() => {
      dictate.click();
    });
    await settle();

    expect(textarea().value).toBe("hello world");
    expect(rec.started).toBe(false);
  });

  test("send while listening does not restore the draft from a late final result", async () => {
    installSpeechRecognition();
    const sent: ComposerSendPayload[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          agents: [],
          onSend: (payload) => {
            sent.push(payload);
            return Promise.resolve(true);
          },
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });
    typeInto(textarea(), "hello");
    textarea().setSelectionRange(5, 5);
    await settle();

    const dictate = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate"]',
    );
    if (dictate === null || dictate === undefined) {
      throw new Error("dictate button not found");
    }

    act(() => {
      dictate.click();
    });
    await settle();

    const rec = recognitions.at(-1);
    if (rec === undefined) {
      throw new Error("speech recognition was not constructed");
    }
    rec.resultOnStop = [{ isFinal: true, transcript: "late words" }];

    act(() => {
      sendButton().click();
    });
    await settle();

    act(() => {
      rec.emit([{ isFinal: true, transcript: "late words" }]);
    });
    await settle();

    expect(textarea().value).toBe("");
    expect(sent).toEqual([{ text: "hello", attachments: [] }]);
  });

  test("Enter while listening does not restore the draft from a late final result", async () => {
    installSpeechRecognition();
    const sent: ComposerSendPayload[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          agents: [],
          onSend: (payload) => {
            sent.push(payload);
            return Promise.resolve(true);
          },
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });
    typeInto(textarea(), "hello");
    textarea().setSelectionRange(5, 5);
    await settle();

    const dictate = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate"]',
    );
    if (dictate === null || dictate === undefined) {
      throw new Error("dictate button not found");
    }

    act(() => {
      dictate.click();
    });
    await settle();

    const rec = recognitions.at(-1);
    if (rec === undefined) {
      throw new Error("speech recognition was not constructed");
    }
    rec.resultOnStop = [{ isFinal: true, transcript: "late words" }];

    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    act(() => {
      rec.emit([{ isFinal: true, transcript: "late words" }]);
    });
    await settle();

    expect(textarea().value).toBe("");
    expect(sent).toEqual([{ text: "hello", attachments: [] }]);
  });

  test("stop then send does not restore the draft from a deferred final result", async () => {
    installSpeechRecognition();
    const sent: ComposerSendPayload[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          agents: [],
          onSend: (payload) => {
            sent.push(payload);
            return Promise.resolve(true);
          },
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });
    typeInto(textarea(), "hello");
    textarea().setSelectionRange(5, 5);
    await settle();

    const dictate = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate"]',
    );
    if (dictate === null || dictate === undefined) {
      throw new Error("dictate button not found");
    }

    act(() => {
      dictate.click();
    });
    await settle();

    const rec = recognitions.at(-1);
    if (rec === undefined) {
      throw new Error("speech recognition was not constructed");
    }

    act(() => {
      dictate.click();
    });
    await settle();

    expect(textarea().value).toBe("hello");

    act(() => {
      sendButton().click();
    });
    await settle();

    act(() => {
      rec.emit([{ isFinal: true, transcript: "late words" }]);
    });
    await settle();

    expect(textarea().value).toBe("");
    expect(sent).toEqual([{ text: "hello", attachments: [] }]);
  });

  test("does not report aborted or no-speech recognition errors", async () => {
    installSpeechRecognition();
    const report = spyOn(errorSink, "reportError");
    mount(() => Promise.resolve(true));

    const dictate = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate"]',
    );
    if (dictate === null || dictate === undefined) {
      throw new Error("dictate button not found");
    }

    act(() => {
      dictate.click();
    });
    await settle();

    const rec = recognitions.at(-1);
    if (rec === undefined) {
      throw new Error("speech recognition was not constructed");
    }

    act(() => {
      rec.onerror?.({ error: "no-speech" });
      rec.onerror?.({ error: "aborted" });
    });
    await settle();

    expect(report).not.toHaveBeenCalled();

    act(() => {
      rec.onerror?.({ error: "network" });
    });
    await settle();

    expect(report).toHaveBeenCalled();
    report.mockRestore();
  });
});
