// The settings surface's shell: renders the active section's panel only.
// Section nav is a master-detail list — it lives in the host's own col2
// (see `resolveSettingsSectionGroups`), never repeated in the stage.
// Everything about what a section shows and how it saves lives in the
// section's own `render`, never here.

import { EmptyState } from "@corbits/react-ui";
import type { Icon } from "@corbits/icons";
import type { ReactElement } from "react";

import { SETTINGS_STRINGS } from "./strings";

/** Whatever shared context a section needs to do its own fetching: the
 * bench currently selected in the app's chrome, and the signed-in account's
 * principal on that bench (for permission probes). A section with no use
 * for either (Account, today) simply ignores the field. */
export type SettingsContext = {
  readonly tenantId: string | null;
  readonly principalId: string | null;
  /** Client-side navigation, for a section whose own content routes
   * elsewhere (e.g. Agents' "Start chat" opening a workbench). Sections with
   * no use for it simply ignore the field. */
  readonly navigate?: (to: string) => void;
  /** A sub-selection carried in the host's URL below the section id (e.g.
   * `/settings/agents/:definitionId`), so a section with its own
   * master-detail can restore the right selection on a deep link. */
  readonly entityId?: string | null;
  /** Ends the signed-in session — the same callback the shell's account
   * menu calls. Absent where the host has no sign-out concept of its own
   * (a package test rendering a section standalone); a section that
   * offers a Sign out action simply hides it when this is undefined. */
  readonly onSignOut?: () => void;
};

export type SettingsSection = {
  readonly id: string;
  readonly title: string;
  /** Leading icon for a host's own section nav (col2). */
  readonly icon: Icon;
  readonly render: (ctx: SettingsContext) => ReactElement;
  /** Tucks this section under a collapsed "Advanced" disclosure at the
   * bottom of its group's nav, instead of listing it as a peer section —
   * for sections whose mechanics (roles, grants, audit) nobody should have
   * to parse just to find the thing they actually came for. */
  readonly advanced?: boolean;
};

/** A labeled group of sections (Personal Settings / Shared Settings). */
export type SettingsSectionGroup = {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly SettingsSection[];
  /** Set when a tenancy probe for a gated section in this group failed
   *  (network/5xx), so a host can show a couldn't-check state instead of
   *  treating the absent sections as an authenticated deny. */
  readonly accessProbeFailed?: true;
};

export function flattenSettingsSections(
  groups: readonly SettingsSectionGroup[],
): readonly SettingsSection[] {
  return groups.flatMap((group) => group.sections);
}

/**
 * The section a shell should treat as active: the requested id if it names
 * a real section, otherwise the first section — never a crash, and never a
 * blank nav. `sections` is validated non-empty by the caller; an empty
 * registry is a distinct, deliberate empty state.
 */
export function resolveActiveSection(
  sections: readonly SettingsSection[],
  requestedId: string | null,
): SettingsSection | undefined {
  if (requestedId !== null) {
    const match = sections.find((section) => section.id === requestedId);
    if (match !== undefined) return match;
  }
  return sections[0];
}

export function SettingsShell({
  sections,
  context,
  activeId,
}: {
  readonly sections: readonly SettingsSection[];
  readonly context: SettingsContext;
  /** The active section id, resolved by the host from the URL. `null`
   * defers to the shell's own fallback (the first section). */
  readonly activeId: string | null;
}) {
  const firstSection = sections[0];
  if (firstSection === undefined) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.emptySectionsTitle}
        description={SETTINGS_STRINGS.emptySectionsDescription}
      />
    );
  }

  const activeSection =
    resolveActiveSection(sections, activeId) ?? firstSection;

  return (
    <div className="settings-shell">
      {/* No repeated "Settings · Section" heading here — the host's stage
          top bar already carries it, and every section card names itself. */}
      <div className="settings-stage" key={activeSection.id}>
        <div className="settings-stage-body">
          {activeSection.render(context)}
        </div>
      </div>
    </div>
  );
}
