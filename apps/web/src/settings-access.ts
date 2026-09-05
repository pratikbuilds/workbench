// Settings section-nav gating, deduplicated: col2's nav band and the
// settings stage both mount independently and both need the same four
// tenancy probes (People/Roles/Grants/Credentials). Riding the app's shared
// QueryClient — instead of each mount calling `@corbits/settings-ui`'s bare
// `useTenancyAccess`, which fetches on every mount with no cache — means
// two mounted consumers share one in-flight request and one cached result.
// The package stays free of TanStack Query: this only injects the
// package's probe into the app's cache, the package never imports Query.

import {
  coalesceSectionAccess,
  probeSectionAccess,
} from "@corbits/settings-ui";
import type { TenancyAccess } from "@corbits/settings-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { tenantKeys } from "./query-client";

const LOADING_ACCESS: TenancyAccess = {
  people: "loading",
  roles: "loading",
  grants: "loading",
  credentials: "loading",
};

function coalesceTenancyAccess(
  previous: TenancyAccess | undefined,
  next: TenancyAccess,
): TenancyAccess {
  const prior = previous ?? LOADING_ACCESS;
  return {
    people: coalesceSectionAccess(prior.people, next.people),
    roles: coalesceSectionAccess(prior.roles, next.roles),
    grants: coalesceSectionAccess(prior.grants, next.grants),
    credentials: coalesceSectionAccess(prior.credentials, next.credentials),
  };
}

/** One shared probe per (tenant, principal), not one per mounted consumer.
 * `null` ids report `loading` — the same "not shown yet, never disabled"
 * contract `@corbits/settings-ui`'s own hook holds. A thrown evaluate
 * (network/5xx) is `error`, not `denied`; a refetch failure keeps the
 * last allow/deny so gated nav does not vanish as if unauthorized. */
export function useSettingsAccess(
  tenantId: string | null,
  principalId: string | null,
): TenancyAccess {
  const queryClient = useQueryClient();
  const enabled = tenantId !== null && principalId !== null;
  const queryKey =
    tenantId !== null && principalId !== null
      ? tenantKeys.settingsAccess(tenantId, principalId)
      : tenantKeys.settingsAccess("none", "none");
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<TenancyAccess> => {
      if (tenantId === null || principalId === null) return LOADING_ACCESS;
      const previous = queryClient.getQueryData<TenancyAccess>(queryKey);
      const [people, roles, grants, credentials] = await Promise.all([
        probeSectionAccess(tenantId, principalId, "principal"),
        probeSectionAccess(tenantId, principalId, "role"),
        probeSectionAccess(tenantId, principalId, "grant"),
        probeSectionAccess(tenantId, principalId, "credential"),
      ]);
      return coalesceTenancyAccess(previous, {
        people,
        roles,
        grants,
        credentials,
      });
    },
    enabled,
  });

  return query.data ?? LOADING_ACCESS;
}
