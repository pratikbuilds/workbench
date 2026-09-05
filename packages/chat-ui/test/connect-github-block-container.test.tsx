// CL-6463: a successful PAT submit must flip the connect-github card to
// connected on its own — never leaning on a host that happens to fan the
// change out through `subscribeConnectState`. These fakes deliberately
// never call the subscriber from `submitAccessToken`, so a pass here
// proves the container drove its own state from the submit's own result
// — not from a side channel a differently-wired host might forget.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { ConnectGithubBlockData } from "@corbits/chat/blocks";

import type {
  ConnectGithubActions,
  ConnectGithubQuery,
  ConnectGithubRepo,
} from "../src/blocks/connect-github-actions";
import { ConnectGithubBlockContainer } from "../src/blocks/connect-github-block-container";

const DATA: ConnectGithubBlockData = {
  requiredForTemplate: "github",
  state: "disconnected",
};

const REPOS: readonly ConnectGithubRepo[] = [{ id: "1", name: "acme/widgets" }];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(actions: ConnectGithubActions, messageId = "m1") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ConnectGithubBlockContainer
        data={DATA}
        messageId={messageId}
        actions={actions}
      />,
    );
  });
  return container;
}

function typeInto(element: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, text);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A host that never notifies `subscribeConnectState` from
 * `submitAccessToken` — the exact shape of the real gap this ticket fixes:
 * the credential save succeeds, but nothing about it ever reaches the
 * fold. `getConnectState` is the only thing that reports the new
 * connected fact, mirroring the real `/github/state` route reading the
 * just-written credential. */
function buildNeverNotifiesHarness(options?: {
  readonly submitResult?:
    { readonly ok: true } | { readonly ok: false; readonly message: string };
}) {
  let connected = false;
  return {
    actions: {
      getConnectState: () =>
        Promise.resolve<ConnectGithubQuery>(
          connected
            ? {
                kind: "connected",
                orgName: "octocat",
                repos: REPOS,
                selectedRepoIds: [],
              }
            : { kind: "disconnected" },
        ),
      subscribeConnectState: () => () => {},
      notifySettingsChanged: async () => {},
      requestConnect: () => {},
      submitAccessToken: async (_token: string) => {
        const result = options?.submitResult ?? { ok: true as const };
        if (result.ok) connected = true;
        return result;
      },
      startReviewing: async () => ({ startedTriggerCount: 0 }),
      skip: async () => {},
    } satisfies ConnectGithubActions,
  };
}

async function openFieldAndSubmit(el: HTMLElement, token: string) {
  const connectButton = [...el.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect GitHub",
  ) as HTMLButtonElement;
  await act(async () => {
    connectButton.click();
  });
  const tokenField = el.querySelector(
    "#connect-github-token",
  ) as HTMLInputElement;
  await act(async () => {
    typeInto(tokenField, token);
  });
  const submitButton = [...el.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect",
  ) as HTMLButtonElement;
  await act(async () => {
    submitButton.click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ConnectGithubBlockContainer post-submit refresh (CL-6463)", () => {
  test("a successful PAT submit flips the card to connected on its own, even when the host never fans the change out through subscribeConnectState", async () => {
    const harness = buildNeverNotifiesHarness();
    const el = await mount(harness.actions);

    expect(el.textContent).toContain("Connect GitHub");
    await openFieldAndSubmit(el, "ghp_test123");

    expect(el.textContent).toContain("Connected to GitHub as octocat");
    expect(el.querySelectorAll(".chat-block-connect-repo-row")).toHaveLength(
      REPOS.length,
    );
  });

  test("a successful PAT submit moves focus onto the pick-repos heading", async () => {
    const harness = buildNeverNotifiesHarness();
    const el = await mount(harness.actions, "m_pat_focus");

    const connectButton = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    ) as HTMLButtonElement;
    await act(async () => {
      connectButton.click();
    });
    const tokenField = el.querySelector(
      "#connect-github-token",
    ) as HTMLInputElement;
    await act(async () => {
      typeInto(tokenField, "ghp_test123");
    });
    const submitButton = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    ) as HTMLButtonElement;
    await act(async () => {
      submitButton.focus();
      submitButton.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const heading = el.querySelector(".chat-block-scene-pick-heading");
    expect(heading?.textContent).toBe("Choose what gets reviewed");
    expect(heading?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
    expect(el.querySelector("#connect-github-token")).toBeNull();
  });

  test("a rejected token shows what went wrong and leaves a working submit button, never a dead card", async () => {
    const harness = buildNeverNotifiesHarness({
      submitResult: { ok: false, message: "That token looks expired." },
    });
    const el = await mount(harness.actions);

    await openFieldAndSubmit(el, "ghp_bad");

    expect(el.textContent).toContain("That token looks expired.");
    expect(el.textContent).not.toContain("Connected to GitHub as");

    const submitButton = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);

    const tokenField = el.querySelector(
      "#connect-github-token",
    ) as HTMLInputElement;
    expect(tokenField.disabled).toBe(false);
  });
});

describe("ConnectGithubBlockContainer keeps connected across loading (CL-6741)", () => {
  test("a loading remount after connected keeps ConnectedBody — never flashes Connect", async () => {
    let state: ConnectGithubQuery = {
      kind: "connected",
      orgName: "octocat",
      repos: REPOS,
      selectedRepoIds: [],
    };
    let subscriber: ((next: ConnectGithubQuery) => void) | undefined;

    const actions: ConnectGithubActions = {
      getConnectState: () => Promise.resolve(state),
      subscribeConnectState: (_messageId, onUpdate) => {
        subscriber = onUpdate;
        return () => {
          subscriber = undefined;
        };
      },
      notifySettingsChanged: async () => {},
      requestConnect: () => {},
      submitAccessToken: async () => ({ ok: true as const }),
      startReviewing: async () => ({ startedTriggerCount: 0 }),
      skip: async () => {},
    };

    const el = await mount(actions);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("Connected to GitHub as octocat");
    expect(el.textContent).not.toContain("Connect GitHub");

    await act(async () => {
      state = { kind: "loading" };
      subscriber?.({ kind: "loading" });
    });
    expect(el.textContent).toContain("Connected to GitHub as octocat");
    expect(el.textContent).not.toContain("Connect GitHub");
    expect(el.querySelectorAll(".chat-block-connect-repo-row")).toHaveLength(
      REPOS.length,
    );

    // Remount while the host still reports loading — the last connected
    // snapshot must survive so Connect never flashes.
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;

    const remounted = await mount(actions);
    expect(remounted.textContent).toContain("Connected to GitHub as octocat");
    expect(remounted.textContent).not.toContain("Connect GitHub");
  });

  test("an explicit disconnected result after connected does show Connect again", async () => {
    let state: ConnectGithubQuery = {
      kind: "connected",
      orgName: "octocat",
      repos: REPOS,
      selectedRepoIds: [],
    };
    let subscriber: ((next: ConnectGithubQuery) => void) | undefined;

    const actions: ConnectGithubActions = {
      getConnectState: () => Promise.resolve(state),
      subscribeConnectState: (_messageId, onUpdate) => {
        subscriber = onUpdate;
        return () => {
          subscriber = undefined;
        };
      },
      notifySettingsChanged: async () => {},
      requestConnect: () => {},
      submitAccessToken: async () => ({ ok: true as const }),
      startReviewing: async () => ({ startedTriggerCount: 0 }),
      skip: async () => {},
    };

    const el = await mount(actions);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("Connected to GitHub as octocat");

    await act(async () => {
      state = { kind: "disconnected" };
      subscriber?.({ kind: "disconnected" });
    });
    expect(el.textContent).toContain("Connect GitHub");
    expect(el.textContent).not.toContain("Connected to GitHub as");
  });
});

describe("ConnectGithubBlockContainer names a kind:error state (PR 422)", () => {
  test("query kind error shows the state message as an alert, not a silent Connect GitHub primary", async () => {
    const message = "Couldn't read your GitHub repositories. Try reconnecting.";
    const actions: ConnectGithubActions = {
      getConnectState: () => Promise.resolve({ kind: "error", message }),
      subscribeConnectState: () => () => {},
      notifySettingsChanged: async () => {},
      requestConnect: () => {},
      submitAccessToken: async () => ({ ok: true as const }),
      startReviewing: async () => ({ startedTriggerCount: 0 }),
      skip: async () => {},
    };

    const el = await mount(actions, "m_state_error");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe(message);

    const connectPrimary = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    );
    expect(connectPrimary).toBeUndefined();
  });

  // CL-7189: a rejected read used to leave the query on `loading`, which
  // renders the disconnected body — the card told a person with a working
  // connection that they had never connected.
  test("a state read that rejects becomes a spoken error, never a silent Connect GitHub", async () => {
    const actions: ConnectGithubActions = {
      getConnectState: () => Promise.reject(new Error("boom")),
      subscribeConnectState: () => () => {},
      notifySettingsChanged: async () => {},
      requestConnect: () => {},
      submitAccessToken: async () => ({ ok: true as const }),
      startReviewing: async () => ({ startedTriggerCount: 0 }),
      skip: async () => {},
    };

    const el = await mount(actions, "m_state_rejected");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "Couldn't reach GitHub with your token just now — try connecting again.",
    );
    const connectPrimary = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    );
    expect(connectPrimary).toBeUndefined();
  });
});
