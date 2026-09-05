# @corbits/process-provisioner

The **default** `SidecarProvisioner` backend: each exclusive sidecar
allocation runs as one `apps/sidecar` child process on the hub's own host.

A hub with no `SIDECAR_PROVISIONERS` set registers this backend as its sole
provisioner, so a single-server install provisions exclusive sidecars —
many chats and workflows on one VPS — with no operator configuration, no
container runtime, and no remote sandbox account.

## What one allocation looks like

Under the hub's data directory:

```
$HUB_DATA_DIR/process-provisioner/state.json                        # generation fences, destroy tombstones
$HUB_DATA_DIR/process-provisioner/allocations/<id>/gen-<n>/sidecar.pid
$HUB_DATA_DIR/process-provisioner/allocations/<id>/gen-<n>/data/    # that sidecar's SIDECAR_DATA_DIR
```

`ensure` creates the generation's directory, spawns
`<runtime> <sidecar entry>`, and records the pid; `destroy` sends SIGTERM
(escalating to SIGKILL after a grace period) and removes the directory.

Each spawned process gets only what `apps/sidecar/src/config.ts` requires:
`HUB_WS_URL` (the allocation's hub WebSocket URL), `SIDECAR_TOKEN` (the
provisioner-issued bearer token for that allocation), `SIDECAR_ID`,
`SIDECAR_DATA_DIR`, and the host's `PATH`/`HOME`/`TMPDIR`. Nothing else of
the hub's environment is inherited — a sidecar learns everything else over
the wire.

Idempotence, generation fencing, destroy tombstones, and obsolete-unit
sweeping are not implemented here: they come from
`@corbits/sandbox-sidecar`'s shared core, the same core the `docker` and
`e2b` backends use. This package supplies only the OS-level unit. Scoping a
unit by generation is what keeps the sweep honest — a new generation's pid
never overwrites the record of the unit it replaces, so a superseded
process is still found and stopped.

The binding fingerprint is `process:v1:<sidecar entry>:<hub ws url>`: the
two facts that decide what a provisioned sidecar actually is.

## Operator environment variables

Both are optional overrides; an unconfigured install needs neither.

- `PROCESS_PROVISIONER_SIDECAR_ENTRY` — the sidecar entry point to spawn.
  Unset resolves this repository's own `apps/sidecar/src/index.ts`.
- `PROCESS_PROVISIONER_RUNTIME` — the executable that runs it. Unset
  reuses the `bun` binary running the hub.

The hub's own state directory for this backend is derived from
`HUB_DATA_DIR`, never configured separately, so it cannot drift from the
other backends' state.

## Trade-offs

Sidecars share the hub's kernel, filesystem, and user account: this
backend gives process isolation, not the sandbox isolation `docker` or
`e2b` give. Choose it for a single-server deployment or local development;
choose `docker`/`e2b` when a sidecar runs untrusted code or needs its own
filesystem and network namespace.

Process recovery is by pid, so pid reuse after a host reboot is
theoretically ambiguous. In practice the pid file lives inside the
allocation's own directory and is removed with it, and the hub's
reconciler re-ensures live allocations on boot.
