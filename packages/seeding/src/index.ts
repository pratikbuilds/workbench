// The library entry for `@corbits/seeding`: deploys the default workflow
// set for an already-known tenant, plants skills, and confirms every
// deployment answers. Both the boot-time root-tenant seed and the
// first-login provisioning hook consume this so the tenant-seeding
// logic is implemented once.

export type {
  DefaultWorkflow,
  EnsureCredentialArgs,
  EnsureProviderArgs,
  ModelSource,
  PushOutcome,
  SeedCatalogArgs,
  SeedCatalogResult,
  SeedTenant,
  SeedTenantArgs,
  ToolRegistryPublisher,
  WorkflowPusher,
} from "./seed";
export {
  CATALOG_TEST_WORKFLOWS,
  CATALOG_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  SEED_GRANTS,
  catalogWorkflowDeployableOnThisPin,
  catalogWorkflowRequiresCredentialCipher,
  deployableCatalogWorkflow,
  inferenceCredentialName,
  PLACEHOLDER_CATALOG_API_KEY,
  ensureCredential,
  ensureProvider,
  reconcileSeedGrants,
  seedCatalog,
  seedTenant,
  isLiveDeploymentStatus,
  SETUP_AGENT_ASSET_NAME,
} from "./seed";
export {
  publishCorbitsToolsRegistry,
  isCorbitsToolsRegistrySeeded,
  tarballsCoverRequiredSeedPackages,
  type PublishCorbitsToolsRegistryArgs,
  type PublishCorbitsToolsRegistryResult,
  type PublishSummary,
} from "@corbits/tool-registry-publish";
export {
  CATALOG_SEEDS,
  deriveWorkbenchHostInferencePreferences,
} from "./catalog-seed-data";
export type {
  CatalogModelSpec,
  CatalogProviderSeed,
  CatalogProviderSpec,
  WorkbenchHostInferencePreference,
} from "./catalog-seed-data";
export { createGitWorkflowPusher } from "./workflow-push";
