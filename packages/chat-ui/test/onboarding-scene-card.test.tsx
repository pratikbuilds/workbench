// The room's first minute: one designed card posted in the room's own
// voice that names the job, walks the person through connect → pick →
// reviewing, and lands on a real done state. Covers the card's chrome (no
// author row, no "Member", no avatar), the header the card keeps across
// every state, and the walkthrough marker each live connect state puts on
// it.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import * as errorSink from "@corbits/error-sink";

import type { MessageItem } from "../src/api";
import type {
  ConnectGithubActions,
  ConnectGithubQuery,
  ConnectGithubRepo,
} from "../src/blocks/connect-github-actions";
import { ConnectGithubBlockContainer } from "../src/blocks/connect-github-block-container";
import { WorkbenchTimeline } from "../src/timeline";

const STEPS: { title: string; why: string }[] = [
  { title: "Connect GitHub", why: "Reviewers need to read your code." },
  {
    title: "Choose what gets reviewed",
    why: "Of the repos your token reaches, these get watched.",
  },
  { title: "Start reviewing", why: "Reviews land right here in this room." },
];

const PROMISE = "Every new pull request gets reviewed before you merge it.";

const REPOS: readonly ConnectGithubRepo[] = [
  { id: "1", name: "acme/checkout" },
  { id: "2", name: "acme/web" },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  mock.restore();
});

async function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

function onboardingCardItem(data: unknown): readonly MessageItem[] {
  return [
    {
      id: "m_onboarding",
      createdAt: "2026-01-01T00:00:00.000Z",
      sender: { name: null, address: "system@wb_1" },
      parts: [{ kind: "block", block: { type: "connect-github", data } }],
    },
  ];
}

function stepRows(el: HTMLElement) {
  return [...el.querySelectorAll(".chat-block-scene-step")];
}

function stepTitles(el: HTMLElement) {
  return stepRows(el).map(
    (row) =>
      row.querySelector(".chat-block-scene-step-title")?.textContent ?? "",
  );
}

function currentStepTitle(el: HTMLElement): string | undefined {
  const current = stepRows(el).find(
    (row) => row.getAttribute("data-state") === "current",
  );
  return (
    current?.querySelector(".chat-block-scene-step-title")?.textContent ??
    undefined
  );
}

function currentStepAria(el: HTMLElement): string | null {
  const current = stepRows(el).find(
    (row) => row.getAttribute("aria-current") === "step",
  );
  return (
    current?.querySelector(".chat-block-scene-step-title")?.textContent ?? null
  );
}

/** A host whose live state is whatever the test says it is, pushed once
 * on mount — the same read-then-subscribe contract the real
 * `createChatConnectGithubActions` binds. */
function fixedStateActions(state: ConnectGithubQuery): ConnectGithubActions {
  return {
    getConnectState: () => Promise.resolve(state),
    subscribeConnectState: () => () => undefined,
    notifySettingsChanged: () => Promise.resolve(),
    requestConnect: () => undefined,
    submitAccessToken: () => Promise.resolve({ ok: true as const }),
    startReviewing: () => Promise.resolve({ startedTriggerCount: 0 }),
    skip: () => Promise.resolve(),
  };
}

describe("the room's onboarding card is a scene, not a member's message", () => {
  test("a card posted in the room's own voice carries no author row, no avatar, and no Member label", async () => {
    const el = await mount(
      <WorkbenchTimeline
        items={onboardingCardItem({
          requiredForTemplate: "Code review",
          state: "disconnected",
          promise: PROMISE,
          steps: STEPS,
        })}
        currentUser={{ principalId: "sawyer", name: "Sawyer" }}
      />,
    );
    expect(el.querySelector(".chat-block")).not.toBeNull();
    expect(el.querySelector(".chat-sender-avatar-wrap")).toBeNull();
    expect(el.querySelector(".chat-bubble-row")).toBeNull();
    expect(el.textContent).not.toContain("Member");
    expect(el.textContent).not.toContain("system");
    expect(
      el.querySelector(".chat-message-group")?.getAttribute("data-own"),
    ).toBe("false");
  });

  test("the card names the job, promises the outcome, and lists the room's own step labels in order", async () => {
    const el = await mount(
      <WorkbenchTimeline
        items={onboardingCardItem({
          requiredForTemplate: "Code review",
          state: "disconnected",
          promise: PROMISE,
          steps: STEPS,
        })}
      />,
    );
    expect(el.querySelector(".chat-block-title")?.textContent).toBe(
      "Code review",
    );
    expect(el.querySelector(".chat-block-scene-promise")?.textContent).toBe(
      PROMISE,
    );
    expect(stepTitles(el)).toEqual([
      "Connect GitHub",
      "Choose what gets reviewed",
      "Start reviewing",
    ]);
  });

  test("a card persisted without a promise or steps renders the card without either — never invented copy", async () => {
    const el = await mount(
      <WorkbenchTimeline
        items={onboardingCardItem({
          requiredForTemplate: "Code review",
          state: "disconnected",
        })}
      />,
    );
    expect(el.querySelector(".chat-block-title")?.textContent).toBe(
      "Code review",
    );
    expect(el.querySelector(".chat-block-scene-promise")).toBeNull();
    expect(el.querySelector(".chat-block-scene-steps")).toBeNull();
    expect(el.querySelector(".chat-block-scene-why")).toBeNull();
  });

  test("an empty steps list does not render the step list", async () => {
    const el = await mount(
      <WorkbenchTimeline
        items={onboardingCardItem({
          requiredForTemplate: "Code review",
          state: "disconnected",
          promise: PROMISE,
          steps: [],
        })}
      />,
    );
    expect(el.querySelector(".chat-block-scene-promise")?.textContent).toBe(
      PROMISE,
    );
    expect(el.querySelector(".chat-block-scene-steps")).toBeNull();
  });

  test("a walkthrough of some other length still shows its labels, but marks no step", async () => {
    const el = await mount(
      <WorkbenchTimeline
        items={onboardingCardItem({
          requiredForTemplate: "Code review",
          state: "disconnected",
          promise: PROMISE,
          steps: [STEPS[0], STEPS[1]],
        })}
      />,
    );
    expect(stepTitles(el)).toEqual([
      "Connect GitHub",
      "Choose what gets reviewed",
    ]);
    expect(currentStepTitle(el)).toBeUndefined();
    expect(el.querySelector(".chat-block-scene-why")).toBeNull();
  });
});

describe("the walkthrough marker follows the live connect state", () => {
  const DATA = {
    requiredForTemplate: "Code review",
    state: "disconnected" as const,
    promise: PROMISE,
    steps: STEPS,
  };

  async function mountAt(messageId: string, state: ConnectGithubQuery) {
    return mount(
      <ConnectGithubBlockContainer
        data={DATA}
        messageId={messageId}
        actions={fixedStateActions(state)}
      />,
    );
  }

  test("nothing connected yet marks Connect GitHub and explains why that step matters", async () => {
    const el = await mountAt("m_step1", { kind: "disconnected" });
    expect(currentStepTitle(el)).toBe("Connect GitHub");
    expect(currentStepAria(el)).toBe("Connect GitHub");
    expect(el.querySelector(".chat-block-scene-why")?.textContent).toBe(
      STEPS[0]?.why,
    );
    const status = el.querySelector(".chat-block-scene-status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("Connect GitHub");
    expect(
      el.querySelector(".chat-block-scene-body")?.getAttribute("aria-live"),
    ).toBeNull();
    expect(el.querySelector(".chat-block-scene-body")?.contains(status)).toBe(
      false,
    );
  });

  test("connected with nothing recorded yet marks Pick your repos", async () => {
    const el = await mountAt("m_step2", {
      kind: "connected",
      orgName: "acme",
      repos: REPOS,
      selectedRepoIds: [],
    });
    expect(currentStepTitle(el)).toBe("Choose what gets reviewed");
    expect(currentStepAria(el)).toBe("Choose what gets reviewed");
    expect(el.querySelector(".chat-block-scene-why")?.textContent).toBe(
      STEPS[1]?.why,
    );
    expect(el.textContent).toContain("acme/checkout");
  });

  test("repos the server actually recorded mark Start reviewing and show the done state, never Connect", async () => {
    const el = await mountAt("m_step3", {
      kind: "connected",
      orgName: "acme",
      repos: REPOS,
      selectedRepoIds: ["1", "2"],
    });
    expect(currentStepTitle(el)).toBe("Start reviewing");
    expect(currentStepAria(el)).toBe("Start reviewing");
    const done = el.querySelector(".chat-block-scene-reviewing");
    expect(done?.textContent).toContain("Reviewing");
    const names = [
      ...el.querySelectorAll(".chat-block-scene-repo-names li"),
    ].map((item) => item.textContent);
    expect(names).toEqual(["acme/checkout", "acme/web"]);
    expect(done?.textContent).toContain("change repos");
    // The done state never re-offers connecting — the card is past it.
    expect(done?.textContent).not.toContain("Connect");
  });

  test("change repos hands the picker back without touching what the server recorded", async () => {
    const el = await mountAt("m_step4", {
      kind: "connected",
      orgName: "acme",
      repos: REPOS,
      selectedRepoIds: ["1"],
    });
    const changeRepos = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "change repos",
    );
    expect(changeRepos).not.toBeUndefined();
    await act(async () => {
      changeRepos?.click();
    });
    expect(el.textContent).toContain("2 repos your token can reach · 1 picked");
    expect(el.querySelector(".chat-block-title")?.textContent).toBe(
      "Code review",
    );
    expect(currentStepTitle(el)).toBe("Choose what gets reviewed");
    expect(el.querySelector(".chat-block-scene-why")?.textContent).toBe(
      STEPS[1]?.why,
    );
  });

  test("a rejected start reviewing after change repos keeps the picker and reports the error", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const actions: ConnectGithubActions = {
      ...fixedStateActions({
        kind: "connected",
        orgName: "acme",
        repos: REPOS,
        selectedRepoIds: ["1"],
      }),
      startReviewing: () => Promise.reject(new Error("could not start")),
    };
    const el = await mount(
      <ConnectGithubBlockContainer
        data={DATA}
        messageId="m_step_reject"
        actions={actions}
      />,
    );
    const changeRepos = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "change repos",
    );
    await act(async () => {
      changeRepos?.click();
    });
    expect(el.textContent).toContain("2 repos your token can reach · 1 picked");

    const start = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Start reviewing"),
    );
    await act(async () => {
      start?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector(".chat-block-scene-reviewing")).toBeNull();
    expect(el.textContent).toContain("2 repos your token can reach · 1 picked");
    expect(currentStepTitle(el)).toBe("Choose what gets reviewed");
    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't start reviewing");
    const status = el.querySelector(".chat-block-scene-status");
    expect(status?.textContent).toBe("Choose what gets reviewed");
    expect(status?.contains(alert)).toBe(false);
    expect(report).toHaveBeenCalled();
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "connect-github.startReviewing",
    });
  });

  test("a successful start reviewing after change repos moves focus onto the reviewing scene", async () => {
    const el = await mount(
      <ConnectGithubBlockContainer
        data={DATA}
        messageId="m_step_focus"
        actions={fixedStateActions({
          kind: "connected",
          orgName: "acme",
          repos: REPOS,
          selectedRepoIds: ["1"],
        })}
      />,
    );
    const changeRepos = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "change repos",
    );
    await act(async () => {
      changeRepos?.click();
    });
    const start = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Start reviewing"),
    );
    await act(async () => {
      start?.focus();
      start?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const reviewing = el.querySelector(".chat-block-scene-reviewing");
    expect(reviewing).not.toBeNull();
    expect(currentStepAria(el)).toBe("Start reviewing");
    expect(reviewing?.contains(document.activeElement)).toBe(true);
  });
});
