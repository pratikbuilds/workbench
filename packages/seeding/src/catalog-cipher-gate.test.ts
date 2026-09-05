import { describe, expect, test } from "bun:test";

import {
  CATALOG_WORKFLOWS,
  catalogWorkflowDeployableOnThisPin,
  catalogWorkflowRequiresCredentialCipher,
} from "./seed";

// The six catalog entries whose definitions carry `credentialBindings`
// (CL-7073 catalog critique finding 1): `deployCodeSourcedWorkflow`
// (vendor/intx/hub-sessions) refuses to resolve these without a
// `credentialCipher`, a seam the current pin's
// `POST /template-blocks/:assetName/deploy` front does not supply. This
// is the one list asserted against the derivation helper — the route
// refusal, the available-catalog `deployable: false` flag, and the e2e
// exclusion list all call `catalogWorkflowDeployableOnThisPin` instead of
// keeping their own copy.
const CREDENTIAL_BOUND_ASSET_NAMES = [
  "granola-call",
  "morning-brief",
  "process-granola-call",
  "pain-point-collateral",
  "collateral-generation",
  "diligence-brief",
];

describe("catalogWorkflowRequiresCredentialCipher", () => {
  test("names exactly the six credential-bound catalog entries", () => {
    const flagged = CATALOG_WORKFLOWS.filter((entry) =>
      catalogWorkflowRequiresCredentialCipher(entry),
    ).map((entry) => entry.assetName);
    expect(flagged.sort()).toEqual([...CREDENTIAL_BOUND_ASSET_NAMES].sort());
  });
});

describe("catalogWorkflowDeployableOnThisPin", () => {
  test("is false for every credential-bound entry", () => {
    for (const assetName of CREDENTIAL_BOUND_ASSET_NAMES) {
      expect(catalogWorkflowDeployableOnThisPin(assetName)).toBe(false);
    }
  });

  test("is true for a catalog entry with no credential bindings", () => {
    expect(catalogWorkflowDeployableOnThisPin("code-review")).toBe(true);
  });

  test("is false for a name outside the catalog entirely", () => {
    expect(catalogWorkflowDeployableOnThisPin("not-a-real-workflow")).toBe(
      false,
    );
  });
});
