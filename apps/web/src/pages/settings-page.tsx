// Thin mount of `@corbits/settings-ui`'s shell: the package owns the section
// registry (Account / Everyone groups, icons, tenancy gates — see
// `resolveSettingsSectionGroups`); this file only adapts the app's
// bench-selection state (see ../bench-context.tsx) and the URL into the
// shape the package expects. `/settings` defaults to the first allowed
// section; `/settings/:section` deep-links directly to it. The section nav
// renders here in the stage, beside the active section (`settings-nav.tsx`)
// — master-detail, the list is never repeated in the section panel.

import {
  flattenSettingsSections,
  resolveActiveSection,
  SettingsShell,
} from "@corbits/settings-ui";
import { PageShell } from "@corbits/react-ui";
import { useEffect } from "react";

import { useBench } from "../bench-context";
import { useSignOut } from "../navigation";
import {
  SETTINGS_PATH_PREFIX,
  settingsEntityIdFromPath,
  settingsSectionIdFromPath,
} from "../path-ids";
import { resolveAppSettingsSectionGroups } from "../settings-groups";
import { SettingsNav } from "./settings-nav";
import { StageTopBar } from "../shell/stage-top-bar";
import { useSettingsAccess } from "../settings-access";

export function SettingsRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const onSignOut = useSignOut();
  const access = useSettingsAccess(selectedTenantId, selectedPrincipalId);
  const groups = resolveAppSettingsSectionGroups(access);
  const sections = flattenSettingsSections(groups);
  const requestedId = settingsSectionIdFromPath(path);
  const activeSection = resolveActiveSection(sections, requestedId);
  const entityId =
    activeSection === undefined
      ? null
      : settingsEntityIdFromPath(path, activeSection.id);
  const requestedSectionExists =
    requestedId !== null &&
    sections.some((section) => section.id === requestedId);
  // A gated section (People/Roles/Grants/Credentials) is absent from
  // `sections` while its probe is still resolving, same as when it's
  // genuinely denied — wait for every gate to settle before treating a
  // miss as final, or a deep link to an about-to-be-allowed section would
  // bounce away before its probe finishes. `error` is settled: the
  // registry withholds the section and the nav shows a couldn't-check
  // state rather than pretending the principal is unauthorized.
  const accessSettled =
    access.people !== "loading" &&
    access.roles !== "loading" &&
    access.grants !== "loading" &&
    access.credentials !== "loading";

  const activeSectionId = activeSection?.id ?? null;

  // Bare /settings, and an unknown or gate-denied /settings/:section, both
  // correct to the first allowed section's own URL — never a fallback
  // rendered under a URL the section nav disagrees with. Depends on
  // `activeSectionId` (a primitive), not `activeSection` (a fresh object
  // every render, since `resolveSettingsSectionGroups` isn't memoized) —
  // otherwise an unrelated re-render (e.g. BenchProvider persisting the
  // resolved tenant id) would refire this and double-navigate.
  useEffect(() => {
    if (activeSectionId === null) return;
    if (requestedId !== null && requestedSectionExists) return;
    if (requestedId !== null && !accessSettled) return;
    navigate(`${SETTINGS_PATH_PREFIX}/${activeSectionId}`);
  }, [
    requestedId,
    requestedSectionExists,
    accessSettled,
    activeSectionId,
    navigate,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={
          activeSection === undefined
            ? [{ label: "Settings" }]
            : [
                { label: "Settings", href: SETTINGS_PATH_PREFIX },
                { label: activeSection.title },
              ]
        }
      />
      <div className="settings-layout min-h-0 flex-1">
        <SettingsNav path={path} onNavigate={navigate} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PageShell width="full" className="page-fill">
            <SettingsShell
              sections={sections}
              activeId={activeSection?.id ?? null}
              context={{
                tenantId: selectedTenantId,
                principalId: selectedPrincipalId,
                navigate,
                entityId,
                ...(onSignOut !== undefined ? { onSignOut } : {}),
              }}
            />
          </PageShell>
        </div>
      </div>
    </div>
  );
}
