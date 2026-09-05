// Tenant-scoped API for the "run this workbench on its own sidecar"
// setting. Read gated separately from write, mirroring every other
// settings surface mounted alongside this one (@corbits/bench,
// @corbits/preferences).
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { makeErrorEnvelope } from "@corbits/error-sink";

import type { SidecarPlacementStore } from "./store";

const PutBody = type({ enabled: "boolean" });

export type CreateSidecarPlacementRoutesDeps = {
  store: SidecarPlacementStore;
  requireGrant: RequireGrant;
  /**
   * Whether the host has a sidecar provisioner registered. The workbench
   * hub always does — an unconfigured install registers the `process`
   * backend — but this package is a library, so a host that registers
   * none must still get an honest answer. When false, exclusive
   * placement can never actually take effect — enabling it would silently
   * leave a workbench on the shared sidecar despite the setting reading
   * "on" — so PUT enabling it fails closed with 409, and GET exposes the
   * flag so the settings UI can disable the toggle with an honest hint
   * instead of letting an operator break deployments.
   */
  hasProvisioner: boolean;
};

export function createSidecarPlacementRoutes(
  deps: CreateSidecarPlacementRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("sidecar-placement:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const enabled = await deps.store.getEnabled(tenant.id);
    return c.json({ enabled, provisionerAvailable: deps.hasProvisioner });
  });

  app.put("/", deps.requireGrant("sidecar-placement:*", "write"), async (c) => {
    const tenant = c.get("tenant");

    const raw = await c.req.json().catch(() => undefined);
    const body = PutBody(raw);
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid body: ${body.summary}`,
        }),
        400,
      );
    }

    if (body.enabled && !deps.hasProvisioner) {
      return c.json(
        makeErrorEnvelope({
          code: "no_provisioner_configured",
          userMessage:
            "Isolated capacity isn't available on this server yet. Ask your operator to enable it before turning this on.",
        }),
        409,
      );
    }

    const enabled = await deps.store.setEnabled(tenant.id, body.enabled);
    return c.json({ enabled, provisionerAvailable: deps.hasProvisioner });
  });

  return app;
}
