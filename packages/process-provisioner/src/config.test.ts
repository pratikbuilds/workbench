import { describe, expect, test } from "bun:test";

import { readProcessProvisionerConfig } from "./config";

const HUB_WS_URL = "ws://127.0.0.1:3000/api/sidecars/ws";

describe("readProcessProvisionerConfig", () => {
  test("an unconfigured environment resolves this repository's sidecar entry and the running bun", () => {
    const config = readProcessProvisionerConfig({
      env: {},
      dataDir: "/srv/hub-data/process-provisioner",
      hubWebSocketUrl: HUB_WS_URL,
    });

    expect(config.sidecarEntryPath).toEndWith("/apps/sidecar/src/index.ts");
    expect(config.runtimePath).toBe(process.execPath);
    expect(config.allocationsDir).toBe(
      "/srv/hub-data/process-provisioner/allocations",
    );
    expect(config.stateFilePath).toBe(
      "/srv/hub-data/process-provisioner/state.json",
    );
    expect(config.hubWebSocketUrl).toBe(HUB_WS_URL);
  });

  test("an operator can point the backend at another entry point and runtime", () => {
    const config = readProcessProvisionerConfig({
      env: {
        PROCESS_PROVISIONER_SIDECAR_ENTRY: "/opt/sidecar/index.js",
        PROCESS_PROVISIONER_RUNTIME: "/usr/bin/node",
      },
      dataDir: "/srv/hub-data/process-provisioner",
      hubWebSocketUrl: HUB_WS_URL,
    });

    expect(config.sidecarEntryPath).toBe("/opt/sidecar/index.js");
    expect(config.runtimePath).toBe("/usr/bin/node");
  });

  test("a relative data dir fails loudly instead of resolving against the cwd", () => {
    expect(() =>
      readProcessProvisionerConfig({
        env: {},
        dataDir: ".data/hub/process-provisioner",
        hubWebSocketUrl: HUB_WS_URL,
      }),
    ).toThrow("must be an absolute path");
  });

  test("an empty override is a misconfiguration, not an unset key", () => {
    expect(() =>
      readProcessProvisionerConfig({
        env: { PROCESS_PROVISIONER_RUNTIME: "" },
        dataDir: "/srv/hub-data/process-provisioner",
        hubWebSocketUrl: HUB_WS_URL,
      }),
    ).toThrow("invalid process provisioner environment");
  });
});
