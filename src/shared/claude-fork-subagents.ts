/**
 * Subagents on a continued Claude Code session (AGEN-120): the facts the host, the server and the web share.
 *
 * A fork with the option on lets Claude start foreground helpers with its `Agent` call. Everything a helper
 * does is asked about the way Claude's own calls are: its Bash, file changes and fetches reach the same cards
 * (marked as a helper's), and the `Agent` call itself gets a card, approvable only for a helper type that ships
 * inside Claude Code. A custom helper type (a user's agent file, with frontmatter hooks and a worktree option
 * that run with no card of their own) and a helper that starts a helper are decline-only.
 */

/** The host feature that says a supervisor can apply the subagents option. Advertised only for a measured Claude Code. */
export const CLAUDE_FORK_SUBAGENTS = "claude_fork_subagents";

/**
 * The helper types that ship inside Claude Code 2.1.319 and carry no frontmatter of their own. `claude`,
 * `Explore`, `Plan` and `statusline-setup` are also built in on that version; they are not offered, because
 * only `general-purpose` was measured doing the work a person approves (G5, G6).
 */
export const FORK_BUILTIN_AGENT_TYPES: readonly string[] = ["general-purpose"];

/** A helper type as a card may show it. A name outside this (a plugin's `plugin:agent`, a dotted name) is declined by the host. */
export const AGENT_TYPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest prompt a helper card carries; one past it is cut and the card can only be declined. */
export const AGENT_PROMPT_MAX_CHARS = 16 * 1024;

export function isBuiltInAgentType(subagentType: string): boolean {
	return FORK_BUILTIN_AGENT_TYPES.includes(subagentType);
}

// ---- words ----

/** The helper's turn, said once in the timeline. Fixed: nothing the prompt says reaches a row. */
export const AGENT_OPENED_WORDS = "asks to start a helper";
export const SUBAGENT_EYEBROW = "Asked by a subagent";

/** "Claude asks to start a helper (general-purpose)". The type is cleaned by the server and shown as text. */
export function agentRequestHeading(agentName: string, subagentType: string | null): string {
	const type = subagentType?.trim();
	return type
		? `${agentName} asks to start a helper (${type})`
		: `${agentName} asks to start a helper`;
}

/** The verb a subagent's own request uses, from what it asks to do. */
export function subagentArrival(kind: "command" | "file_change" | "claude_tool" | "agent"): string {
	switch (kind) {
		case "command":
			return "A subagent asks to run a command.";
		case "file_change":
			return "A subagent asks to change files.";
		case "agent":
			return "A subagent asks to start another helper.";
		default:
			return "A subagent asks to use a tool.";
	}
}

/** What the option's checkbox says, and the line under it. */
export const SUBAGENTS_OPTION_LABEL = "Allow subagents";
export const SUBAGENTS_OPTION_HELP =
	"Claude can hand parts of a turn to built-in helpers. Their file changes and commands wait for you the same way Claude's do, and they stop when the turn ends. They use more of your Claude usage.";

/** The part of the dialog's "Not in this session" list this option takes away. */
export const SUBAGENTS_FRAGMENT = "subagents";

/** Why the control is off for a machine. */
export function subagentsUnavailableReason(machine: string): string {
	return `${machine} needs a newer AgentPulse supervisor, or a Claude Code version AgentPulse has checked subagents with.`;
}

/** The status block's line. `reason` says why a requested option was not applied. */
export function subagentsStatusLine(on: boolean, reason?: string | null): string {
	return on ? "Subagents: on." : `Subagents: off.${reason ? ` ${reason}` : ""}`;
}

/** What a decline-only helper card says. */
export const CUSTOM_AGENT_COPY =
	"This helper isn't one that ships with Claude Code. Your own helper definitions can run commands of their own with no card, so AgentPulse doesn't start them.";
export const NESTED_AGENT_COPY =
	"A helper is asking to start another helper. AgentPulse allows one level of helpers.";
