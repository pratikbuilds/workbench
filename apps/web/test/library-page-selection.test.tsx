// CL-6423: Files adopts @corbits/react-ui's selection system. These tests
// drive `LibraryPage` directly (it is a pure, uncontrolled-selection
// component outside `LibraryRoute`) so selection state, the bulk action
// bar, and the top-nav action placement can all be asserted without a
// network layer.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { spyOnReactUiToast } from "./react-ui-toast-mock";
import { LibraryPage } from "../src/pages/library-page";
import { LIBRARY_BULK_OPERATION_IDS } from "../src/shell/library-artifacts";

const toastMock = spyOnReactUiToast();

const artifacts = [
  {
    id: "art_1",
    title: "Alpha",
    kind: "document",
    ownerName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "art_2",
    title: "Bravo",
    kind: "document",
    ownerName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "art_3",
    title: "Charlie",
    kind: "document",
    ownerName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock(() => Promise.resolve()) },
  });
  // isAdditiveSelectClick's Mac/non-Mac branch reads navigator.platform,
  // which happy-dom reports as whatever the host OS is — Darwin-flavored
  // locally, something else on Linux CI. Pinned here so the ctrl-click
  // test below exercises the Mac branch deterministically on any OS.
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  toastMock.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<LibraryPage artifacts={artifacts} />);
  });
}

function rowFor(title: string): HTMLTableRowElement {
  const row = [...container.querySelectorAll("tbody tr")].find((candidate) =>
    candidate.textContent?.includes(title),
  );
  if (row === undefined) throw new Error(`no row for "${title}"`);
  return row as HTMLTableRowElement;
}

function checkboxFor(title: string): HTMLButtonElement {
  const row = rowFor(title);
  const button = row.querySelector('button[role="checkbox"]');
  if (button === null) throw new Error(`no checkbox for "${title}"`);
  return button as HTMLButtonElement;
}

function headerCheckbox(): HTMLButtonElement {
  const button = container.querySelector('thead button[role="checkbox"]');
  if (button === null) throw new Error("no header checkbox");
  return button as HTMLButtonElement;
}

function click(
  button: HTMLButtonElement,
  modifiers: { shiftKey?: boolean } = {},
) {
  act(() => {
    button.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        shiftKey: modifiers.shiftKey ?? false,
      }),
    );
  });
}

function bulkActionBar(): Element | null {
  return container.querySelector('[role="group"][aria-label="Bulk actions"]');
}

describe("LibraryPage selection", () => {
  test("clicking a row's checkbox selects just that row", () => {
    render();
    click(checkboxFor("Alpha"));
    expect(checkboxFor("Alpha").getAttribute("aria-checked")).toBe("true");
    expect(checkboxFor("Bravo").getAttribute("aria-checked")).toBe("false");
  });

  test("shift-click ranges from the last plain toggle through the clicked row", () => {
    render();
    click(checkboxFor("Alpha"));
    click(checkboxFor("Charlie"), { shiftKey: true });
    expect(checkboxFor("Alpha").getAttribute("aria-checked")).toBe("true");
    expect(checkboxFor("Bravo").getAttribute("aria-checked")).toBe("true");
    expect(checkboxFor("Charlie").getAttribute("aria-checked")).toBe("true");
  });

  test("the header checkbox is indeterminate with a partial selection and selects all on click", () => {
    render();
    click(checkboxFor("Alpha"));
    expect(headerCheckbox().getAttribute("aria-checked")).toBe("mixed");

    click(headerCheckbox());
    expect(checkboxFor("Alpha").getAttribute("aria-checked")).toBe("true");
    expect(checkboxFor("Bravo").getAttribute("aria-checked")).toBe("true");
    expect(checkboxFor("Charlie").getAttribute("aria-checked")).toBe("true");
    expect(headerCheckbox().getAttribute("aria-checked")).toBe("true");
  });

  test("clicking the fully-selected header checkbox again clears the selection", () => {
    render();
    click(headerCheckbox());
    click(headerCheckbox());
    expect(bulkActionBar()).toBeNull();
  });

  test("the bulk action bar appears once something is selected, and clears with the selection", () => {
    render();
    expect(bulkActionBar()).toBeNull();

    click(checkboxFor("Alpha"));
    const bar = bulkActionBar();
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("1 selected");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(bulkActionBar()).toBeNull();
  });

  test("the bulk action bar's action list is exactly the real, already-implemented operations", () => {
    render();
    click(checkboxFor("Alpha"));
    click(checkboxFor("Bravo"), { shiftKey: false });
    const ids = [...container.querySelectorAll("[data-bulk-action]")].map(
      (node) => node.getAttribute("data-bulk-action"),
    );
    expect(ids).toEqual([...LIBRARY_BULK_OPERATION_IDS]);
  });

  test("cmd-click on a row adds it to the selection instead of activating it", () => {
    render();
    const row = rowFor("Alpha");
    act(() => {
      row.dispatchEvent(
        new MouseEvent("click", { bubbles: true, metaKey: true }),
      );
    });
    expect(checkboxFor("Alpha").getAttribute("aria-checked")).toBe("true");
  });

  test("ctrl-click on a Mac does not toggle selection (it's the context-menu gesture)", () => {
    // happy-dom reports a Darwin navigator.platform, so this exercises the
    // Mac branch of isAdditiveSelectClick.
    render();
    const row = rowFor("Alpha");
    act(() => {
      row.dispatchEvent(
        new MouseEvent("click", { bubbles: true, ctrlKey: true }),
      );
    });
    expect(checkboxFor("Alpha").getAttribute("aria-checked")).toBe("false");
  });

  test("bottom-up selection still copies links in visible row order", async () => {
    render();
    click(checkboxFor("Charlie"));
    click(checkboxFor("Alpha"), { shiftKey: true });
    const button = container.querySelector(
      '[data-bulk-action="copy-link"]',
    ) as HTMLButtonElement;
    act(() => button.click());
    await Promise.resolve();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/files/a/art_1\n${window.location.origin}/files/a/art_2\n${window.location.origin}/files/a/art_3`,
    );
  });

  test("bottom-up selection exposes context-menu ids in visible row order", () => {
    render();
    click(checkboxFor("Charlie"));
    click(checkboxFor("Alpha"), { shiftKey: true });
    expect(rowFor("Bravo").getAttribute("data-ctx-artifact-selected-ids")).toBe(
      "art_1,art_2,art_3",
    );
  });

  test("switching to the cards view clears the selection and its bulk bar", () => {
    render();
    click(checkboxFor("Alpha"));
    expect(bulkActionBar()).not.toBeNull();
    const cardsToggle = container.querySelector(
      'button[aria-label="Grid view"]',
    ) as HTMLButtonElement | null;
    if (cardsToggle === null) throw new Error("no grid view toggle");
    act(() => cardsToggle.click());
    expect(bulkActionBar()).toBeNull();
  });

  test("the bulk copy-link action copies every selected file's canonical link", async () => {
    render();
    click(checkboxFor("Alpha"));
    click(checkboxFor("Bravo"), { shiftKey: true });
    const button = container.querySelector(
      '[data-bulk-action="copy-link"]',
    ) as HTMLButtonElement;
    act(() => button.click());
    await Promise.resolve();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/files/a/art_1\n${window.location.origin}/files/a/art_2`,
    );
    expect(toastMock).toHaveBeenCalledWith("2 links copied");
  });
});

describe("LibraryPage top-nav action placement", () => {
  test("primary page actions render inside the StageTopBar action slot, not the page body", () => {
    act(() => {
      root.render(
        <LibraryPage artifacts={artifacts} onUpload={() => undefined} />,
      );
    });
    const topBarActions = container.querySelector(
      '[data-testid="stage-top-bar-actions"]',
    );
    expect(topBarActions).not.toBeNull();
    expect(topBarActions?.textContent).toContain("Upload");

    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="stage-top-bar"]')?.remove();
    expect(clone.textContent).not.toContain("Upload");
  });

  test("the filter, sort and view controls sit in the top bar, not a body toolbar", () => {
    act(() => {
      root.render(
        <LibraryPage
          artifacts={artifacts}
          onUpload={() => undefined}
          workbenchScope={{ title: "Launch plan" }}
          scope="all"
          onScopeChange={() => undefined}
        />,
      );
    });
    const topBarActions = container.querySelector(
      '[data-testid="stage-top-bar-actions"]',
    );
    expect(topBarActions).not.toBeNull();
    expect(
      topBarActions?.querySelector('[aria-label="Filter files"]'),
    ).not.toBeNull();
    expect(
      topBarActions?.querySelector('[aria-label="Files scope"]'),
    ).not.toBeNull();
    expect(
      topBarActions?.querySelector('[aria-label="Newest first"]'),
    ).not.toBeNull();
    expect(topBarActions?.querySelector('[aria-label="View"]')).not.toBeNull();
    expect(container.querySelector(".page-toolbar")).toBeNull();
  });

  test("scoped filtering is labelled as filtering, never as a second search", () => {
    act(() => {
      root.render(<LibraryPage artifacts={artifacts} />);
    });
    expect(container.querySelector('[aria-label="Search files"]')).toBeNull();
    expect(container.textContent).not.toContain("Search files");
  });

  test("files open as rows before grids", () => {
    act(() => {
      root.render(<LibraryPage artifacts={artifacts} />);
    });
    expect(container.querySelector('[data-slot="table"]')).not.toBeNull();
  });

  test("the workbench-scope pair reads as one grouped control, distinct from the clear-selection action", () => {
    act(() => {
      root.render(
        <LibraryPage
          artifacts={artifacts}
          selectedId="art_1"
          onSelect={() => undefined}
          workbenchScope={{ title: "Launch plan" }}
          scope="all"
          onScopeChange={() => undefined}
        />,
      );
    });
    const topBarActions = container.querySelector(
      '[data-testid="stage-top-bar-actions"]',
    );
    // The two-state scope toggle is visually one control (a bordered
    // segmented group, the same idiom `ViewToggle` already uses in this
    // bar) rather than two stray buttons that read as independent chips.
    const scopeGroup = topBarActions?.querySelector(
      '[aria-label="Files scope"]',
    );
    expect(scopeGroup?.className).toContain("border");
    expect(scopeGroup?.textContent).toContain("Launch plan");
    expect(scopeGroup?.textContent).toContain("All workbenches");

    // The clear-selection action is not a filter and must not read as one:
    // no button labelled bare "All" sits beside "All workbenches".
    const buttons = [...(topBarActions?.querySelectorAll("button") ?? [])];
    expect(buttons.some((b) => b.textContent?.trim() === "All")).toBe(false);
    expect(buttons.some((b) => b.textContent?.trim() === "Back to files")).toBe(
      true,
    );
  });

  test("the files scope control stays in the document below the lg breakpoint", () => {
    act(() => {
      root.render(
        <LibraryPage
          artifacts={artifacts}
          workbenchScope={{ title: "Launch plan" }}
          scope="all"
          onScopeChange={() => undefined}
        />,
      );
    });
    const topBarActions = container.querySelector(
      '[data-testid="stage-top-bar-actions"]',
    );
    const scopeControls = [
      ...(topBarActions?.querySelectorAll('[aria-label="Files scope"]') ?? []),
    ];
    expect(scopeControls.length).toBeGreaterThan(0);
    // `hidden` is display:none. A Files-scope control that only exists
    // behind `hidden lg:flex` vanishes below 1024px with no way to reach
    // All workbenches. At least one control must stay in the tree without
    // that class — the overflow menu in this bar, or the group itself.
    expect(
      scopeControls.some((el) => !el.className.split(/\s+/).includes("hidden")),
    ).toBe(true);
  });

  test("the file detail pane fills the available height", () => {
    act(() => {
      root.render(
        <LibraryPage
          artifacts={artifacts}
          selectedId="art_1"
          onSelect={() => undefined}
        />,
      );
    });
    const pane = container.querySelector("aside");
    expect(pane).not.toBeNull();
    expect(pane?.className).toContain("h-full");
  });
});
