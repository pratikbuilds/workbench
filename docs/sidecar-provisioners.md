# Sidecar provisioners

A **sidecar** is the execution host a workbench's agents and workflow runs
actually run on. A **provisioner** is the backend that creates and destroys
one: Interchange's `SidecarProvisioner` contract, `ensure`/`destroy`, keyed
by allocation and generation.

This is the one page for deciding where an install's sidecars run.

## The shipped backends

| id        | Where a sidecar runs                    | Isolation                                        | Requires                                                | Package                        |
| --------- | --------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- | ------------------------------ |
| `process` | A child process of the hub, same host   | Process only — shared kernel, filesystem, user   | nothing                                                 | `packages/process-provisioner` |
| `docker`  | A container on the hub's host           | Container — own filesystem and network namespace | `DOCKER_PROVISIONER_IMAGE`, a local `docker` CLI        | `packages/docker-provisioner`  |
| `e2b`     | A remote [E2B](https://e2b.dev) sandbox | VM — separate machine                            | `E2B_API_KEY`, `E2B_TEMPLATE`, a publicly reachable hub | `packages/e2b-sandbox-sidecar` |

`process` is the **default**: a hub with `SIDECAR_PROVISIONERS` unset
registers it as the sole backend, so one server runs many chats and
workflows with no operator configuration at all. Pick `docker` or `e2b`
when a sidecar runs untrusted code or needs its own filesystem and network.

## Configuring it

Two variables decide everything:

```sh
# Register a set of backends. Unset means exactly `process`.
SIDECAR_PROVISIONERS=process,docker
# Which of them exclusive placements provision on. Optional when the list
# has one id; required when it has more.
SIDECAR_DEFAULT_PROVISIONER=docker
```

Setting `SIDECAR_PROVISIONERS` **replaces** the default rather than adding
to it — list `process` explicitly to keep it alongside another backend. An
unknown id, a duplicate id, a missing backend setting, or a
`SIDECAR_DEFAULT_PROVISIONER` naming an unlisted id all fail the boot with
a message naming the variable; nothing silently degrades to a different
backend than the one asked for.

Per-backend settings, and the `HUB_SIDECAR_WEBSOCKET_URL` override a
container or remote sandbox needs to dial back, are documented against each
variable in [`.env.example`](../.env.example) and in
`apps/hub/src/config.ts`'s env schema.

### Where a sidecar's state lives

Every backend keeps its hub-side allocation state — generation fences,
destroy tombstones, external refs — under the hub's own `HUB_DATA_DIR`,
derived and never separately configurable, so no two backends can drift or
collide:

```
$HUB_DATA_DIR/process-provisioner/
$HUB_DATA_DIR/docker-provisioner/
$HUB_DATA_DIR/e2b-provisioner/
```

The `process` backend additionally keeps each allocation's own
`SIDECAR_DATA_DIR` there, one directory per generation, removed when the
allocation is destroyed — see
[`packages/process-provisioner/README.md`](../packages/process-provisioner/README.md).

## Adding a backend

Three steps, no hub surgery:

1. **Implement the backend.** Copy `packages/process-provisioner`: a
   `SidecarBackend` (`startUnit` / `stopUnit` / `findUnitsByAllocation`)
   plus identity (`id`, `apiVersion`, `bindingFingerprint`). Idempotence,
   generation fencing, destroy tombstones, and obsolete-unit sweeping come
   from `@corbits/sandbox-sidecar`'s shared core — never reimplement them
   per backend.
2. **Name it.** Add its id to `SIDECAR_PROVISIONER_IDS` and a member to
   `SidecarProvisionerConfig` in `apps/hub/src/config.ts`, with its own
   required settings parsed there (the hub's one env boundary).
3. **Wire it.** Add a case to `buildSidecarProvisioner` in
   `apps/hub/src/index.ts`.

The registry itself is composed at the hub's composition root and takes
whatever the config named, so a new backend is a package plus two switch
cases — an operator then reaches it by id, exactly like the shipped three.

## Related

- [`packages/process-provisioner/README.md`](../packages/process-provisioner/README.md)
  — the default backend's layout, environment, and trade-offs.
- [`packages/e2b-sandbox-sidecar/README.md`](../packages/e2b-sandbox-sidecar/README.md)
  — building the E2B template.
- [`docs/sidecar-placement-adoption.md`](sidecar-placement-adoption.md) —
  the design analysis behind hub-authoritative placement.
