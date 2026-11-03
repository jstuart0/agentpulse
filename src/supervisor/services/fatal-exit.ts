/**
 * The one controlled fatal exit: dispose every child runtime this supervisor still holds (managed Codex
 * app-servers, headless Claude processes), wait for them to be gone, then exit so the service manager
 * restarts the supervisor. Used when the server confirms the supervisor's credential is rejected.
 * Interactive terminals are not children of the supervisor and are left running.
 */
import { disposeAllHeadlessRuntimes } from "../providers/claude-headless.js";
import { disposeAllManagedCodexRuntimes } from "../providers/codex-managed.js";

/**
 * How long the exit waits for the Codex children: stdin close, then SIGTERM, then SIGKILL is at most six
 * seconds, so this is the same five seconds plus the wait for the process to be gone, and no more. If the
 * supervisor dies first instead, the pipe ends close and the child sees end of file.
 */
export const CODEX_SHUTDOWN_BOUND_MS = 5_000;

export async function disposeRuntimesAndExit(
	options: { codexBoundMs?: number } = {},
): Promise<never> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, options.codexBoundMs ?? CODEX_SHUTDOWN_BOUND_MS);
	});
	try {
		const codex = disposeAllManagedCodexRuntimes();
		await Promise.all([Promise.race([codex, bound]), disposeAllHeadlessRuntimes()]);
	} finally {
		clearTimeout(timer);
	}
	process.exit(1);
}
