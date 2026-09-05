// Settings section nav: the master list of the settings surface, rendered
// inside the stage beside the active section (master-detail — the list is
// never repeated in the section panel). Grouping, gating, and icons come
// from `@corbits/settings-ui`'s section registry
// (`resolveSettingsSectionGroups`); this component only adapts the app's
// scope context and router around it.

import { SidebarItemRow } from "@corbits/react-ui";
import { SETTINGS_STRINGS } from "@corbits/settings-ui";

import { useBench } from "../bench-context";
import { SETTINGS_PATH_PREFIX, settingsSectionIdFromPath } from "../path-ids";
import { resolveAppSettingsSectionGroups } from "../settings-groups";
import { useSettingsAccess } from "../settings-access";

export function SettingsNav({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const access = useSettingsAccess(selectedTenantId, selectedPrincipalId);
  const groups = resolveAppSettingsSectionGroups(access);
  const activeId = settingsSectionIdFromPath(path);

  return (
    <nav
      className="settings-nav"
      aria-label={SETTINGS_STRINGS.sectionsNavLabel}
    >
      {groups.map((group) => {
        const primary = group.sections.filter(
          (section) => section.advanced !== true,
        );
        const advanced = group.sections.filter(
          (section) => section.advanced === true,
        );
        return (
          <div key={group.id} className="settings-nav-group">
            <p className="settings-nav-heading">{group.label}</p>
            {group.accessProbeFailed === true && (
              <p className="settings-nav-access-error">
                {SETTINGS_STRINGS.accessProbeFailedHint}
              </p>
            )}
            {primary.map((section) => {
              const Icon = section.icon;
              return (
                <SidebarItemRow
                  key={section.id}
                  name={section.title}
                  leading={<Icon aria-hidden="true" />}
                  selected={section.id === activeId}
                  onSelect={() =>
                    onNavigate(`${SETTINGS_PATH_PREFIX}/${section.id}`)
                  }
                />
              );
            })}
            {advanced.length > 0 && (
              <details
                className="settings-nav-advanced"
                open={advanced.some((section) => section.id === activeId)}
              >
                <summary>{SETTINGS_STRINGS.advancedSectionsSummary}</summary>
                <p className="settings-nav-advanced-hint">
                  {SETTINGS_STRINGS.advancedSectionsHint}
                </p>
                {advanced.map((section) => {
                  const Icon = section.icon;
                  return (
                    <SidebarItemRow
                      key={section.id}
                      name={section.title}
                      leading={<Icon aria-hidden="true" />}
                      selected={section.id === activeId}
                      onSelect={() =>
                        onNavigate(`${SETTINGS_PATH_PREFIX}/${section.id}`)
                      }
                    />
                  );
                })}
              </details>
            )}
          </div>
        );
      })}
    </nav>
  );
}
