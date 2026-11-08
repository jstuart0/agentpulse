/**
 * What a fork's Claude may do, decided in one place (AGEN-119..123 Track 0, S4). The argv, the login probes'
 * argv, the first-prompt assertion, the line classifier, the request filter and the words a row may print all
 * read the same `ForkToolPolicy`, so they cannot drift apart. The fork options (MCP servers, subagents) change
 * the policy only through `claude-fork-mcp.ts` and `claude-fork-subagents.ts`, which own those halves; nothing
 * else edits this file to add one.
 *
 * Three checks stay in `claude-stream.ts` and cannot be loosened from here: a request outside a host turn is
 * fatal, a request for a tool the policy does not list (or an `mcp__` tool of a server that was not applied)
 * is declined, and any line after a turn's `result` is fatal.
 */
import { CLAUDE_APPROVAL_TOOLS, type ClaudeApprovalTool } from "../../shared/claude-approvals.js";
import { MCP_TOOL_PREFIX } from "../../shared/claude-fork-copy.js";
import {
	type AppliedForkOptions,
	FORK_OPTIONS_OFF,
	FORK_OPTION_MEASURED_VERSIONS,
	type ForkOptionsRequest,
	forkOptionsRequested,
} from "../../shared/session-resume.js";
import { mcpPolicyPart, mcpToolKind, prepareMcp } from "./claude-fork-mcp.js";
import { prepareSubagents, subagentPolicyPart, subagentToolKind } from "./claude-fork-subagents.js";

/** The six tools a fork has (T8). Order is the order measured. */
export const CLAUDE_FORK_TOOLS = [
	"Bash",
	"Read",
	"Write",
	"Edit",
	"NotebookEdit",
	"WebFetch",
] as const;

/** Everything else named, closed even where `--tools` already closes it: the argv measured is the argv shipped. */
export const CLAUDE_FORK_DISALLOWED_TOOLS = [
	"Agent",
	"Task",
	"SendMessage",
	"ListAgents",
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",
	"EnterWorktree",
	"ExitWorktree",
	"Skill",
	"Workflow",
	"Monitor",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"TaskStop",
	"ReportFindings",
	"ToolSearch",
	"WebSearch",
] as const;

const BASE_ASK_RULES = ["Write(*)", "Edit(*)", "NotebookEdit(*)", "WebFetch(*)"] as const;
/**
 * Background tasks off: Claude Code moves a Bash command that outlives its limit to the background and starts a
 * turn of its own when it ends, which the peer rule reads as a stranger's turn (canary `turn-guard`, 2.1.319).
 * The same variable is set in the child's environment; flag settings outrank a user's own `settings.json` env.
 */
const BASE_SETTINGS_ENV = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } as const;

/** The inline settings object of a fork with no options: ask for file changes and fetches, no background tasks, no hooks key. */
export const CLAUDE_FORK_SETTINGS = {
	permissions: { ask: BASE_ASK_RULES },
	env: BASE_SETTINGS_ENV,
} as const;

// ---- classification of a line ----

/** Why a line raises a fatal ending. */
export type ForkRejectCode = "peer_turn" | "subagent_after_turn" | "mcp_servers_changed";

/**
 * `own`: the fork's own line. `subagent`: a line a subagent of this turn produced (its tool calls are
 * recorded, its text is never reported as Claude's own words). `reject`: fatal with that code.
 */
export type LineClass = "own" | "subagent" | { reject: ForkRejectCode };

export interface ForkNaming {
	/** The name a row may print: one of the tools the policy lists, else a neutral word. */
	printableTool(name: string): string;
	/** The name a counted summary row may list, or null when the name is not printable there. */
	countedName(name: string): string | null;
	/** Put before the tool name of a call a subagent made. */
	subagentPrefix: string;
	/** The order ties in a counted summary break in. */
	order: readonly string[];
}

export interface ForkToolPolicy {
	tools: readonly string[];
	disallowedTools: readonly string[];
	/** The private `--mcp-config` file, or null. `--strict-mcp-config` is always on. */
	mcpConfigPath: string | null;
	askRules: readonly string[];
	settingsEnv: Readonly<Record<string, string>>;
	/** The tool-related argv every Claude the host starts shares; it never holds `--mcp-config` (F41). */
	probeArgs: string[];
	/** `--mcp-config <path>` when MCP is applied, else nothing. */
	extraArgs: string[];
	/** What `applied` the policy was built from. */
	applied: AppliedForkOptions;
	/** A short code naming what the first `init` got wrong about tools or MCP servers, or null. */
	initToolsProblem(init: Record<string, unknown>): "tools" | "mcp_servers" | null;
	classifyLine(message: Record<string, unknown>): LineClass;
	/** Consulted for a request that carries `agent_id`; the default declines it. */
	requestAllowed(params: Record<string, unknown>): "allow" | "decline";
	naming: ForkNaming;
}

/** What a ticket-owned half contributes. Every member is optional and only adds to or narrows the base. */
export interface ForkPolicyPart {
	extraTools?: readonly string[];
	/** Tools taken out of the disallowed list (the Agent call, when subagents apply). */
	allowTools?: readonly string[];
	mcpConfigPath?: string;
	askRules?: readonly string[];
	settingsEnv?: Readonly<Record<string, string>>;
	initToolsProblem?(
		init: Record<string, unknown>,
		base: "tools" | "mcp_servers" | null,
	): "tools" | "mcp_servers" | null | undefined;
	classifyLine?(message: Record<string, unknown>, base: LineClass): LineClass;
	requestAllowed?(params: Record<string, unknown>, base: "allow" | "decline"): "allow" | "decline";
	naming?: Partial<ForkNaming>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

function baseNaming(tools: readonly string[]): ForkNaming {
	return {
		printableTool: (name) => (tools.includes(name) ? name : "A tool"),
		countedName: (name) => (tools.includes(name) ? name : null),
		subagentPrefix: "Subagent ",
		order: tools,
	};
}

function serverNames(applied: AppliedForkOptions): Set<string> {
	return new Set(applied.mcpServers.map((s) => s.name));
}

/** The policy for what was applied. With `FORK_OPTIONS_OFF` it is exactly the policy shipped before the options. */
export function forkToolPolicy(applied: AppliedForkOptions = FORK_OPTIONS_OFF): ForkToolPolicy {
	const parts = [mcpPolicyPart(applied), subagentPolicyPart(applied)].filter(
		(p): p is ForkPolicyPart => p !== null,
	);
	const allow = new Set(parts.flatMap((p) => p.allowTools ?? []));
	const tools = [...CLAUDE_FORK_TOOLS, ...parts.flatMap((p) => p.extraTools ?? [])];
	const disallowedTools = CLAUDE_FORK_DISALLOWED_TOOLS.filter((t) => !allow.has(t));
	const askRules = [...BASE_ASK_RULES, ...parts.flatMap((p) => p.askRules ?? [])];
	const settingsEnv: Record<string, string> = { ...BASE_SETTINGS_ENV };
	for (const part of parts) Object.assign(settingsEnv, part.settingsEnv);
	const mcpConfigPath = parts.find((p) => p.mcpConfigPath !== undefined)?.mcpConfigPath ?? null;

	const settings = JSON.stringify({ permissions: { ask: askRules }, env: settingsEnv });
	const probeArgs = [
		"--tools",
		tools.join(","),
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--disallowedTools",
		disallowedTools.join(","),
		"--settings",
		settings,
	];
	const names = serverNames(applied);
	const naming: ForkNaming = baseNaming(tools);
	for (const part of parts) Object.assign(naming, part.naming);

	return {
		tools,
		disallowedTools,
		mcpConfigPath,
		askRules,
		settingsEnv,
		probeArgs,
		extraArgs: mcpConfigPath === null ? [] : ["--mcp-config", mcpConfigPath],
		applied,
		initToolsProblem(init) {
			const tool = init.tools;
			const listed = Array.isArray(tool) ? tool : null;
			let base: "tools" | "mcp_servers" | null = null;
			if (
				listed === null ||
				listed.length !== tools.length ||
				!listed.every((t) => typeof t === "string" && tools.includes(t)) ||
				new Set(listed).size !== tools.length
			) {
				base = "tools";
			} else if (
				!Array.isArray(init.mcp_servers) ||
				init.mcp_servers.length !== names.size ||
				!init.mcp_servers.every(
					(s) => isRecord(s) && typeof s.name === "string" && names.has(s.name),
				)
			) {
				base = "mcp_servers";
			}
			// A half that has an opinion returns it, `null` ("this init is fine") included; one without returns undefined.
			return parts.reduce<"tools" | "mcp_servers" | null>((acc, part) => {
				const verdict = part.initToolsProblem?.(init, acc);
				return verdict === undefined ? acc : verdict;
			}, base);
		},
		classifyLine(message) {
			const own = message.agent_id === undefined && (message.parent_tool_use_id ?? null) === null;
			const base: LineClass = own ? "own" : { reject: "peer_turn" };
			return parts.reduce<LineClass>((acc, part) => part.classifyLine?.(message, acc) ?? acc, base);
		},
		requestAllowed(params) {
			return parts.reduce<"allow" | "decline">(
				(acc, part) => part.requestAllowed?.(params, acc) ?? acc,
				"decline",
			);
		},
		naming,
	};
}

/** Whether `toolName` is an `mcp__<server>__…` tool of a server that was applied. */
export function isAppliedMcpTool(toolName: string, applied: AppliedForkOptions): boolean {
	if (!toolName.startsWith(MCP_TOOL_PREFIX)) return false;
	const rest = toolName.slice(MCP_TOOL_PREFIX.length);
	return applied.mcpServers.some((s) => rest.startsWith(`${s.name}__`));
}

export type ClaudeToolKind = ClaudeApprovalTool | "mcp" | "agent";

/** The host's tool table: one of the six, an MCP tool of an applied server, the Agent call when applied, else null. */
export function claudeToolKind(
	toolName: string,
	applied: AppliedForkOptions = FORK_OPTIONS_OFF,
): ClaudeToolKind | null {
	if ((CLAUDE_APPROVAL_TOOLS as readonly string[]).includes(toolName)) {
		return toolName as ClaudeApprovalTool;
	}
	return mcpToolKind(toolName, applied) ?? subagentToolKind(toolName, applied);
}

// ---- preparing the options before the argv is built ----

export interface ForkOptionsContext {
	/** The Claude Code version the binary reported. Options apply only on `FORK_OPTION_MEASURED_VERSIONS`. */
	claudeVersion: string | null;
	/** What the fork was started with, for a recovery: the digests it must still match. */
	stored?: AppliedForkOptions | null;
	log?: (line: string) => void;
}

/** What one ticket-owned half applied and what to undo when the fork ends. */
export interface PreparedPart {
	applied: Partial<Pick<AppliedForkOptions, "mcpServers" | "subagents">>;
	part: ForkPolicyPart;
	cleanup?: () => void | Promise<void>;
}

export interface PreparedForkOptions {
	applied: AppliedForkOptions;
	policy: ForkToolPolicy;
	/** Removes what preparing wrote (a private config file). Idempotent; the stream calls it when the fork ends. */
	cleanup: () => Promise<void>;
}

/**
 * Applies what the person asked for, before the argv is built (a takeover, and a recovery from its stored
 * value). Applies nothing unless the Claude Code version is one the options were measured on. Track 0's halves
 * apply nothing, so the result is the policy shipped before the options and a no-op cleanup.
 */
export async function prepareForkOptions(
	asked: ForkOptionsRequest | undefined | null,
	ctx: ForkOptionsContext,
): Promise<PreparedForkOptions> {
	const claudeVersion = ctx.claudeVersion ?? "";
	let applied: AppliedForkOptions = { ...FORK_OPTIONS_OFF, claudeVersion };
	const cleanups: Array<() => void | Promise<void>> = [];
	const wanted = asked ?? {};
	if (
		(forkOptionsRequested(wanted) || ctx.stored) &&
		FORK_OPTION_MEASURED_VERSIONS.includes(claudeVersion)
	) {
		for (const prepare of [prepareMcp, prepareSubagents]) {
			const prepared = await prepare(wanted, ctx);
			if (prepared === null) continue;
			applied = { ...applied, ...prepared.applied };
			if (prepared.cleanup) cleanups.push(prepared.cleanup);
		}
	}
	let cleaned = false;
	return {
		applied,
		policy: forkToolPolicy(applied),
		async cleanup() {
			if (cleaned) return;
			cleaned = true;
			for (const fn of cleanups) {
				try {
					await fn();
				} catch (error) {
					ctx.log?.(
						`[claude-fork] cleanup failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`,
					);
				}
			}
		},
	};
}
