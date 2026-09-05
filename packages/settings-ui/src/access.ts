// Whether the People/Roles/Grants/Credentials sections belong in the
// settings nav at all, decided the way the rest of this surface's og
// pages already gate access: never a disabled tab, just an absent one.
// There's no capability listing to read this off of, so this probes the
// one grant-checked route that requires no grant of its own —
// `evaluate` — for the resource each section is built on.
// A 200 whose effect is not `allow` is an authenticated deny. A thrown
// probe (network, 5xx) is `error`, never `denied` — collapsing those
// together made the gated nav vanish as if the principal were
// unauthorized (CL-6829).

import { useEffect, useState } from "react";

import { evaluate } from "./tenancy-api";

export type SectionAccess = "loading" | "allowed" | "denied" | "error";

export type TenancyAccess = {
  readonly people: SectionAccess;
  readonly roles: SectionAccess;
  readonly grants: SectionAccess;
  readonly credentials: SectionAccess;
};

/** Maps one evaluate call to a nav gate. Catch is `error`, not `denied`. */
export async function probeSectionAccess(
  tenantId: string,
  principalId: string,
  resource: string,
): Promise<SectionAccess> {
  try {
    const result = await evaluate(tenantId, principalId, resource, "read");
    return result.effect === "allow" ? "allowed" : "denied";
  } catch {
    // report-error-ignore: CL-6829 — a failed evaluate probe is the
    // `error` nav state, not an unexpected exception to report.
    return "error";
  }
}

/** A failed probe must not clobber a prior allow/deny — only an unresolved
 *  gate becomes `error`. That keeps last-known nav and avoids flashing
 *  gated sections that a later successful deny would hide. */
export function coalesceSectionAccess(
  previous: SectionAccess,
  next: SectionAccess,
): SectionAccess {
  if (next === "error" && (previous === "allowed" || previous === "denied")) {
    return previous;
  }
  return next;
}

function useResourceAccess(
  tenantId: string | null,
  principalId: string | null,
  resource: string,
): SectionAccess {
  const [access, setAccess] = useState<SectionAccess>("loading");

  useEffect(() => {
    if (tenantId === null || principalId === null) {
      setAccess("loading");
      return;
    }
    let cancelled = false;
    setAccess("loading");
    void probeSectionAccess(tenantId, principalId, resource).then((next) => {
      if (!cancelled) setAccess(next);
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId, principalId, resource]);

  return access;
}

/** One probe per section, run in parallel — a section stays out of the nav
 * until its probe resolves `allowed`, so a slow probe reads as "not shown
 * yet", never as a visible-but-disabled tab. A failed probe is `error`,
 * not `denied`: the registry withholds the section but marks the group so
 * a host can show a couldn't-check state instead of looking unauthorized. */
export function useTenancyAccess(
  tenantId: string | null,
  principalId: string | null,
): TenancyAccess {
  return {
    people: useResourceAccess(tenantId, principalId, "principal"),
    roles: useResourceAccess(tenantId, principalId, "role"),
    grants: useResourceAccess(tenantId, principalId, "grant"),
    credentials: useResourceAccess(tenantId, principalId, "credential"),
  };
}
