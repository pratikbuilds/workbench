// The pinned-skills prompt index. A definition that pins skills gets an
// `<available_skills>` stanza appended to its system prompt at push
// time — name and description only, plus the instruction to call
// `skills_load` for the body.
//
// Index-only is the whole point: a skill body is arbitrarily long and
// most turns need none of it, so inlining every pinned body would burn
// the context window on instructions the model may never use. The model
// reads the index, decides, and pays for exactly the bodies it asks for.
export const AVAILABLE_SKILLS_OPEN_TAG = "<available_skills>";
export const AVAILABLE_SKILLS_CLOSE_TAG = "</available_skills>";

export const SKILLS_LOAD_TOOL = "skills_load";

export type PinnedSkillIndexEntry = {
  readonly name: string;
  readonly description: string;
};

/**
 * Renders the stanza. Returns the empty string when nothing is pinned,
 * so a definition with no skills carries no stanza at all rather than an
 * empty one the model has to reason about.
 */
export function buildAvailableSkillsStanza(
  entries: readonly PinnedSkillIndexEntry[],
): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `- ${entry.name}: ${entry.description}`);
  return [
    AVAILABLE_SKILLS_OPEN_TAG,
    "These skills are available to you. Only their names and descriptions",
    `are listed here. To read a skill's full instructions, call the`,
    `\`${SKILLS_LOAD_TOOL}\` tool with that skill's name — never assume its`,
    "contents from the description alone.",
    "",
    ...lines,
    AVAILABLE_SKILLS_CLOSE_TAG,
  ].join("\n");
}

const STANZA_PATTERN = new RegExp(
  `\\n*${AVAILABLE_SKILLS_OPEN_TAG}[\\s\\S]*?${AVAILABLE_SKILLS_CLOSE_TAG}`,
  "g",
);

/** Removes any previously injected stanza, leaving the author's own prompt. */
export function stripAvailableSkillsStanza(systemPrompt: string): string {
  return systemPrompt.replace(STANZA_PATTERN, "").trimEnd();
}

/**
 * Replaces the definition's stanza with one describing `entries`. Always
 * strips first so re-pinning is idempotent — a definition pushed three
 * times carries exactly one stanza, always the current one.
 */
export function withAvailableSkills(
  systemPrompt: string,
  entries: readonly PinnedSkillIndexEntry[],
): string {
  const base = stripAvailableSkillsStanza(systemPrompt);
  const stanza = buildAvailableSkillsStanza(entries);
  if (stanza === "") return base;
  return `${base}\n\n${stanza}`;
}
