/**
 * What a takeover fork's tool requests may say, and the words the host answers them with (AGEN-117 T8,
 * T9, T10). Shared by the supervisor's parser and the tests that pin it to the recorded requests; the
 * server decides approvability from the text it builds itself and never reads this table for that.
 *
 * Every key of a request's `input` has a treatment; a key with none and a non-null value makes the request
 * decline-only `unknown_param`, so a Claude that starts sending something new is noticed instead of shown
 * as if it were understood. Tables are read through `Object.hasOwn` and never through a plain lookup, so a
 * key such as `__proto__` or `constructor` is "unknown", not inherited.
 */

/** The six tools a fork is started with (`--tools`); the tracker answers nothing else. */
export const CLAUDE_APPROVAL_TOOLS = [
	"Bash",
	"Read",
	"Write",
	"Edit",
	"NotebookEdit",
	"WebFetch",
] as const;
export type ClaudeApprovalTool = (typeof CLAUDE_APPROVAL_TOOLS)[number];

export type ClaudeInputTreatment =
	/** Part of what a person reviews. */
	| "shown"
	/** Never shown, never acted on: a bound on the call, not what it does. */
	| "ignored"
	/** Non-null and not `false` makes the request decline-only `unknown_param` (a background run, a sandbox escape). */
	| "decline_if_set";

export const CLAUDE_TOOL_INPUT_TREATMENTS: Readonly<
	Record<ClaudeApprovalTool, Readonly<Record<string, ClaudeInputTreatment>>>
> = {
	Bash: {
		command: "shown",
		description: "shown",
		timeout: "ignored",
		run_in_background: "decline_if_set",
		dangerouslyDisableSandbox: "decline_if_set",
	},
	Write: { file_path: "shown", content: "shown" },
	Edit: {
		file_path: "shown",
		old_string: "shown",
		new_string: "shown",
		replace_all: "shown",
	},
	NotebookEdit: {
		notebook_path: "shown",
		cell_id: "shown",
		new_source: "shown",
		cell_type: "shown",
		edit_mode: "shown",
	},
	WebFetch: { url: "shown", prompt: "shown" },
	Read: { file_path: "shown", offset: "ignored", limit: "ignored", pages: "ignored" },
};

/**
 * The top-level keys of a `can_use_tool` request body in the recorded 2.1.318 runs. `permission_suggestions`
 * is on the list so that it is *seen* and then never echoed: it would widen the rule set for the session.
 * `agent_id` and `mcp_server` are here because the runtime declines those before the tracker sees them.
 */
export const CLAUDE_REQUEST_META_KEYS: readonly string[] = [
	"subtype",
	"tool_name",
	"display_name",
	"input",
	"description",
	"permission_suggestions",
	"blocked_path",
	"tool_use_id",
	"decision_reason",
	"decision_reason_type",
	"decision_reason_rule_source",
	"matched_ask_rule",
	"server_policy_ask_only",
	"suppress_always_allow_rule",
	"requires_user_interaction",
	"agent_id",
	"mcp_server",
];

/**
 * What Claude tells the model when the host denies a request for a person. The `tool_result` carrying exactly
 * this text, with `non_execution_kind` set and a `user_reject` source, is the evidence that nothing ran (T10);
 * anything else after a deny is "something else decided".
 */
export const CLAUDE_PERSON_DECLINE_MESSAGE = "The person using AgentPulse declined this request.";
/** The same for a "decline and stop": the deny also asks Claude to interrupt the turn. */
export const CLAUDE_PERSON_STOP_MESSAGE =
	"The person using AgentPulse declined this request and stopped the turn.";
/** For a request the host declined on its own account (a deadline, the fence, an exclusion, a bad answer). */
export const CLAUDE_HOST_DECLINE_MESSAGE =
	"AgentPulse could not show this request to a person, so it was declined.";

/** `$CLAUDE_CONFIG_DIR/projects/<dir>/memory`, case-insensitively (APFS), as a regular expression source. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `realPath` (already resolved through links by the caller) is inside Claude's memory directory for
 * some project: `<configDir>/projects/<one segment>/memory` or anything below it. Case-insensitive, because
 * APFS is. `..` segments are resolved first, so `projects/x/../x/memory/a` is inside and `memory-x/a` is not.
 */
export function isAgentMemoryPath(realPath: string, configDir: string): boolean {
	const normalize = (value: string): string => {
		const parts: string[] = [];
		for (const segment of value.split("/")) {
			if (segment === "" || segment === ".") continue;
			if (segment === "..") parts.pop();
			else parts.push(segment);
		}
		return `/${parts.join("/")}`.toLowerCase();
	};
	const base = normalize(configDir);
	const path = normalize(realPath);
	return new RegExp(`^${escapeRegExp(base === "/" ? "" : base)}/projects/[^/]+/memory(/|$)`).test(
		path,
	);
}

/**
 * True when a Bash command's text names that directory. The text isn't parsed (a variable or a `cd` gets
 * past this, stated), so this is a text match on the path as written: the config directory spelled out, or
 * the default `.claude` home, followed by `projects/<segment>/memory`.
 */
export function commandNamesAgentMemory(command: string, configDir: string): boolean {
	const text = command.toLowerCase();
	const named = /projects\/[^/\s'"`]+\/memory(?![\w.-])/.test(text);
	if (!named) return false;
	return (
		text.includes(".claude") ||
		text.includes("claude_config_dir") ||
		(configDir !== "" && text.includes(configDir.toLowerCase()))
	);
}

const normalizeLower = (value: string): string => {
	const parts: string[] = [];
	for (const segment of value.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") parts.pop();
		else parts.push(segment);
	}
	return `/${parts.join("/")}`.toLowerCase();
};

/**
 * True when a real path is the host's own `~/.agentpulse` directory or anything below it: its exclude rules, the
 * MCP consent file, the fork record, the supervisor's configuration and credentials. A fork never changes these
 * (AGEN-119..123 review M4): a rewritten consent file would start a stranger's command at the next takeover.
 * `..` is resolved first and the match is case-insensitive, because APFS is.
 */
export function isAgentpulseHomePath(realPath: string, homeDir: string): boolean {
	if (homeDir === "") return false;
	const base = `${normalizeLower(homeDir)}/.agentpulse`.replace(/^\/\//, "/");
	const path = normalizeLower(realPath);
	return path === base || path.startsWith(`${base}/`);
}

/**
 * True when a Bash command's text names that directory as `~/.agentpulse`, `$HOME/.agentpulse`,
 * `${HOME}/.agentpulse` or the home path spelled out. The text isn't parsed (a variable of another name, a
 * `cd` and a glob get past this, stated).
 */
export function commandNamesAgentpulseHome(command: string, homeDir: string): boolean {
	const text = command.toLowerCase();
	const prefixes = ["~", "$home", "${home}"];
	if (homeDir !== "") prefixes.push(homeDir.toLowerCase().replace(/\/+$/, ""));
	return prefixes.some((prefix) => {
		const at = `${prefix}/.agentpulse`;
		for (let from = text.indexOf(at); from !== -1; from = text.indexOf(at, from + 1)) {
			const next = text[from + at.length];
			if (next === undefined || !/[\w.-]/.test(next)) return true;
		}
		return false;
	});
}
