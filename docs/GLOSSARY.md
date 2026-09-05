# Glossary

Workbench's user-facing vocabulary, and how each term maps to the
[Interchange](https://github.com/faremeter/interchange) platform concept
underneath. Product surfaces (UI, CLI output, docs) use the left column;
code and API paths keep the platform's own names — except **Workbench**
itself (CL-6260): that row's own package (`@corbits/chat`) is ours, not
Interchange's, so its code identifiers, wire fields, and route segments
were cut over to match the product word directly, with no separate
lower-level name left to list.

| Product term             | Platform term       | What it is                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bench**                | tenant              | A shared space where a team and its agents work — members, definitions, runs, and grants live here                                                                                                                                                                                                                                                                  |
| **User**                 | principal           | An identity that can act in a bench — human or agent                                                                                                                                                                                                                                                                                                                |
| **Agent**                | principal (agent)   | A named coworker principal, not a template; opening the row reopens that agent's one DM. The sidebar mixes that DM with channels in one recency list (pins first)                                                                                                                                                                                                   |
| **DM**                   | kind: chat          | The one 1:1 tenant with that agent — two opens never clone a second DM                                                                                                                                                                                                                                                                                              |
| **Channel**              | kind: workbench     | A shared room between people and agents (multi-principal tenant). `+` mints an empty one with nobody hosted; named templates mint the same empty channel, then instantiate their Workbench Definition and run its onboarding walkthrough in the room                                                                                                                |
| **Definition**           | workflow definition | A deployable unit of agent behavior, authored as code — not a template you mint into many conversations                                                                                                                                                                                                                                                             |
| **Workbench Definition** | —                   | The arktype description a named template instantiates: its default agents, routines, tools, required/optional plugins, and its ordered onboarding walkthrough — see `templates/index.ts`'s `WorkbenchDefinitionSchema`                                                                                                                                              |
| **Run**                  | workflow run        | A definition executing in a bench; interactive runs carry conversations                                                                                                                                                                                                                                                                                             |
| **Routine**              | —                   | Product name for a scheduled workflow: an authored definition whose frozen projection carries a native `ScheduleTrigger`. Cadence, pause/resume, and run-now live on `@corbits/workflows`; the hub poller ticks matching minutes. See [workflow-model.md](workflow-model.md)                                                                                        |
| **Approval**             | approval            | A human decision gating an external side effect                                                                                                                                                                                                                                                                                                                     |
| **Grant**                | grant               | Permission for a principal to act on a resource                                                                                                                                                                                                                                                                                                                     |
| **Hub**                  | hub                 | The API and coordination service a bench lives on                                                                                                                                                                                                                                                                                                                   |
| **Sidecar**              | sidecar             | The execution host that runs definitions on behalf of a hub                                                                                                                                                                                                                                                                                                         |
| **Extension**            | —                   | A route factory mounted on the hub to add product surface                                                                                                                                                                                                                                                                                                           |
| **Workbenches**          | —                   | The product name and the mint verb ("New workbench"), not a sidebar heading. Conversation tenants (agent DMs and channels) share one recency list, pins first — not two labeled sections                                                                                                                                                                            |
| **Workbench**            | —                   | The one conversation surface: an agent conversation (named by its agent) or a multi-party conversation (named by its own title) — durable hub-side data with no run of its own; also its own tenant, parented under the bench it was created in, so its membership and grants are its own — see [CHAT.md](CHAT.md) and [workbench-tenancy.md](workbench-tenancy.md) |
| **Timeline**             | —                   | A workbench's own message rows, read back in order, as the conversation record                                                                                                                                                                                                                                                                                      |
| **Participant**          | —                   | An address (human or agent) a workbench's settings list as able to post or be mentioned                                                                                                                                                                                                                                                                             |
| **Handle**               | —                   | A participant's short, unique-within-workbench mention name (e.g. `echo`), distinct from its address                                                                                                                                                                                                                                                                |
| **Mention**              | —                   | `@` plus a participant's handle in message text, triggering fan-out to that participant                                                                                                                                                                                                                                                                             |
| **Reply bridge**         | —                   | The bridge that turns an invited agent's `connector.reply` events into workbench timeline messages                                                                                                                                                                                                                                                                  |
| **Concept**              | —                   | A kind of work an agent asks for a model by — `cheap-loop`, `code-work`, `image-reader` — resolved against the bench into an ordered, priced chain of the models it can actually reach; agents never name a model, see [inference-concepts.md](inference-concepts.md)                                                                                               |

A bench and a workbench are both tenants underneath, which can read as
the same thing twice. They are not: a bench is the scope a team
provisions and works in (the switcher's rows); a workbench is a
conversation that happens to be minted as a tenant too (the platform's
"workbench"), so it can carry its own membership and grants independent of
the bench it lives in. Every workbench is a tenant, but a tenant a person
would call a "bench" is one nothing else is parented under as a
workbench — in practice, the one they signed into, not one that showed up
as a conversation in their sidebar.

A **Routine** is never a second name for a **Run**, or for Interchange's
own workflow concept — the three sit at different levels. A workflow
definition is the deployable code; a run is one execution of it; a routine
is the named, recurring (or manual) parent a person sets up over runs of a
definition, holding the trigger, delivery workbench, and run history a bare
run does not carry. "Workflow" on its own always means Interchange's
runtime concept — the definition or its runs — never a stand-in for
routine.

Naming conventions for this repository's packages:

- `@corbits/*` is the default scope for every package under `packages/`,
  whether it deploys as a portable artifact (e.g.
  `@corbits/<name>-agent`, `@corbits/<name>-workflow`), graduates into its
  own repository (e.g.
  [`@corbits/react-ui`](https://github.com/corbitsdev/react-ui)), or is
  plain local domain code — with a kebab-case kind suffix where the
  package is one of a family (`-agent`, `-tool`).
- `@workbench/*` is a legacy scope being migrated to `@corbits/*` package
  by package; a handful of packages still carry it (`access-policy`,
  `connections`, `onboarding`). New packages never use it.
