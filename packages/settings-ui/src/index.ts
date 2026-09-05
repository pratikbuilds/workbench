export {
  SettingsShell,
  resolveActiveSection,
  flattenSettingsSections,
} from "./shell";
export type {
  SettingsContext,
  SettingsSection,
  SettingsSectionGroup,
} from "./shell";

export {
  resolveSettingsSectionGroups,
  insertEveryoneSections,
} from "./section-registry";

export {
  AccountSection,
  AccountSectionView,
  AppearanceSection,
  AgentGeneralSection,
} from "./account-section";
// NotificationsSection is not exported: it is draft-only and not in the
// registry (CL-6843). Re-export when a preference store backs it.
export { AuditSection } from "./audit-section";
export { AccessPolicyBlock, AccessPolicyEditor } from "./access-policy";
export {
  PeopleSection,
  PeopleTable,
  InvitePersonDialog,
} from "./people-section";
export {
  RolesSection,
  RolesTable,
  RoleAssignments,
  CreateRoleDialog,
} from "./roles-section";
export {
  GrantsSection,
  GrantsTable,
  CreateGrantDialog,
} from "./grants-section";
export {
  ConnectionsSection,
  ConnectorRowList,
  ConnectorCredentialDialog,
  oauthStartHref,
} from "./connections-section";

export { GranolaWebhookCard } from "./granola-webhook-card";

export {
  CopyButton,
  CopyableCodeRow,
  WebhookSecretPanel,
} from "./webhook-secret-panel";

export {
  grantPreviewSentence,
  expiryIsoFromPreset,
  expiryLabelFromPreset,
} from "./grant-preview";
export type { GrantPreviewInput } from "./grant-preview";
export { KindCards } from "./kind-cards";
export type { KindCardOption } from "./kind-cards";

export { principalLabel } from "./identity";
export type { PrincipalLabel } from "./identity";

export { GRANT_RESOURCES, GRANT_ACTIONS } from "./resource-vocabulary";
export type { GrantResource, GrantAction } from "./resource-vocabulary";

export {
  useTenancyAccess,
  probeSectionAccess,
  coalesceSectionAccess,
} from "./access";
export type { SectionAccess, TenancyAccess } from "./access";

export {
  TenancyApiError,
  listPrincipals,
  updatePrincipalStatus,
  removePrincipal,
  listRoles,
  createRole,
  renameRole,
  deleteRole,
  assignRole,
  unassignRole,
  listGrants,
  createGrant,
  revokeGrant,
  evaluate,
} from "./tenancy-api";
export type {
  Principal,
  Role,
  Grant,
  GrantFilters,
  CreateGrantInput,
} from "./tenancy-api";

export {
  CredentialsApiError,
  listCredentials,
  listProviders,
  createCredential,
  deleteCredential,
} from "./credentials-api";
export type {
  Credential,
  Provider,
  CreateCredentialInput,
} from "./credentials-api";

export {
  ConnectionsApiError,
  completeConnectorCredential,
  disconnectConnector,
  fetchOAuthConfigured,
} from "./connections-api";

export { connectorStatus } from "./connections-status";
export type {
  ConnectorStatus,
  ConnectorStatusResult,
} from "./connections-status";

export { CONNECTOR_PINNED_WORKFLOWS } from "./connections-pinned-by";

export { SETTINGS_STRINGS } from "./strings";

export {
  SettingsApiError,
  getAccount,
  getAuthConfig,
  renameBench,
} from "./api";
export type { Account, AuthConfig, Bench } from "./api";
