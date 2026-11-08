import { CLAUDE_APPROVAL_TOOLS, type ClaudeInputTreatment } from "../../shared/claude-approvals.js";
import { FORK_AGENT_TOOL } from "../../shared/claude-fork-copy.js";
/**
 * The subagent half of a fork's tool policy (AGEN-120).
 *
 * With the option applied on a Claude Code version it was measured on (2.1.319, both logins):
 *  - `Agent` joins `--tools` and leaves `--disallowedTools` (with `Task`, the name 2.1.319 reports it under in
 *    `init.tools`), and the inline `permissions.ask` gains `Agent`. Without that rule the call raises no
 *    request at all (G5), so the rule is what gives the starting call a card.
 *  - Helpers are foreground only: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` stays in the inline settings and
 *    the child environment (S2), so a helper cannot outlive the turn's `result`.
 *  - A line carrying `agent_id` or `parent_tool_use_id` inside a host turn is a helper's (`"subagent"`): its
 *    tool calls are recorded and its text is never reported as Claude's. After the turn's `result` the stream
 *    itself raises `subagent_after_turn`.
 *  - A request carrying `agent_id` is a helper's own tool call and reaches a card, marked `fromSubagent`.
 *
 * The cards: an `Agent` request is approvable only for a helper type that ships inside Claude Code; a custom
 * type (its frontmatter hooks run with no card, and `isolation: worktree` moves it, G7) and a nested spawn
 * (`agent_id` on an `Agent` request, G6) are reported decline-only.
 */
import { AGENT_TYPE_PATTERN, isBuiltInAgentType } from "../../shared/claude-fork-subagents.js";
import type { AppliedForkOptions, ForkOptionsRequest } from "../../shared/session-resume.js";
import {
	type ForkOptionsContext,
	type ForkPolicyPart,
	type LineClass,
	type PreparedPart,
	isAppliedMcpTool,
} from "./claude-fork-tools.js";

/** The Agent call's name on the request and in `--tools`; 2.1.319 reports it as `Task` in `init.tools`. */
export const AGENT_TOOL = FORK_AGENT_TOOL;
const AGENT_TOOL_INIT_ALIAS = "Task";

/** What the Agent call's input may hold. Anything else (a background run, a model, an isolation) is `unknown_param`. */
export const AGENT_INPUT_TREATMENTS: Readonly<Record<string, ClaudeInputTreatment>> = {
	description: "shown",
	prompt: "shown",
	subagent_type: "shown",
	run_in_background: "decline_if_set",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const AGENT_ID_MAX = 128;

/** A helper's id as Claude puts it on a line or request: a non-empty string of a bounded size. */
function helperId(value: unknown): string | null {
	return typeof value === "string" && value !== "" && value.length <= AGENT_ID_MAX ? value : null;
}

/** The fork's six tools, plus any `mcp__` tool of an applied server (judged by the MCP half). */
function expectedWithAgent(applied: AppliedForkOptions): (name: string) => boolean {
	const allowed = new Set<string>([...CLAUDE_APPROVAL_TOOLS, AGENT_TOOL]);
	return (name) => allowed.has(name) || isAppliedMcpTool(name, applied);
}

function subagentPart(applied: AppliedForkOptions): ForkPolicyPart {
	const expected = expectedWithAgent(applied);
	return {
		extraTools: [AGENT_TOOL],
		allowTools: [AGENT_TOOL, AGENT_TOOL_INIT_ALIAS],
		askRules: [AGENT_TOOL],
		settingsEnv: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
		naming: { subagentPrefix: "A subagent's " },
		initToolsProblem(init, base) {
			if (base !== "tools") return base;
			// 2.1.319 lists the Agent call as `Task`. That alone is not a problem; anything else still is.
			const listed = init.tools;
			if (!Array.isArray(listed) || listed.some((t) => typeof t !== "string")) return base;
			if (!listed.includes(AGENT_TOOL_INIT_ALIAS) || listed.includes(AGENT_TOOL)) return base;
			const names = (listed as string[]).map((t) => (t === AGENT_TOOL_INIT_ALIAS ? AGENT_TOOL : t));
			const fixed = new Set(names);
			const nonMcp = [...fixed].filter((t) => !isAppliedMcpTool(t, applied));
			const exact =
				fixed.size === names.length &&
				nonMcp.length === CLAUDE_APPROVAL_TOOLS.length + 1 &&
				names.every(expected);
			if (!exact) return base;
			// The base check stopped at the tools; the servers it did not get to are judged here.
			const wanted = new Set(applied.mcpServers.map((s) => s.name));
			const servers = init.mcp_servers;
			if (!Array.isArray(servers)) return "mcp_servers";
			const reported: string[] = [];
			for (const s of servers) {
				if (!isRecord(s) || typeof s.name !== "string") return "mcp_servers";
				reported.push(s.name);
			}
			// Unique names and the same set: `[a, a]` for `{a, b}` has the right length and is still wrong.
			const reportedSet = new Set(reported);
			const serversOk =
				reportedSet.size === reported.length &&
				reportedSet.size === wanted.size &&
				reported.every((name) => wanted.has(name));
			return serversOk ? null : "mcp_servers";
		},
		classifyLine(message, base: LineClass): LineClass {
			if (base === "own") return base;
			const agentId = message.agent_id;
			const parent = message.parent_tool_use_id;
			// Only the shapes Claude writes for a helper: a string id, a string parent or both. Anything odd stays a stranger's.
			const agentOk = agentId === undefined || helperId(agentId) !== null;
			const parentOk = parent === undefined || parent === null || helperId(parent) !== null;
			const present = helperId(agentId) !== null || helperId(parent) !== null;
			return agentOk && parentOk && present ? "subagent" : base;
		},
		requestAllowed(params, base) {
			// A helper's own tool call. The stream separately requires the tool to be in the fork's set.
			return helperId(params.agent_id) !== null ? "allow" : base;
		},
	};
}

/** What the policy contributes when subagents are applied. Null: nothing. */
export function subagentPolicyPart(applied: AppliedForkOptions): ForkPolicyPart | null {
	return applied.subagents ? subagentPart(applied) : null;
}

/** Whether `toolName` is the Agent call. Null: not applied. */
export function subagentToolKind(toolName: string, applied: AppliedForkOptions): "agent" | null {
	return applied.subagents && toolName === AGENT_TOOL ? "agent" : null;
}

/**
 * Applies subagents when the request asks. The caller has already checked the Claude Code version against
 * `FORK_OPTION_MEASURED_VERSIONS` (both logins pass G5 and G6 there, so no mode is excluded).
 */
export async function prepareSubagents(
	asked: ForkOptionsRequest,
	ctx: ForkOptionsContext,
): Promise<PreparedPart | null> {
	if (asked.subagents !== true) return null;
	return {
		applied: { subagents: true },
		part: subagentPart({ mcpServers: [], subagents: true, claudeVersion: ctx.claudeVersion ?? "" }),
	};
}

// ---- reading an Agent request ----

export interface ParsedAgentInput {
	subagentType: string;
	/** The whole prompt. A card shows at most `AGENT_PROMPT_MAX_CHARS` of it and, past that, can only be declined. */
	prompt: string;
	description: string | null;
	/** The helper type ships inside Claude Code. */
	builtIn: boolean;
}

/**
 * The Agent call's input as a card shows it, or null when it cannot be reported (no prompt, no type, a type a
 * card cannot name): the caller then declines the request locally.
 */
export function parseAgentInput(input: Record<string, unknown>): ParsedAgentInput | null {
	const type = input.subagent_type;
	const prompt = input.prompt;
	if (typeof type !== "string" || !AGENT_TYPE_PATTERN.test(type)) return null;
	if (typeof prompt !== "string") return null;
	return {
		subagentType: type,
		prompt,
		description: typeof input.description === "string" ? input.description : null,
		builtIn: isBuiltInAgentType(type),
	};
}
