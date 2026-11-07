/**
 * The one controlled fatal exit: dispose every child runtime this supervisor still holds (managed Codex
 * app-servers, headless Claude processes), wait for them to be gone, then exit so the service manager
 * restarts the supervisor. Used when the server confirms the supervisor's credential is rejected.
 * Interactive terminals are not children of the supervisor and are left running.
 */
import { disposeAllHeadlessRuntimes } from "../providers/claude-headless.js";
import { disposeAllClaudeStreamRuntimes } from "../providers/claude-stream.js";
import { disposeAllManagedCodexRuntimes } from "../providers/codex-managed.js";

/**
 * How long the exit waits for the Codex children: stdin close, then SIGTERM, then SIGKILL is at most six
 * seconds, so this is the same five seconds plus the wait for the process to be gone, and no more. If the
 * supervisor dies first instead, the pipe ends close and the child sees end of file.
 */
export const CODEX_SHUTDOWN_BOUND_MS = 5_000;

/**
 * How long the exit waits for the headless Claude children: the stop ladder is up to a second of waiting for
 * the process table (once before the first signal, once per signal), two seconds after SIGTERM and one after
 * SIGKILL, so ten seconds covers it with room, and a hung `ps` or a child that won't die can't keep a
 * supervisor with a revoked credential alive.
 */
export const HEADLESS_SHUTDOWN_BOUND_MS = 10_000;

/** Resolves `work`, or after `ms` whichever is first. Never rejects. */
async function within(work: Promise<void>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	try {
		await Promise.race([work.catch(() => {}), bound]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * How long the exit waits for takeover forks: stdin first (no interrupt, the process is going away), then
 * SIGTERM and SIGKILL, with the process-table waits around each; the same bound as the headless children.
 */
export const CLAUDE_STREAM_SHUTDOWN_BOUND_MS = 10_000;

export async function disposeRuntimesAndExit(
	options: { codexBoundMs?: number; headlessBoundMs?: number; streamBoundMs?: number } = {},
): Promise<never> {
	await Promise.all([
		within(disposeAllManagedCodexRuntimes(), options.codexBoundMs ?? CODEX_SHUTDOWN_BOUND_MS),
		within(disposeAllHeadlessRuntimes(), options.headlessBoundMs ?? HEADLESS_SHUTDOWN_BOUND_MS),
		within(
			disposeAllClaudeStreamRuntimes(),
			options.streamBoundMs ?? CLAUDE_STREAM_SHUTDOWN_BOUND_MS,
		),
	]);
	process.exit(1);
}
