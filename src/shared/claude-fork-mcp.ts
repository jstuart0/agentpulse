/**
 * The rules a fork's MCP tools are named and bounded by (AGEN-121), shared by the host that reads the person's
 * fork MCP file and parses a tool request, and the server that validates the report and builds the card. One
 * home, so the host's split and the server's split cannot disagree (xander M3).
 *
 * A server name has no underscore, so `mcp__<server>__<tool>` splits one way only: the server is everything up
 * to the first `__`. The raw tool name is also shown verbatim on the card, so a person is never relying on the
 * split alone.
 */

/** The supervisor feature: this host can start the MCP servers listed in the person's fork MCP file in a fork. */
export const CLAUDE_FORK_MCP = "claude_fork_mcp";

/** Where the person writes the servers a fork may start, relative to the account's home on the host. */
export const FORK_MCP_FILE_RELATIVE = ".agentpulse/claude-fork-mcp.json";

/** The longest Claude Code allows a tool name to be. */
export const FORK_MCP_TOOL_NAME_MAX = 64;
/** The most servers a fork file may list. */
export const FORK_MCP_MAX_SERVERS = 16;
/** The longest a server name may be. */
export const FORK_MCP_SERVER_NAME_MAX = 32;
/** The largest the fork file may be. */
export const FORK_MCP_FILE_MAX_BYTES = 64 * 1024;
/** The longest a tool call's input may be, as the JSON text a person is shown. */
export const FORK_MCP_INPUT_MAX_CHARS = 16 * 1024;

/** A server name: no underscore, so the wire name splits one way only. */
export const FORK_MCP_SERVER_NAME = /^[A-Za-z0-9-]{1,32}$/;
/** The wire name of an MCP tool, with its two parts captured. */
export const FORK_MCP_RAW_TOOL_NAME = /^mcp__([A-Za-z0-9-]{1,32})__([A-Za-z0-9_-]{1,64})$/;

export interface ForkMcpSplit {
	server: string;
	tool: string;
	rawToolName: string;
}

/**
 * Splits a wire tool name into its server and tool. Null when it is not a well-formed MCP tool name, is longer
 * than Claude Code allows, or (when `servers` is given) names a server that was not applied.
 */
export function splitForkMcpToolName(
	rawToolName: string,
	servers?: readonly string[],
): ForkMcpSplit | null {
	if (rawToolName.length > FORK_MCP_TOOL_NAME_MAX) return null;
	const match = FORK_MCP_RAW_TOOL_NAME.exec(rawToolName);
	if (!match) return null;
	const [, server, tool] = match as unknown as [string, string, string];
	if (servers && !servers.includes(server)) return null;
	return { server, tool, rawToolName };
}

/** Whether `value` is a plain JSON object (not null, an array or a primitive). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON text of a tool call's input as a person is shown it, and as the report carries it. */
export function forkMcpInputText(input: Record<string, unknown>): string {
	return JSON.stringify(input, null, 2);
}

// ---- the words ----

export const FORK_MCP_CONTROL_LABEL = "Include my fork MCP servers";

export function forkMcpControlHelp(machine: string | null): string {
	const where = machine?.trim() ? machine.trim() : "the chosen machine";
	return `Starts the MCP servers listed in ~/.agentpulse/claude-fork-mcp.json on ${where}, with whatever access they have; they also see Claude's own login. Each tool call waits for you unless your own Claude settings allow it, a server can act on its own once running, and AgentPulse can't tell what a tool does.`;
}

export function forkMcpHostCannot(host: string): string {
	return `${host}'s supervisor can't do this yet. Update it to use this.`;
}

/** The sentence the dialog's description gains when the option is on. */
export const FORK_MCP_FRAGMENT =
	"Your fork MCP servers start in this session. Their tool calls wait for you; what each tool does, AgentPulse can't tell.";

/** The status line of a session with servers applied. */
export function forkMcpAppliedLine(names: readonly string[]): string {
	return `Fork MCP servers: ${names.join(", ")}.`;
}

/** The status line of a session that asked for servers and got none; the reason is one of the fixed ones. */
export function forkMcpOffLine(reason: string): string {
	return `Fork MCP servers: off. ${reason}`;
}

/** The reasons an asked-for option isn't applied, said to the person. */
export const FORK_MCP_OFF_REASONS = {
	no_file: "There is no valid ~/.agentpulse/claude-fork-mcp.json on that machine.",
	unmeasured_version:
		"This version of Claude Code hasn't been tested with it. Change the Claude Code version there, or update AgentPulse.",
	old_supervisor: "That machine's supervisor can't do this yet. Update it to use this.",
} as const;
export type ForkMcpOffReason = keyof typeof FORK_MCP_OFF_REASONS;

/** The card's own words for an MCP tool call (F48). */
export const FORK_MCP_ARRIVAL = "asks to use an MCP tool";
export const FORK_MCP_OPENED_WORDS = "Claude asks to use an MCP tool";
export const FORK_MCP_CONFIRM = {
	title: "Let Claude use this MCP tool?",
	confirmLabel: "Allow this call",
	cancelLabel: "Back",
	lead: "Runs once. AgentPulse can't undo it.",
} as const;

export function forkMcpHeading(tool: string, server: string): string {
	return `Claude asks to use "${tool}" from ${server}`;
}

export function forkMcpCardLine(server: string, tool: string): string {
	return `${server} calls this tool "${tool}". AgentPulse can't tell what it does or what it will change. Approve only if you know this server and this tool.`;
}
