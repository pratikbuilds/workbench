// Publishes the packed `@corbits/*-tools` tarballs into a tenant's
// `corbits-tools` package-registry asset over the hub's native REST
// asset routes (find-or-create the asset, then `PUT` each tarball) —
// the only supported write path for a non-hub principal
// (`vendor/intx/hub-sessions/src/package-registry-kind.ts`'s
// `packageRegistryAuthorize`). Idempotent: re-running overwrites
// same-name tarball entries and reuses an existing registry asset.

import { createHash } from "node:crypto";
import { AssetResponse, AssetWithOriginResponse } from "@intx/types";
import { type, type Type } from "arktype";
import { checkToolPackageFreshness } from "./freshness-check";
import { materializePackages } from "./materialize";
import { packToolPackageTarball, type PackedTarball } from "./pack";
import {
  CORBITS_TOOL_PACKAGE_DIRS,
  CORBITS_TOOLS_REGISTRY,
  REQUIRED_SEED_TOOL_PACKAGES,
  tarballCoversPackage,
  tarballsCoverRequiredSeedPackages,
} from "./registry";

export type ApiResult = { status: number; data: unknown; cookies: string[] };

/**
 * SRI-shaped integrity of `bytes`, matching `ssri.fromData(bytes, {
 * algorithms: ["sha512"] })`'s default single-hash output
 * (`vendor/intx/hub-api/src/routes/assets.ts`'s tarball-list route
 * computes the same way). Computed locally with `node:crypto` rather
 * than adding an `ssri` dependency for one hash.
 */
export function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Structurally compatible with `@corbits/hub-api-client`'s `ApiCall` — declared locally so this package never depends on it, which depends on this one. */
export type ApiCall = (
  method: string,
  path: string,
  body?: unknown,
  cookies?: string[],
) => Promise<ApiResult>;

const TarballPutResponse = type({ commit: "string", integrity: "string" });

export type PublishSummary = {
  filename: string;
  commit: string;
  integrity: string;
};

function parseSchema<T extends Type>(
  schema: T,
  data: unknown,
  label: string,
): T["infer"] {
  const result = schema(data);
  if (result instanceof type.errors) {
    throw new Error(
      `publishCorbitsToolsRegistry: validation failed for ${label}: ${result.summary}`,
    );
  }
  return result;
}

async function listRegistryAsset(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<string | undefined> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=false`,
    undefined,
    cookies,
  );
  if (listed.status !== 200) {
    throw new Error(
      `publishCorbitsToolsRegistry: failed to list assets: ${String(listed.status)}`,
    );
  }
  const rows = parseSchema(
    AssetWithOriginResponse.array(),
    listed.data,
    "list assets response",
  );
  return rows.find((row) => row.name === CORBITS_TOOLS_REGISTRY)?.id;
}

/**
 * Create-first, list-on-conflict — the same ensure-then-create
 * tolerance `seedTenant`'s own `ensureWorkflowAsset` uses, so two
 * overlapping seed runs for the same tenant never both fail on a
 * name collision the substrate itself reports as a 409.
 */
async function ensureRegistryAsset(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<string> {
  const existing = await listRegistryAsset(api, cookies, tenantId);
  if (existing !== undefined) return existing;

  const created = await api(
    "POST",
    `/api/tenants/${tenantId}/assets`,
    { kind: "package-registry", name: CORBITS_TOOLS_REGISTRY },
    cookies,
  );
  if (created.status === 201) {
    return parseSchema(AssetResponse, created.data, "create asset response").id;
  }
  if (created.status !== 409) {
    throw new Error(
      `publishCorbitsToolsRegistry: failed to create the ${CORBITS_TOOLS_REGISTRY} asset: ${String(created.status)}`,
    );
  }

  const afterConflict = await listRegistryAsset(api, cookies, tenantId);
  if (afterConflict === undefined) {
    throw new Error(
      `publishCorbitsToolsRegistry: the ${CORBITS_TOOLS_REGISTRY} asset reported a name conflict but is not listable on the tenant`,
    );
  }
  return afterConflict;
}

const TarballSummary = type({
  filename: "string",
  size: "number",
  integrity: "string",
});
const TarballListResponse = TarballSummary.array();

/**
 * Thrown when a tarball whose filename (hence its `name@version`) is
 * already published to the registry would be overwritten with
 * different bytes. Republishing under an unchanged version is the
 * exact failure mode that leaves running agents on stale tool code —
 * the resolver and sidecar caches key on `name@version`, not on
 * content, so a same-version overwrite never reaches an already
 * -launched or freshly-materialized run. Bumping the package's
 * `version` is the only supported way to ship new tool-package bytes.
 */
export class TarballVersionCollisionError extends Error {
  constructor(filename: string) {
    super(
      `publishCorbitsToolsRegistry: ${filename} is already published with different content; bump the package's version before republishing. Tool-package resolution keys on name@version, so overwriting an unchanged version never reaches a running or freshly-launched agent.`,
    );
    this.name = "TarballVersionCollisionError";
  }
}

/**
 * Thrown when a publish run leaves `corbits-tools` without the required
 * seed tarballs (`@corbits/memory-tools`). Covers both zero uploads onto
 * an empty/dangling registry (`GET tarballs` → `[]`) and a partial run
 * that uploaded other packages but still cannot resolve first-launch
 * pins. Callers must not treat this as success.
 */
export class EmptyRegistryPublishError extends Error {
  readonly success = false as const;
  constructor(detail: {
    uploaded: readonly string[];
    missing: readonly string[];
  }) {
    const uploadedBit =
      detail.uploaded.length === 0
        ? "uploaded none"
        : `uploaded ${detail.uploaded.join(", ")}`;
    super(
      `publishCorbitsToolsRegistry: the ${CORBITS_TOOLS_REGISTRY} registry is missing the expected tool-package tarballs (${uploadedBit}; still missing ${detail.missing.join(", ")})`,
    );
    this.name = "EmptyRegistryPublishError";
  }
}

/**
 * Guard against publishing a tarball whose filename (hence its
 * `name@version`) already exists in the registry with different
 * bytes. Same filename + same content is a harmless no-op re-publish
 * (a retried CI run, a rebuild that reproduced byte-identical output);
 * same filename + different content means the caller changed the
 * package's source without bumping its version, which would silently
 * strand every consumer of `name@version` on the old bytes. Exported
 * standalone so the check is unit-testable without invoking a real
 * `bun build` through `packToolPackageTarball`.
 */
/** A published name@version is immutable: once a tarball exists under a
 * filename, later publishes SKIP it (returning false) rather than
 * overwrite — same-source rebuilds are not byte-deterministic (tar
 * mtimes), so differing bytes cannot prove changed code. Shipping a
 * code change requires a version bump; the skip is logged loudly by the
 * caller so a forgotten bump is visible, never silent. */
export function shouldPublishTarball(
  _filename: string,
  existingIntegrity: string | undefined,
): boolean {
  return existingIntegrity === undefined;
}

async function listExistingTarballs(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  assetId: string,
): Promise<Map<string, string>> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/assets/${assetId}/tarballs`,
    undefined,
    cookies,
  );
  if (listed.status !== 200) {
    throw new Error(
      `publishCorbitsToolsRegistry: failed to list existing tarballs: ${String(listed.status)}`,
    );
  }
  const rows = parseSchema(
    TarballListResponse,
    listed.data,
    "list tarballs response",
  );
  return new Map(rows.map((row) => [row.filename, row.integrity]));
}

/**
 * Whether this tenant can already resolve the seeded `@corbits/*-tools`
 * tarballs — locally or inherited. Read-only: it never creates an
 * asset. An existing `corbits-tools` row with `GET tarballs` → `[]` is
 * not seeded (the dangling git-init-no-commit case).
 */
export async function isCorbitsToolsRegistrySeeded(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<boolean> {
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=true`,
    undefined,
    cookies,
  );
  if (listed.status !== 200) {
    throw new Error(
      `publishCorbitsToolsRegistry: failed to list assets: ${String(listed.status)}`,
    );
  }
  const rows = parseSchema(
    AssetWithOriginResponse.array(),
    listed.data,
    "list assets response",
  );
  const local = rows.find(
    (row) => row.name === CORBITS_TOOLS_REGISTRY && row.origin.direct,
  );
  const inherited = rows.find((row) => row.name === CORBITS_TOOLS_REGISTRY);
  const asset = local ?? inherited;
  if (asset === undefined) return false;

  const tarballs = await api(
    "GET",
    `/api/tenants/${tenantId}/assets/${asset.id}/tarballs`,
    undefined,
    cookies,
  );
  if (tarballs.status !== 200) return false;
  const tarballRows = parseSchema(
    TarballListResponse,
    tarballs.data,
    "list tarballs response",
  );
  return tarballsCoverRequiredSeedPackages(
    tarballRows.map((row) => row.filename),
  );
}

export type FetchTarballPut = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

async function putTarball(
  hubUrl: string,
  cookies: string[],
  tenantId: string,
  assetId: string,
  tarball: PackedTarball,
  fetchImpl: FetchTarballPut,
): Promise<PublishSummary> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
  };
  if (cookies.length > 0) headers["Cookie"] = cookies.join("; ");
  const response = await fetchImpl(
    `${hubUrl}/api/tenants/${tenantId}/assets/${assetId}/tarballs/${tarball.filename}`,
    {
      method: "PUT",
      headers,
      body: Uint8Array.from(tarball.bytes),
      redirect: "manual",
    },
  );
  if (response.status !== 200) {
    const text = await response.text();
    throw new Error(
      `publishCorbitsToolsRegistry: upload failed for ${tarball.filename}: ${String(response.status)} ${text}`,
    );
  }
  const parsed = parseSchema(
    TarballPutResponse,
    await response.json(),
    `PUT ${tarball.filename}`,
  );
  return { filename: tarball.filename, ...parsed };
}

export type PublishCorbitsToolsRegistryArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  tenantId: string;
  fetchImpl?: FetchTarballPut;
  log?: (line: string) => void;
  /** Test seam. Production omits this and runs `checkToolPackageFreshness`. */
  checkFreshness?: () => Promise<void>;
  /** Test seam. Production omits this and packs `CORBITS_TOOL_PACKAGE_DIRS`. */
  packageDirs?: readonly string[];
  /** Test seam. Production omits this and uses `packToolPackageTarball`. */
  pack?: (packageDir: string) => Promise<PackedTarball>;
};

function missingRequiredSeedPackages(filenames: readonly string[]): string[] {
  return REQUIRED_SEED_TOOL_PACKAGES.filter(
    (name) =>
      !filenames.some((filename) => tarballCoversPackage(filename, name)),
  );
}

export type PublishCorbitsToolsRegistryResult = {
  success: boolean;
  summaries: PublishSummary[];
};

/**
 * Ensures the tenant's `corbits-tools` package-registry asset exists
 * and carries every package in `CORBITS_TOOL_PACKAGE_DIRS`, packing
 * and pushing whatever is missing. Packs before creating the asset so
 * a failed pack cannot leave a dangling git-init-no-commit row.
 * Zero uploads onto a registry that still lacks the required tarballs
 * throw `EmptyRegistryPublishError` (`success === false`) instead of
 * reporting success.
 */
export async function publishCorbitsToolsRegistry(
  args: PublishCorbitsToolsRegistryArgs,
): Promise<PublishCorbitsToolsRegistryResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const log = args.log ?? ((): void => undefined);
  const checkFreshness = args.checkFreshness ?? checkToolPackageFreshness;
  const packageDirs = args.packageDirs ?? CORBITS_TOOL_PACKAGE_DIRS;
  const pack = args.pack ?? packToolPackageTarball;

  // Fail before packing if any `@corbits/*-tools` src/ moved without a
  // version bump. Publish skips an already-present filename, so a forgotten
  // bump would otherwise ship nothing and leave running agents on old tools.
  await checkFreshness();

  const existingId = await listRegistryAsset(
    args.api,
    args.cookies,
    args.tenantId,
  );
  const existingIntegrityByFilename =
    existingId !== undefined
      ? await listExistingTarballs(
          args.api,
          args.cookies,
          args.tenantId,
          existingId,
        )
      : new Map<string, string>();

  // Packs are independent; PUTs stay serial because they mutate one
  // package-registry git asset. Pack before ensure-create so a pack
  // failure cannot leave a dangling empty registry row.
  const packed = await materializePackages({
    packageDirs,
    materialize: pack,
  });

  const toUpload: PackedTarball[] = [];
  for (const item of packed) {
    if (item.status !== "ok") continue;
    const tarball = item.value;
    if (
      !shouldPublishTarball(
        tarball.filename,
        existingIntegrityByFilename.get(tarball.filename),
      )
    ) {
      args.log?.(
        `${tarball.filename} already published — versions are immutable; bump the version to ship changes (skipped)`,
      );
      continue;
    }
    toUpload.push(tarball);
  }

  const existingFilenames = [...existingIntegrityByFilename.keys()];
  if (toUpload.length === 0) {
    if (!tarballsCoverRequiredSeedPackages(existingFilenames)) {
      throw new EmptyRegistryPublishError({
        uploaded: [],
        missing: missingRequiredSeedPackages(existingFilenames),
      });
    }
    return { success: true, summaries: [] };
  }

  const assetId =
    existingId ??
    (await ensureRegistryAsset(args.api, args.cookies, args.tenantId));

  const summaries: PublishSummary[] = [];
  for (const tarball of toUpload) {
    const summary = await putTarball(
      args.hubUrl,
      args.cookies,
      args.tenantId,
      assetId,
      tarball,
      fetchImpl,
    );
    log(
      `published ${tarball.name}@${tarball.version} to ${CORBITS_TOOLS_REGISTRY} (commit=${summary.commit})`,
    );
    summaries.push(summary);
  }

  const publishedFilenames = [
    ...existingFilenames,
    ...summaries.map((summary) => summary.filename),
  ];
  if (!tarballsCoverRequiredSeedPackages(publishedFilenames)) {
    throw new EmptyRegistryPublishError({
      uploaded: summaries.map((summary) => summary.filename),
      missing: missingRequiredSeedPackages(publishedFilenames),
    });
  }
  return { success: true, summaries };
}
