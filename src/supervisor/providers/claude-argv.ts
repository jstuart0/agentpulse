/**
 * The only place a takeover's `claude` argv is built (AGEN-117 T4, T5, T8). Everything that decides what
 * the process may do is here, so a test can hold it by equality and nothing else can drift from it.
 *
 * The rules that make a second writer on a person's conversation impossible:
 * - `forkArgv` always carries `--resume S --fork-session --session-id N` together, and refuses `N === S`
 *   (measured: `--fork-session --session-id S` appends to S) or an id that isn't a UUID.
 * - `inPlaceArgv` is `--resume N` with no `--session-id`, and only for an N the host's own thread record
 *   says it forked from some other session. No call shape yields a bare `--resume` for an id the host did
 *   not itself fork.
 * - `--permission-mode` comes from `launch-privileges.ts` (`manual`, which is `default`); `bypassPermissions`
 *   and the other modes are not reachable.
 * - `--restricted` is added by the mode and nothing else changes with it.
 */
import { requireLaunchPrivileges } from "../../shared/launch-privileges.js";
import {
	CLAUDE_TAKEOVER_PRIVILEGES,
	type ClaudeForkMode,
	isResumableSessionId,
} from "../../shared/session-resume.js";

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

/** The one inline settings object: ask for file changes and fetches, no hooks key, nothing else. */
export const CLAUDE_FORK_SETTINGS = {
	permissions: { ask: ["Write(*)", "Edit(*)", "NotebookEdit(*)", "WebFetch(*)"] },
} as const;

/** What the host records about a fork it started, and later requires before it resumes it in place. */
export type ForkThreadRecord = { source: string; mode: ClaudeForkMode };

export class ClaudeArgvError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaudeArgvError";
	}
}

function privilegeArgs(): string[] {
	return requireLaunchPrivileges(
		"claude_code",
		CLAUDE_TAKEOVER_PRIVILEGES.approvalPolicy,
		CLAUDE_TAKEOVER_PRIVILEGES.sandboxMode,
	).cliArgs;
}

/** The part every argv shares: stream-json both ways, the approval path on stdio, user settings only, the fixed tools. */
function baseArgs(mode: ClaudeForkMode): string[] {
	return [
		"--output-format",
		"stream-json",
		"--verbose",
		"--input-format",
		"stream-json",
		"--permission-prompt-tool=stdio",
		...privilegeArgs(),
		"--setting-sources",
		"user",
		...(mode === "restricted" ? ["--restricted"] : []),
	];
}

function toolArgs(): string[] {
	return [
		"--tools",
		CLAUDE_FORK_TOOLS.join(","),
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--disallowedTools",
		CLAUDE_FORK_DISALLOWED_TOOLS.join(","),
		"--settings",
		JSON.stringify(CLAUDE_FORK_SETTINGS),
	];
}

function assertSessionId(label: string, id: string): void {
	if (!isResumableSessionId(id)) throw new ClaudeArgvError(`${label} is not a session id`);
}

function assertMode(mode: ClaudeForkMode): void {
	if (mode !== "ask" && mode !== "restricted") throw new ClaudeArgvError("unknown fork mode");
}

/** A new session N that continues S's conversation. S is never opened for writing: the fork is a copy. */
export function forkArgv(input: { source: string; fork: string; mode: ClaudeForkMode }): string[] {
	assertMode(input.mode);
	assertSessionId("The source", input.source);
	assertSessionId("The fork", input.fork);
	if (input.fork === input.source) {
		throw new ClaudeArgvError("The fork must be a new session, not the one it continues");
	}
	return [
		...baseArgs(input.mode),
		"--resume",
		input.source,
		"--fork-session",
		"--session-id",
		input.fork,
		...toolArgs(),
	];
}

/** Resumes a fork this host started. The record is the host's own, never anything a report carried. */
export function inPlaceArgv(input: {
	fork: string;
	record: ForkThreadRecord | null | undefined;
	mode: ClaudeForkMode;
}): string[] {
	assertMode(input.mode);
	assertSessionId("The session", input.fork);
	const record = input.record;
	if (!record || !isResumableSessionId(record.source) || record.source === input.fork) {
		throw new ClaudeArgvError("This host has no record that it forked this session");
	}
	return [...baseArgs(input.mode), "--resume", input.fork, ...toolArgs()];
}

/** The fork argv minus the three flags that name a conversation: what the login probes run (T4). */
export function probeArgv(input: { mode: ClaudeForkMode }): string[] {
	assertMode(input.mode);
	return [...baseArgs(input.mode), ...toolArgs()];
}
