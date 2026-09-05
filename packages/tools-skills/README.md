# @corbits/tools-skills

`skills_list`, `skills_search`, and `skills_load` as an `@intx/agent` tool
bundle — the agent-facing half of the workbench's skill registry
(`@corbits/skills`).

A definition's pinned skills already appear in its system prompt's
`<available_skills>` index, with names and descriptions only.
`skills_load` is how a model turns one of those names into the actual
instructions, so the index stays cheap and only the skills a turn truly
needs are paid for in context.

## Env

`requires: ["hubSkillsUrl", "sidecarToken", "address"]` — the hub's HTTP
origin, the sidecar's own bearer token, and the run's own address, all
already on a workflow child's step env. No per-user credential, no
database handle, and no tenant or principal in any tool's input schema:
attribution comes entirely from the authenticated run on the hub side.

## Fail-closed

Every failure — transport, HTTP, auth, or response shape — comes back as
a `ToolResult` with `isError: true` naming the failure. None of the three
tools degrades to an empty list or an invented body. An agent told "no
skills" behaves very differently from one told "the registry is
unreachable," and only the second is honest.

## Running tests

```sh
cd packages/tools-skills && bun test
```

Tests run against a mocked `FetchLike`; no `DATABASE_URL` or live hub is
required.
