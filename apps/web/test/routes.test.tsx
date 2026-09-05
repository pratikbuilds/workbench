// Pages load through `React.lazy`, so these tests client-render and wait
// for the suspended route (SSR would only see the Suspense fallback). The
// one route with no stage bar of its own (`/`, see `AppRoute.hasStageTopBar`)
// gets one from `AppShell` itself, so every route ends up titled the same
// way — including `/w` and `/w/:id`, which title the conversation through
// `StageTopBar` rather than a second in-stage header.

import { ThemeProvider } from "@corbits/react-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { App } from "../src/app";
import {
  AGENT_DETAIL_PATH,
  APP_ROUTES,
  matchesRoute,
  NAV_ROUTES,
  ROUTINE_DETAIL_PATH,
  SKILL_DETAIL_PATH,
  WORKFLOW_DETAIL_PATH,
} from "../src/routes";
import type { SessionState } from "../src/session";

/** Slug-addressed detail routes (CL-6412). The generic render loop below
 * renders each `route.path` verbatim, which for these is the pattern
 * (`/agents/:slug`) rather than a real path - they get their own render
 * tests instead. Plugin detail (`/plugins/:slug`) is intentionally absent
 * until CL-6417 — the stub was unlinked in CL-6817. */
const DETAIL_ROUTE_PATHS = new Set([
  ROUTINE_DETAIL_PATH,
  WORKFLOW_DETAIL_PATH,
  AGENT_DETAIL_PATH,
  SKILL_DETAIL_PATH,
]);

/** Legacy routes that only redirect - `/library` bounces to `/files`
 * (CL-6353), `/settings/agents` and `/settings/skills` bounce to `/agents`
 * and `/skills` (CL-6354/CL-6355 moved both off Settings), `/inbox` bounces
 * home (the Inbox page is gone, CL-6151) - none has a stable panel title to
 * assert via the generic render loop below. */
const LEGACY_REDIRECT_PATHS = new Set([
  "/library",
  "/settings/agents",
  "/settings/skills",
  "/inbox",
]);

const noNavigate = () => undefined;
const noop = () => undefined;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const signedIn: SessionState = {
  kind: "signed-in",
  user: { id: "user_1", name: "Ada", email: "ada@example.com" },
};

function stubEmptyFetch(): void {
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

async function flushLazyImports(): Promise<void> {
  for (let count = 0; count < 5; count += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderApp(
  path: string,
  session: SessionState = signedIn,
): Promise<string> {
  stubEmptyFetch();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ThemeProvider>
          <App
            path={path}
            navigate={noNavigate}
            session={session}
            onSignedIn={noop}
            onSignOut={noop}
            onRetry={noop}
          />
        </ThemeProvider>,
      );
    });
    await flushLazyImports();
    return container.innerHTML;
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
}

/** Page identity: every route titles its stage's own `StageTopBar` (the
 * one bar-less route, `/`, gets one from `AppShell` itself). */
function stagePageTitle(markup: string): string | undefined {
  return /class="stage-crumb-current"[^>]*>([^<]*)</.exec(markup)?.[1];
}

/** The first-run footer rail marks its own destination current: Routines,
 * Files, Skills, Agents, and Plugins are text rows with `aria-current="page"`
 * on the lit one. Insights and Evals join only given honest usage, and
 * stay reachable by URL and palette instead until then. Settings lives
 * beside the account row, so its route lights nothing in the chrome - the
 * stage title carries it. Returns the active row's label so tests confirm
 * the *right* footer affordance lights, and nothing else does. */
function activeFooterLabel(markup: string): string | undefined {
  const lit =
    /shell-sidebar-footer-row"[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/button>/.exec(
      markup,
    );
  if (lit === null) return undefined;
  return /<span>([^<]+)<\/span>/.exec(lit[1] ?? "")?.[1];
}

const FOOTER_LABELS: Record<string, string> = {
  "/routines": "Routines",
  "/files": "Files",
  "/skills": "Skills",
  "/agents": "Agents",
  "/plugins": "Plugins",
};

describe("route table", () => {
  test("covers every screen the app can route to", () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/mission-control",
      "/new",
      "/w",
      "/inbox",
      "/routines/:routine",
      "/routines",
      "/workflows/:workflow",
      "/files",
      "/library",
      "/agents/:slug",
      "/agents",
      "/settings/agents",
      "/skills/:slug",
      "/skills",
      "/settings/skills",
      "/insights",
      "/evals",
      "/plugins",
      "/settings",
    ]);
  });

  test("palette pages are Routines, Files, Skills, Agents, Plugins, Insights, Evals, Settings", () => {
    expect(NAV_ROUTES.map((route) => route.label)).toEqual([
      "Routines",
      "Files",
      "Skills",
      "Agents",
      "Plugins",
      "Insights",
      "Evals",
      "Settings",
    ]);
  });

  test("legacy /chat paths still match the workbenches route", () => {
    expect(matchesRoute("/w", "/chat")).toBe(true);
    expect(matchesRoute("/w", "/chat/ch_1")).toBe(true);
    expect(matchesRoute("/w", "/w/ch_1")).toBe(true);
  });

  test("/settings/:section stays on the settings route", () => {
    expect(matchesRoute("/settings", "/settings")).toBe(true);
    expect(matchesRoute("/settings", "/settings/people")).toBe(true);
    expect(matchesRoute("/settings", "/settings-lookalike")).toBe(false);
  });

  test("/agents/:id and /skills/:id stay on their own roster route", () => {
    expect(matchesRoute("/agents", "/agents/wfd_1")).toBe(true);
    expect(matchesRoute("/skills", "/skills/skill_1")).toBe(true);
    expect(NAV_ROUTES.map((route) => route.path)).toContain("/agents");
    expect(NAV_ROUTES.map((route) => route.path)).toContain("/skills");
  });

  test("legacy /settings/agents and /settings/skills stay routable (redirect-only, off the palette pages)", () => {
    expect(matchesRoute("/settings/agents", "/settings/agents/wfd_1")).toBe(
      true,
    );
    expect(matchesRoute("/settings/skills", "/settings/skills/skill_1")).toBe(
      true,
    );
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain(
      "/settings/agents",
    );
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain(
      "/settings/skills",
    );
  });

  test("legacy /library stays routable (redirect-only) but is off the palette pages", () => {
    expect(matchesRoute("/library", "/library/a/art_1")).toBe(true);
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain("/library");
  });

  test("a slug segment resolves to the entity's own detail route (CL-6412)", () => {
    expect(matchesRoute(AGENT_DETAIL_PATH, "/agents/triage-bot")).toBe(true);
    expect(matchesRoute(SKILL_DETAIL_PATH, "/skills/pr-review")).toBe(true);
    expect(matchesRoute(ROUTINE_DETAIL_PATH, "/routines/weekly-digest")).toBe(
      true,
    );
  });

  test("detail routes match only a single, slug-shaped segment", () => {
    expect(matchesRoute(AGENT_DETAIL_PATH, "/agents")).toBe(false);
    expect(matchesRoute(AGENT_DETAIL_PATH, "/agents/wfd_1")).toBe(false);
    expect(matchesRoute(AGENT_DETAIL_PATH, "/agents/Triage-Bot")).toBe(false);
    expect(matchesRoute(AGENT_DETAIL_PATH, "/agents/triage-bot/runs")).toBe(
      false,
    );
    expect(matchesRoute(AGENT_DETAIL_PATH, "/skills/triage-bot")).toBe(false);
  });

  test("a detail route is found before its roster, and id deep links still are not", () => {
    const routeFor = (path: string) =>
      APP_ROUTES.find((candidate) => matchesRoute(candidate.path, path))?.path;
    expect(routeFor("/agents/triage-bot")).toBe(AGENT_DETAIL_PATH);
    expect(routeFor("/skills/pr-review")).toBe(SKILL_DETAIL_PATH);
    expect(routeFor("/routines/weekly-digest")).toBe(ROUTINE_DETAIL_PATH);
    expect(routeFor("/agents/wfd_1")).toBe("/agents");
    expect(routeFor("/skills/skill_1")).toBe("/skills");
    // Routines are the one roster addressed by id: the detail route
    // claims any single segment (see ROUTINE_DETAIL_PATH).
    expect(routeFor("/routines/rtn_1")).toBe(ROUTINE_DETAIL_PATH);
  });

  test("the Plugins roster owns only its bare path until CL-6417 lands a detail page (CL-6817)", () => {
    const routeFor = (path: string) =>
      APP_ROUTES.find((candidate) => matchesRoute(candidate.path, path))?.path;
    expect(routeFor("/plugins")).toBe("/plugins");
    // No stub detail: a slug under /plugins is unroutable, not a
    // "still being built" placeholder (CL-6817).
    expect(routeFor("/plugins/linear")).toBeUndefined();
    expect(routeFor("/plugins/Linear")).toBeUndefined();
    expect(routeFor("/plugins/linear/settings")).toBeUndefined();
  });

  test("a malformed percent-escape resolves without throwing", () => {
    const routeFor = (path: string) =>
      APP_ROUTES.find((candidate) => matchesRoute(candidate.path, path))?.path;
    expect(routeFor("/plugins/%")).toBeUndefined();
    // A segment that cannot be decoded names no routine, so the detail
    // route declines it and the roster answers instead.
    expect(routeFor("/routines/%E0%A4%A")).toBe("/routines");
    expect(matchesRoute("/plugins", "/plugins/%")).toBe(false);
    expect(matchesRoute(ROUTINE_DETAIL_PATH, "/routines/%E0%A4%A")).toBe(false);
    expect(matchesRoute(AGENT_DETAIL_PATH, "/agents/%2Ftriage-bot")).toBe(
      false,
    );
    // A workflow detail path reuses workflowDefinitionAssetIdFromPath
    // (CL-7371 review): a malformed percent-escape segment must never
    // match the route at all, not match and then fail to resolve an id.
    expect(matchesRoute(WORKFLOW_DETAIL_PATH, "/workflows/%E0%A4%A")).toBe(
      false,
    );
  });

  test("workflow detail path matches a single opaque segment only", () => {
    expect(matchesRoute(WORKFLOW_DETAIL_PATH, "/workflows/wfd_1")).toBe(true);
    expect(matchesRoute(WORKFLOW_DETAIL_PATH, "/workflows")).toBe(false);
    expect(matchesRoute(WORKFLOW_DETAIL_PATH, "/workflows/wfd_1/runs")).toBe(
      false,
    );
  });

  test("a detail path keeps its roster's sidebar row lit", () => {
    expect(matchesRoute("/agents", "/agents/triage-bot")).toBe(true);
    expect(matchesRoute("/skills", "/skills/pr-review")).toBe(true);
    expect(matchesRoute("/plugins", "/plugins/linear")).toBe(false);
    expect(matchesRoute("/routines", "/routines/weekly-digest")).toBe(true);
  });

  test("detail routes are off the palette pages - they need a slug to be reachable", () => {
    for (const detailPath of DETAIL_ROUTE_PATHS) {
      expect(NAV_ROUTES.map((route) => route.path)).not.toContain(detailPath);
    }
  });

  test("/inbox stays routable (redirect-only) but is off the palette pages", () => {
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain("/inbox");
  });
});

describe("/inbox redirect", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  test("bounces old /inbox links home - the Inbox page is gone (CL-6151)", async () => {
    const inboxRoute = APP_ROUTES.find((route) => route.path === "/inbox");
    if (inboxRoute === undefined) throw new Error("no /inbox route entry");
    const navigated: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(inboxRoute.render("/inbox", (to) => navigated.push(to)));
    });
    expect(navigated).toEqual(["/"]);
  });
});

describe("routes render", () => {
  for (const route of APP_ROUTES) {
    if (LEGACY_REDIRECT_PATHS.has(route.path)) continue;
    if (DETAIL_ROUTE_PATHS.has(route.path)) continue;
    test(`${route.path} renders the ${route.label} screen`, async () => {
      const markup = await renderApp(route.path);
      expect(markup).toContain('data-testid="shell-sidebar"');
      if (route.path === "/") {
        expect(stagePageTitle(markup)).toBe("New workbench");
        return;
      }
      if (route.path === "/w") {
        expect(stagePageTitle(markup)).toBe("Workbenches");
        expect(markup).toContain('data-testid="stage-top-bar"');
        expect(activeFooterLabel(markup)).toBeUndefined();
        return;
      }
      if (route.path === "/settings") {
        expect(stagePageTitle(markup)).toBe("General");
      } else {
        expect(stagePageTitle(markup)).toBe(route.label);
      }
      const footerLabel = FOOTER_LABELS[route.path];
      if (footerLabel !== undefined) {
        expect(activeFooterLabel(markup)).toBe(footerLabel);
      } else {
        expect(activeFooterLabel(markup)).toBeUndefined();
      }
    });
  }

  // Agents is the one detail route whose real screen has landed (CL-6414),
  // so it titles itself with the slug and lights its roster row without a
  // placeholder's "Back to" affordance.
  test("/agents/<slug> titles the agent's own page with its roster row lit", async () => {
    const markup = await renderApp("/agents/triage-bot");
    expect(stagePageTitle(markup)).toBe("triage-bot");
    expect(activeFooterLabel(markup)).toBe("Agents");
    expect(markup).not.toContain("still being built");
  });

  test("/skills/:slug renders the skill's own page, not a placeholder", async () => {
    const markup = await renderApp("/skills/pr-review");
    expect(stagePageTitle(markup)).toBe("pr-review");
    expect(markup).not.toContain("Back to Skills");
    expect(activeFooterLabel(markup)).toBe("Skills");
  });

  // CL-6817: the plugin detail stub ("still being built") is gone until
  // CL-6417 ships a real page. A slug under /plugins must not promise one.
  test("/plugins/<slug> is not-found, never a still-being-built stub (CL-6817)", async () => {
    const markup = await renderApp("/plugins/linear");
    expect(markup).toContain("Page not found");
    expect(markup).not.toContain("still being built");
    expect(markup).not.toContain("Back to Plugins");
    expect(activeFooterLabel(markup)).toBeUndefined();
  });

  test("a routine segment that resolves to nothing still titles itself and lights Routines", async () => {
    // Routines is a real page now, not a placeholder: with no routine
    // behind the segment it says so and offers the way back, rather than
    // rendering the roster under a URL that names nothing.
    const markup = await renderApp("/routines/weekly-digest");
    expect(stagePageTitle(markup)).toBe("weekly-digest");
    expect(markup).toContain("Back to Routines");
    expect(activeFooterLabel(markup)).toBe("Routines");
  });

  test("a slug-shaped path under no known entity renders the not-found screen", async () => {
    const markup = await renderApp("/agent/triage-bot");
    expect(markup).toContain("Page not found");
  });

  test("an unconsumable path under Plugins renders not-found, never the roster", async () => {
    const markup = await renderApp("/plugins/Not-A-Slug");
    expect(markup).toContain("Page not found");
    expect(activeFooterLabel(markup)).toBeUndefined();
  });

  test("a malformed percent-escape renders a screen instead of crashing", async () => {
    expect(await renderApp("/plugins/%")).toContain("Page not found");
    expect(await renderApp("/routines/%E0%A4%A")).toContain(
      'data-testid="shell-sidebar"',
    );
  });

  test("an unknown path renders the not-found screen", async () => {
    const markup = await renderApp("/no-such-screen");
    expect(markup).toContain("Page not found");
    expect(activeFooterLabel(markup)).toBeUndefined();
  });

  test("a /w/:workbenchId deep link waits for tenant resolution", async () => {
    const markup = await renderApp("/w/ch_deep");
    expect(markup).not.toContain('data-open="true"');
    expect(markup).toContain('data-testid="stage-top-bar"');
    expect(stagePageTitle(markup)).toBe("Workbenches");
  });
});
