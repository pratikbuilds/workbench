# `@workbench/web`

The workbench's single-page interface: every screen and route lives here,
composed from the published `@corbits/react-ui` component library, and
builds to a static bundle the hub serves from its own origin (`vite
build`, then point `HUB_STATIC_DIR` at `apps/web/dist`). It is a Vite SPA
over the hub's `/api` — every product rule (what a screen may show, how
data is shaped) lives in a package; this app stays a generic composition
of package UI and routing, per [AGENTS.md](../../AGENTS.md). In dev,
`vite dev` proxies `/api` to a locally running hub so the interface is
developed against real data without a build step.

## Layout

Every signed-in screen renders inside the same four-column shell
(`src/shell/`), built from `@corbits/react-ui`'s sidebar panel pieces plus a
workbench-composed rail:

1. **Rail** — global and stable: it never changes with navigation or with
   the selected bench. One icon per screen with its name captioned
   underneath (not tooltip-only), plus the bench switcher and the
   signed-in account's settings/sign-out at the bottom. Answers "where am I
   in the product, and which bench am I in". Fixed width at every
   breakpoint — it never joins the columns that withdraw as the viewport
   narrows.
2. **Contextual column** — bench-scoped and live: workbenches, chats, running
   routines, and notifications for the _currently selected_ bench. It
   refetches when the bench changes, not when the route does, so its
   contents can persist or travel across page navigation rather than being
   a per-page list. Answers "what is happening in this bench right now".
3. **Main pane** — whatever the route renders, taking all remaining width.
4. **Canvas** — an optional fourth column for running agents, live
   workflow walkthroughs and analytics. Collapsed by default and collapsed
   to zero width, so the main pane holds the space until it is opened.

The shell reflows as the viewport narrows rather than scrolling sideways:
the canvas column (and its toggle) is withdrawn first below roughly 1100px,
and the contextual column follows below roughly 700px, leaving the rail and
the main pane. The widths themselves are fluid (`clamp`/`vw`), so a future
chat dock squeezing the content area resizes the columns instead of
clipping them.

A new page needs one entry in `NAV_ROUTES` (`src/routes.tsx`) — the rail's
icon and the route switch both read from that single table, so a page
cannot appear in one without the other. The contextual column no longer
reads `NAV_ROUTES` at all: it has nothing to do with which pages exist.

Running routines in the contextual column are sourced today from
`@corbits/chat-ui`'s workflow-run listing (`src/shell/routine-activity.ts`)
— the column depends only on that file's `RoutineActivityItem` shape.

## Screens

| Path         | What it shows                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | Home — a welcome summary of the signed-in account's benches and runs.                                                                                                        |
| `/c`         | Workbench deep-link surface. On wide layouts the conversation opens in the right canvas; on compact layouts it fills the main pane. Legacy `/chat` links still resolve here. |
| `/workflows` | Workflow runs executing across your benches.                                                                                                                                 |
| `/library`   | The artifact gallery. See "Library" below.                                                                                                                                   |
| `/settings`  | Account, bench membership, and (CL-5990) Agents/Skills. See "Agents" and "Skills" below.                                                                                     |

Agents and Skills are Settings sections, not rail destinations — old
`/agents[/:id]` and `/skills[/:id]` links still resolve, redirecting to
`/settings/agents[/:id]` and `/settings/skills[/:id]`.

Approvals are not a page: pending permission requests land as actionable
cards in the contextual panel's Notifications band (and, when a workbench is
open, inline in that workbench). The `/approvals` route is gone.

## Tests

- **Unit tests** for pure modules (path helpers, reducers, parsers) sit next
  to the source file under `src/` as `*.test.ts`.
- **Integration / composition / shell probes** stay under `test/`.
- `bun test` (via the package script) runs both `./src` and `./test`.

## Library

`/library` (`src/pages/library-page.tsx`) is the artifact gallery: search,
sort, a grid/rows view toggle, kind-colored cards, and upload, built
against the `ArtifactSummary` type from `@corbits/artifact-ui`.
`LibraryRoute` reads and searches the tenant's artifacts from the real
`/api/tenants/:id/artifacts` (list/detail) endpoint; a chat artifact
chip's "Open in Library" link (`/library/a/:id`) deep-links into the same
route.

## Agents

Settings · Agents (`src/pages/agents-settings-section.tsx`, registered via
`src/settings-workspace-sections.tsx`) is definitions only — a bench's
directory of agent definitions and their deployed instances, with Start
chat / Open in workbench as its only reach into chat. Talking to an agent is a
chat; looping one into a conversation is a workbench mention — neither lives
here. See `docs/AGENTS-PAGE.md`.

## Skills

Settings · Skills (`src/pages/skills-settings-section.tsx`) is an honest
stub: there is no skill registry in the hub yet, so the section states what
a skill will be instead of rendering invented rows.
