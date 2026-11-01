/**
 * The one controlled fatal exit: dispose every child runtime this supervisor still holds (managed Codex
 * app-servers, headless Claude processes), wait for them to be gone, then exit so the service manager
 * restarts the supervisor. Used when the server confirms the supervisor's credential is rejected.
 * Interactive terminals are not children of the supervisor and are left running.
 */
import { disposeAllHeadlessRuntimes } from "../providers/claude-headless.js";
import { disposeAllManagedCodexRuntimes } from "../providers/codex-managed.js";

export async function disposeRuntimesAndExit(): Promise<never> {
	disposeAllManagedCodexRuntimes();
	await disposeAllHeadlessRuntimes();
	process.exit(1);
}
