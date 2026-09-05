// Person-facing display names for a workbench's agent participants
// (CL-6424) — resolved once per workbench off
// `GET /workbenches/:id/agents`' `displayName`, keyed by participant
// address. Every surface that names an agent (timeline headers, mention
// picker, typing pulse, presence stack, empty states, join lines) reads
// through here so a reader sees the definition's display name — never a
// raw handle slug. A missing entry falls back to the caller's own
// slug-derived label: the agents query can still be in flight (or an
// agent's definition gone) while the timeline already renders.

/** Agent display names by participant address. */
export type AgentDisplayNames = ReadonlyMap<string, string>;

/**
 * Builds the lookup from a `listWorkbenchAgents` snapshot — one entry per
 * agent, keyed by the same address every participant record carries.
 */
export function agentDisplayNamesFromAgents(
  agents: readonly { readonly address: string; readonly displayName: string }[],
): AgentDisplayNames {
  return new Map(
    agents.map((agent) => [agent.address, agent.displayName] as const),
  );
}

/**
 * The display name for an agent address when one is known — `undefined`
 * when the snapshot hasn't loaded or names no such agent, so the caller
 * falls back to its own slug-derived label rather than rendering a blank.
 */
export function displayNameForAddress(
  address: string,
  displayNames: AgentDisplayNames | undefined,
): string | undefined {
  return displayNames?.get(address);
}
