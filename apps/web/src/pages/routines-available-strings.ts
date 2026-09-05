// Copy for the Routines page's "Available" section (CL-7073) — kept apart
// from JSX so a wording change never touches component logic. Every
// string here reads as consumer language: no "deploy", "asset", or other
// platform-side noun (see `scripts/checks/ui-vocabulary.ts`).

export const AVAILABLE_SECTION_TITLE = "Available";
export const AVAILABLE_SECTION_SUBTITLE = "Add one of these to this workbench.";

export const ADD_BUTTON_LABEL = "Add";
export const ADD_BUTTON_BUSY_LABEL = "Adding…";

export function addSuccessMessage(displayName: string): string {
  return `${displayName} added`;
}

export function addFailureMessage(displayName: string, detail: string): string {
  return `Couldn't add ${displayName}: ${detail}`;
}

/**
 * Every connector id `WORKFLOW_CATALOG` currently names as a required
 * connection (`packages/workflows/src/catalog.ts`), mapped to the
 * consumer-facing name the Plugins page shows for it. A connector id
 * with no entry here falls back to itself capitalized — never a raw
 * lowercase id in copy, but also never a silent crash for a future
 * catalog entry naming a connector this list hasn't caught up with yet.
 */
const CONNECTOR_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  github: "GitHub",
  granola: "Granola",
  linear: "Linear",
  exa: "Exa",
  scrapecreators: "ScrapeCreators",
  attio: "Attio",
};

function connectorDisplayName(connectorId: string): string {
  return (
    CONNECTOR_DISPLAY_NAMES[connectorId] ??
    connectorId.charAt(0).toUpperCase() + connectorId.slice(1)
  );
}

export function missingConnectionsReason(
  missingConnections: readonly string[],
): string {
  const names = missingConnections.map(connectorDisplayName);
  if (names.length === 1) {
    return `Connect ${names[0]} first.`;
  }
  return `Connect ${names.join(" and ")} first.`;
}

export const CONNECT_LINK_LABEL = "Go to Plugins";

export const NOT_DEPLOYABLE_YET_REASON =
  "Coming with the next platform update.";
