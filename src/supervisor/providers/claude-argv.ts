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
import { type ForkToolPolicy, forkToolPolicy } from "./claude-fork-tools.js";

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

/** What the tool policy says the fork's Claude gets: tools, the closed list, the inline settings, and `--mcp-config` only when applied. */
function toolArgs(policy: ForkToolPolicy): string[] {
	return [...policy.probeArgs, ...policy.extraArgs];
}

function assertSessionId(label: string, id: string): void {
	if (!isResumableSessionId(id)) throw new ClaudeArgvError(`${label} is not a session id`);
}

function assertMode(mode: ClaudeForkMode): void {
	if (mode !== "ask" && mode !== "restricted") throw new ClaudeArgvError("unknown fork mode");
}

/** A new session N that continues S's conversation. S is never opened for writing: the fork is a copy. */
export function forkArgv(input: {
	source: string;
	fork: string;
	mode: ClaudeForkMode;
	policy?: ForkToolPolicy;
}): string[] {
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
		...toolArgs(input.policy ?? forkToolPolicy()),
	];
}

/** Resumes a fork this host started. The record is the host's own, never anything a report carried. */
export function inPlaceArgv(input: {
	fork: string;
	record: ForkThreadRecord | null | undefined;
	mode: ClaudeForkMode;
	policy?: ForkToolPolicy;
}): string[] {
	assertMode(input.mode);
	assertSessionId("The session", input.fork);
	const record = input.record;
	if (!record || !isResumableSessionId(record.source) || record.source === input.fork) {
		throw new ClaudeArgvError("This host has no record that it forked this session");
	}
	return [
		...baseArgs(input.mode),
		"--resume",
		input.fork,
		...toolArgs(input.policy ?? forkToolPolicy()),
	];
}

/** The fork argv minus the three flags that name a conversation: what the login probes run (T4). */
export function probeArgv(input: { mode: ClaudeForkMode; policy?: ForkToolPolicy }): string[] {
	assertMode(input.mode);
	// The login probe never starts an MCP server: it keeps `--strict-mcp-config` and never an `--mcp-config` (F41).
	return [...baseArgs(input.mode), ...(input.policy ?? forkToolPolicy()).probeArgs];
}
