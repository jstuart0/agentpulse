/**
 * What a Stop must stop (AGEN-110, AGEN-117 T11). The server names it on the stop action
 * (`metadata.runtime`) from the session's launch; the host switches on it. One module, so the writer and
 * the reader hold the same values and a test can walk every one of them.
 */
export const STOP_RUNTIMES = {
	/** A managed Codex app-server. Also what an action with no runtime means (a server from before the field). */
	codex: "codex",
	/** A fork or takeover carrier on Claude's long-lived stream process (P3 wires the host side). */
	claudeStream: "claude_stream",
	/** A launched headless Claude: one child per prompt. */
	claudeHeadless: "claude_headless",
	/** A Claude launched in a terminal: nothing here can stop it. */
	claudeTerminal: "claude_terminal",
} as const;

export type StopRuntime = (typeof STOP_RUNTIMES)[keyof typeof STOP_RUNTIMES];

export const STOP_RUNTIME_VALUES: readonly StopRuntime[] = Object.values(STOP_RUNTIMES);

/** The runtimes of a Claude launch: a stop for one needs a host that advertises `claude_stop`. */
export function isClaudeStopRuntime(runtime: string | null): boolean {
	return (
		runtime === STOP_RUNTIMES.claudeStream ||
		runtime === STOP_RUNTIMES.claudeHeadless ||
		runtime === STOP_RUNTIMES.claudeTerminal
	);
}

/**
 * The refusal code and words for a Stop on a session started in a terminal (AGEN-110, D8): nothing here can
 * stop that process, so the server refuses at enqueue, before a lock is taken or a row written.
 */
export const STOP_NOT_SUPPORTED = "stop_not_supported";
export const STOP_NOT_SUPPORTED_MESSAGE =
	"Stop isn't available for sessions started in a terminal yet. Stop it in that terminal.";

/** Managed states in which the session has ended: nothing is left to stop. */
export const TERMINAL_MANAGED_STATES: ReadonlySet<string> = new Set([
	"stopped",
	"completed",
	"failed",
]);

/** Launch statuses in which the launch has finished. */
export const FINISHED_LAUNCH_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
]);
