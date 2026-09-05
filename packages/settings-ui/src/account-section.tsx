// Personal Settings' opening section: a glanceable Account card (avatar,
// name, email — copyable — and Sign out), the same name/email/verified
// readout as before tucked below as a quieter subsection (still read-only —
// there is no native profile-update route; see `vendor/intx/hub-api/src/
// routes` — only tenants and principals carry a PATCH), an Appearance card
// wired to `@corbits/react-ui`'s three-state ThemeProvider, and an Agent
// card whose Timezone row is display-only until a hub preference store
// exists to write it to.

import {
  Avatar,
  Badge,
  Button,
  SettingsPanel,
  isThemeMode,
  toast,
  useTheme,
} from "@corbits/react-ui";
import { Select } from "@corbits/react-ui/ui/select";
import { Copy, SignOut } from "@corbits/icons";
import { useCallback, useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import { resolveAvatarFill } from "@corbits/chat-ui";
import { getAccount, type Account } from "./api";
import { SETTINGS_STRINGS } from "./strings";

export function AccountSection({
  onSignOut,
}: {
  readonly onSignOut?: () => void;
}) {
  const [query, setQuery] = useState<APIQuery<Account>>({ kind: "loading" });

  const load = useCallback(() => {
    setQuery({ kind: "loading" });
    let cancelled = false;
    getAccount()
      .then((account) => {
        if (!cancelled) setQuery({ kind: "ready", data: account });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: load,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <>
      <QueryView query={query} label={SETTINGS_STRINGS.accountLoadError}>
        {(account) => (
          <AccountSectionView
            id={account.id}
            name={account.name}
            email={account.email}
            emailVerified={account.emailVerified}
            {...(account.image !== null && account.image !== undefined
              ? { image: account.image }
              : {})}
            {...(onSignOut !== undefined ? { onSignOut } : {})}
          />
        )}
      </QueryView>
      <AppearanceSection />
      <AgentGeneralSection />
    </>
  );
}

/** First and (if present) second-word initials, upper-cased. Falls back to
 * "?" for an empty name rather than rendering a blank avatar. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.charAt(0) ?? "";
  const second = words.length > 1 ? (words[1]?.charAt(0) ?? "") : "";
  const initials = `${first}${second}`.toUpperCase();
  return initials.length > 0 ? initials : "?";
}

async function copyEmail(email: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(email);
    toast(SETTINGS_STRINGS.accountEmailCopiedToast);
  } catch {
    toast(SETTINGS_STRINGS.accountEmailCopyError);
  }
}

/**
 * The account panel's markup on its own, taking already-resolved display
 * fields — kept separate from `AccountSection` for the same reason
 * `BenchSectionView` is: directly renderable in tests without a fetch stub.
 */
export function AccountSectionView({
  id,
  name,
  email,
  emailVerified,
  image,
  onSignOut,
}: {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly image?: string;
  readonly onSignOut?: () => void;
}) {
  const fill = resolveAvatarFill(id, image);
  return (
    <SettingsPanel title={SETTINGS_STRINGS.accountSectionTitle}>
      <div className="settings-account-card">
        <div className="settings-account-identity">
          {fill.kind === "image" ? (
            <img
              className="settings-account-avatar-image"
              src={fill.url}
              alt={name}
              width={40}
              height={40}
            />
          ) : (
            <Avatar
              initials={initialsOf(name)}
              label={name}
              size="lg"
              className={fill.className}
            />
          )}
          <div className="settings-account-identity-text">
            <span className="settings-account-name">{name}</span>
            <span className="settings-account-email">
              {email}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={SETTINGS_STRINGS.accountCopyEmailAction}
                title={SETTINGS_STRINGS.accountCopyEmailAction}
                onClick={() => void copyEmail(email)}
              >
                <Copy />
              </Button>
            </span>
          </div>
        </div>
        {onSignOut !== undefined ? (
          <Button
            variant="outline"
            className="settings-account-signout"
            onClick={onSignOut}
          >
            <SignOut /> {SETTINGS_STRINGS.accountSignOutAction}
          </Button>
        ) : null}
      </div>

      <div className="settings-account-details">
        <h3 className="settings-subhead settings-subhead-quiet">
          {SETTINGS_STRINGS.accountDetailsHeading}
        </h3>
        <dl className="settings-detail-list">
          <dt>{SETTINGS_STRINGS.accountNameLabel}</dt>
          <dd>{name}</dd>
          <dt>{SETTINGS_STRINGS.accountEmailLabel}</dt>
          <dd>
            {email}{" "}
            <Badge tone={emailVerified ? "success" : "neutral"}>
              {emailVerified ? "verified" : "unverified"}
            </Badge>
          </dd>
        </dl>
        <p className="settings-field-hint">
          {SETTINGS_STRINGS.accountReadOnlyNote}
        </p>
      </div>
    </SettingsPanel>
  );
}

/** Theme row, wired to `ThemeProvider`'s three-state mode contract — the
 * host mounts `ThemeProvider` once near the app root, so `setMode` here
 * both applies and persists the choice with no storage code of our own. */
export function AppearanceSection() {
  const { mode, setMode } = useTheme();
  return (
    <SettingsPanel title={SETTINGS_STRINGS.appearanceSectionTitle}>
      <label className="settings-form-field settings-form-field-inline">
        <span>{SETTINGS_STRINGS.appearanceThemeLabel}</span>
        <Select
          className="settings-appearance-select"
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            if (isThemeMode(next)) setMode(next);
          }}
        >
          <option value="system">{SETTINGS_STRINGS.themeFollowSystem}</option>
          <option value="light">{SETTINGS_STRINGS.themeLight}</option>
          <option value="dark">{SETTINGS_STRINGS.themeDark}</option>
        </Select>
      </label>
    </SettingsPanel>
  );
}

/** Timezone row: display-only, derived from the browser — there is no hub
 * preference store yet for a per-user timezone override, so this shows the
 * auto-detected zone honestly instead of a dropdown that saves nothing. */
export function AgentGeneralSection() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <SettingsPanel title={SETTINGS_STRINGS.generalAgentGroupTitle}>
      <div className="settings-form-field settings-form-field-inline">
        <span>{SETTINGS_STRINGS.agentTimezoneLabel}</span>
        <span className="settings-static-value">
          {SETTINGS_STRINGS.agentTimezoneAutoDetect(timezone)}
        </span>
      </div>
    </SettingsPanel>
  );
}
