// Composition root for the sidecar host. The host is deliberately
// generic: it reads its identity and hub location from the environment,
// dials in to the hub over a WebSocket, and runs whatever it is given
// through the deploy-router seam -- workflow deployments arrive as
// `agent.deploy` frames and are executed in supervised workflow-process
// children. It knows no deployment by name and holds no policy about
// what runs on it; the hub tells it everything over the wire. Because
// the sidecar dials the hub (never the reverse), hosted and local
// topologies are identical, and any number of sidecars can dial the
// same hub without this file changing.
//
// Boot order matters: orphaned tarball-cache staging is swept before
// any apply work is accepted, the process identity keypair loads before
// anything touches the data dir's substrate, the deploy router is
// captured during orchestrator construction, restored deployments are
// re-established BEFORE the hub connection opens (mailbox registrations
// must be live before the hub routes to them), the watchdog is armed
// for the first connect attempt, and only then does the link dial out.

import path from "node:path";
import {
  createEd25519Crypto,
  generateKeyPair,
  signEd25519,
  verifySSHSignature,
} from "@intx/crypto";
import { createSidecarOrchestrator, type HubLink } from "@intx/hub-agent";
import { createAgentRepoStore } from "@intx/hub-sessions";
import { loadAdapterRegistry } from "@intx/inference/providers";
import { getLogger, setup } from "@intx/log";
import { createInMemoryTransport } from "@intx/mail-memory";
import { createTarballCache } from "@intx/tool-packaging";
import { hexEncode } from "@intx/types";

import { reportError } from "@corbits/error-sink";
import { readSidecarConfig } from "./config";
import {
  DEFAULT_TOOL_REGISTRIES_JSON,
  parseToolRegistries,
} from "./tool-materialization";
import { createWorkflowProbeExecutor } from "./workflow-probe-handler";
import { createWorkflowClosureMaterializer } from "./workflow-closure-materialization";
import { MAX_INLINE_ASSET_PAYLOAD_BYTES } from "./source-asset-delivery";
import { createDefaultHarnessBuilder } from "./default-harness";
import { createHubLinkWatchdog } from "./hub-link-watchdog";
import { attachShutdownRejectionHandler, runSidecarShutdown } from "./shutdown";
import { loadOrMintSidecarKeypair } from "./signing-keypair";
import {
  createSidecarDeployRouter,
  type SidecarDeployRouter,
} from "./workflow-host-wiring";
import {
  createDeploymentAddressRegistry,
  createMultistepCredentialsRouter,
  createMultistepDrainRouter,
  createMultistepGrantsRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
  createMultistepSourcesRouter,
  createWorkflowRunPackClient,
  createWorkflowRunPackPushingRepoStore,
} from "./workflow-run-pack-client";
import { createWorkflowRunPackRestorer } from "./workflow-run-pack-restore";
import { createBootRestorePushHold } from "./boot-restore-push-hold";

await setup();

const config = readSidecarConfig(process.env);

// Host policy constants, not configuration: the tarball cache lives
// inside the data dir, and the two byte caps bound per-step tool
// materialization. They are data the host owns, so they are pinned here
// rather than surfaced as environment knobs.
const CACHE_ROOT = path.join(config.dataDir, "cache", "tarballs");
const CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024;
const REGISTRY_MAX_TARBALL_BYTES = 10 * 1024 * 1024;

// Built-in adapters merged with any operator-configured custom adapters
// named in `SIDECAR_ADAPTER_MANIFEST`. Installing a custom adapter still
// means installing its package into this workspace -- the manifest only
// names an already-installed module's specifier and export, it never
// carries code of its own.
const adapters = await loadAdapterRegistry(config.adapterManifest);

// Sweep any tmp staging directories left behind by a tarball put or
// extract that crashed between staging and the final rename on a
// previous boot, before the orchestrator starts accepting apply work.
await createTarballCache({
  rootDir: CACHE_ROOT,
  maxBytes: CACHE_MAX_BYTES,
}).sweepOrphans();

// Load or mint the host's persisted Ed25519 identity before anything
// else touches the data directory. One key, one identity for this
// process: the supervisor principal signs every workflow-run commit
// with it, the substrate's signing callback signs every SSH-signed
// commit with it, and each workflow-process child re-derives it from
// its spawn-time env. The public key is logged so an operator can pin
// which identity a given process advertises.
const signingKey = await loadOrMintSidecarKeypair(
  path.join(config.dataDir, ".sidecar-signing"),
);
getLogger(["sidecar", "boot"])
  .info`Sidecar identity ${hexEncode(signingKey.publicKey)}`;

// The substrate-backed RepoStore the supervisors read and write through.
// Wrapped below with the pack-pushing facade so a successful
// workflow-run write ships to the hub before its Promise resolves.
const agentRepoStore = createAgentRepoStore({
  dataDir: config.dataDir,
  signingKey,
});

// Per-deployment registries the hub link consults on inbound frames and
// the pack-push facade consults when addressing outbound frames.
const deploymentAddressRegistry = createDeploymentAddressRegistry();
const multistepMailRouter = createMultistepMailRouter();
const multistepSignalRouter = createMultistepSignalRouter();
const multistepDrainRouter = createMultistepDrainRouter();
const multistepGrantsRouter = createMultistepGrantsRouter();
const multistepSourcesRouter = createMultistepSourcesRouter();
const multistepCredentialsRouter = createMultistepCredentialsRouter();

const transport = createInMemoryTransport();

// The pack-push client closes over the substrate (for pack creation)
// and a lazy hub-link binding: `createSidecarOrchestrator` invokes
// `createDeployRouter` during construction, before the orchestrator
// handle exists, so the link reference is bound once construction
// returns and consulted lazily here.
let resolvedHubLink: HubLink | null = null;
const workflowRunPackClient = createWorkflowRunPackClient({
  substrate: agentRepoStore.repoStore,
  hubLink: {
    pushWorkflowRunPack(opts) {
      if (resolvedHubLink === null) {
        throw new Error(
          "sidecar boot: workflow-run pack push attempted before hub link was constructed",
        );
      }
      return resolvedHubLink.pushWorkflowRunPack(opts);
    },
  },
});

const restoreWorkflowRunPack = createWorkflowRunPackRestorer({
  // Restore into the unwrapped substrate. Running Hub-authored history
  // through the push facade would echo the same pack straight back to the
  // Hub and incorrectly present it as a new supervisor write.
  substrate: agentRepoStore.repoStore,
  markRestored: workflowRunPackClient.markRestored,
});

const wrappedRepoStore = createWorkflowRunPackPushingRepoStore({
  underlying: agentRepoStore.repoStore,
  packClient: workflowRunPackClient,
  registry: deploymentAddressRegistry,
});

const bootRestorePushHold = createBootRestorePushHold(wrappedRepoStore);

// Substrate-config keys threaded into every workflow-process child's
// fresh spawn env (nothing is inherited from this process). PATH lets
// the child's `bun` shebang resolve; HOME/TMPDIR give agent code a
// writable home and the host's temp root. The signing keys let the
// child's substrate factory re-derive the host identity.
const multistepSubstrateEnv: Record<string, string> = {
  SIDECAR_DATA_DIR: config.dataDir,
  SIDECAR_SIGNING_PUBLIC_KEY: hexEncode(signingKey.publicKey),
  SIDECAR_SIGNING_PRIVATE_KEY: hexEncode(signingKey.privateKey),
  HUB_WS_URL: config.hubURL,
  SIDECAR_ID: config.sidecarId,
  SIDECAR_TOKEN: config.token,
  PATH: config.path,
  SIDECAR_CACHE_MAX_BYTES: String(CACHE_MAX_BYTES),
  SIDECAR_REGISTRY_MAX_TARBALL_BYTES: String(REGISTRY_MAX_TARBALL_BYTES),
  // Threaded verbatim from this boot edge's own resolved manifest so a
  // workflow-process child resolves the exact custom adapters this
  // process resolved -- never a default of its own.
  SIDECAR_ADAPTER_MANIFEST: JSON.stringify(config.adapterManifest),
  // Always serialized, defaulting to the public npmjs registry when the
  // operator pinned none, so the child's per-step tool materialization
  // resolves the exact registries this boot edge resolved — a child
  // never falls back to a default of its own.
  SIDECAR_TOOL_REGISTRIES:
    config.toolRegistries ?? DEFAULT_TOOL_REGISTRIES_JSON,
};
if (config.home !== undefined) {
  multistepSubstrateEnv["HOME"] = config.home;
}
if (config.tmpdir !== undefined) {
  multistepSubstrateEnv["TMPDIR"] = config.tmpdir;
}

// The deploy router's source-admission gate reuses this exact
// `canBuildSource` predicate against the one adapter registry.
const buildHarness = createDefaultHarnessBuilder({ adapters });

// Airlocked workflow-probe executor, assembled here and injected through the
// orchestrator so the sidecar answers `workflow.probe.request` with a real
// inert projection and its wire hash instead of the hub-link's rejecting
// placeholder. The materializer lays a probe frame's frozen closure out under
// a per-probe scratch dir (rooted in the sidecar data dir so it shares that
// dir's lifecycle); the executor spawns the one-shot child that evaluates the
// workflow entry against it. A probe delivers its source assets inline in one
// frame, capped by the shared inline-payload bound.
const workflowProbeExecutor = createWorkflowProbeExecutor({
  materialize: createWorkflowClosureMaterializer({
    cacheRoot: CACHE_ROOT,
    cacheMaxBytes: CACHE_MAX_BYTES,
    registryMaxTarballBytes: REGISTRY_MAX_TARBALL_BYTES,
    maxAssetPayloadBytes: MAX_INLINE_ASSET_PAYLOAD_BYTES,
    registries: parseToolRegistries(
      config.toolRegistries ?? DEFAULT_TOOL_REGISTRIES_JSON,
    ),
    scratchRoot: path.join(config.dataDir, "workflow-probe", "closures"),
  }),
});

const watchdogLog = getLogger(["sidecar", "hub-link-watchdog"]);
const watchdog = createHubLinkWatchdog({
  stallDeadlineMs: 60_000,
  onStall: () => {
    watchdogLog.error`Hub link stalled: connect attempt got neither open nor close within the deadline; exiting for a clean restart`;
    process.exit(1);
  },
});

// Captured by the createDeployRouter callback, which the orchestrator
// invokes synchronously during construction; asserted below so a wiring
// regression fails loud at boot instead of silently skipping restore.
let capturedRouter: SidecarDeployRouter | undefined;

const orchestrator = createSidecarOrchestrator({
  hubURL: config.hubURL,
  sidecarId: config.sidecarId,
  token: config.token,
  dataDir: config.dataDir,
  transport,
  cryptoOps: {
    generateKeyPair,
    signEd25519,
    verifySSHSig: verifySSHSignature,
  },
  scheduleReconnect: watchdog.scheduleReconnect,
  mailInboundRouter: multistepMailRouter,
  signalInboundRouter: multistepSignalRouter,
  drainInboundRouter: multistepDrainRouter,
  grantsInboundRouter: multistepGrantsRouter,
  sourcesInboundRouter: multistepSourcesRouter,
  credentialsInboundRouter: multistepCredentialsRouter,
  // Install Hub-authoritative workflow-run history before a replacement
  // supervisor spawns, against the unwrapped substrate so the restore is
  // never echoed back to the Hub as a new sidecar-authored update.
  applyWorkflowRunPack: restoreWorkflowRunPack,
  workflowProbeExecutor,
  // Called from every connection's open handler -- the watchdog's
  // aliveness signal -- and from the close path, which immediately
  // re-schedules a reconnect that re-arms the deadline.
  getWorkflowAddresses: () => {
    watchdog.markAlive();
    if (capturedRouter === undefined) {
      throw new Error(
        "sidecar boot: deploy router was not constructed before the hub link requested deployment addresses",
      );
    }
    return capturedRouter.activeAddresses();
  },
  // After the link re-answers a reconnect challenge for a deployment
  // address, re-drive any workflow-run pack the disconnect cancelled.
  onWorkflowAddressesRoutable: (addresses) => {
    for (const address of addresses) {
      wrappedRepoStore.notifyAddressRoutable(address);
    }
  },
  // On disconnect, block the addresses' workflow-run pushes until the
  // reconnect challenge re-routes them; a push shipped on the fresh,
  // not-yet-challenged connection would be dropped by the hub.
  onWorkflowAddressesUnroutable: (addresses) => {
    for (const address of addresses) {
      wrappedRepoStore.markAddressUnroutable(address);
    }
  },
  createDeployRouter: ({
    sessions,
    keyStore,
    publishWorkflowInferenceEvent,
  }) => {
    const deployRouterConfigBase: Parameters<
      typeof createSidecarDeployRouter
    >[0] = {
      sessions,
      keyStore,
      transport,
      repoStore: wrappedRepoStore,
      signingKeySeed: signingKey.privateKey,
      createAgentCrypto: createEd25519Crypto,
      assertSourceBuildable: buildHarness.canBuildSource,
      registerDeployment: ({ deploymentId, agentAddress }) => {
        deploymentAddressRegistry.record(deploymentId, agentAddress);
        bootRestorePushHold.onDeploymentRegistered(agentAddress);
      },
      unregisterDeployment: ({ deploymentId, agentAddress }) => {
        deploymentAddressRegistry.unregister(deploymentId);
        wrappedRepoStore.reclaimPushState({ deploymentId, agentAddress });
      },
      // Lazy-bound the same way as `workflowRunPackClient.hubLink` above:
      // `createDeployRouter` runs synchronously during `createSidecarOrchestrator`
      // construction, before `orchestrator.hubLink` exists, so `resolvedHubLink`
      // is consulted at call time rather than captured now. Without this, a
      // workflow-child's ask-rail suspension never reaches the hub as a
      // `signal.correlation.register` frame and its approval is never
      // registered.
      registerSuspension: (registration) => {
        if (resolvedHubLink === null) {
          throw new Error(
            "sidecar boot: suspension register attempted before hub link was constructed",
          );
        }
        resolvedHubLink.sendSignalCorrelationRegister(registration);
      },
      multistepMailRouter,
      multistepSignalRouter,
      multistepDrainRouter,
      multistepGrantsRouter,
      multistepSourcesRouter,
      multistepCredentialsRouter,
      multistepSubstrateEnv,
      publishWorkflowInferenceEvent,
    };
    const deployRouterConfigWithConsumedRetentionMs =
      config.consumedRetentionMs !== undefined
        ? {
            ...deployRouterConfigBase,
            consumedRetentionMs: config.consumedRetentionMs,
          }
        : deployRouterConfigBase;
    const deployRouterConfigWithReadyTimeoutMs =
      config.readyTimeoutMs !== undefined
        ? {
            ...deployRouterConfigWithConsumedRetentionMs,
            readyTimeoutMs: config.readyTimeoutMs,
          }
        : deployRouterConfigWithConsumedRetentionMs;
    const router = createSidecarDeployRouter(
      deployRouterConfigWithReadyTimeoutMs,
    );
    capturedRouter = router;
    return router;
  },
});

resolvedHubLink = orchestrator.hubLink;

if (capturedRouter === undefined) {
  throw new Error(
    "sidecar boot: deploy router was not constructed before deployment restore",
  );
}
const deployRouter: SidecarDeployRouter = capturedRouter;

// Re-establish the deployments a prior process persisted BEFORE the
// connection opens: each deployment's mailbox/transport registration
// must be live before the hub can route to it, and the first register
// frame must announce every restored address.
bootRestorePushHold.begin();
try {
  await deployRouter.restoreWorkflowDeployments();
} finally {
  bootRestorePushHold.end();
}

// Independent of the deployment restore above: reclaims any
// hibernated-agent-identity snapshot (see
// `hibernated-agent-identity-vault.ts`) whose address hibernated and was
// never redeployed within the retention window, so a permanently
// abandoned hibernate does not leak disk forever.
await deployRouter.reapExpiredHibernationSnapshots();

// The first connect bypasses the reconnect scheduler, so arm the stall
// deadline by hand; the open path's getWorkflowAddresses disarms it.
watchdog.armForBoot();
orchestrator.start();

const SHUTDOWN_DRAIN_MS = 8_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const log = getLogger(["sidecar", "shutdown"]);
  await runSidecarShutdown({
    signal,
    close: () => {
      orchestrator.close();
    },
    drain: () => deployRouter.shutdownAll(),
    drainTimeoutMs: SHUTDOWN_DRAIN_MS,
    exit: (code) => {
      process.exit(code);
    },
    log,
  });
}

function onShutdownRejection(error: unknown): void {
  reportError(error, { operation: "sidecar.shutdown.signal" });
  process.exit(1);
}

process.on("SIGTERM", () => {
  attachShutdownRejectionHandler(shutdown("SIGTERM"), onShutdownRejection);
});
process.on("SIGINT", () => {
  attachShutdownRejectionHandler(shutdown("SIGINT"), onShutdownRejection);
});
