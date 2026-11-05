/**
 * Keeps the canary's copy of the user's Codex `auth.json` from outliving the run. Install the guard BEFORE the
 * copy is made. It removes the file synchronously when the process exits for any reason, and on SIGINT,
 * SIGTERM and SIGHUP it also kills the Codex children's process groups (they are detached, so a signal to this
 * process doesn't reach them) and exits non-zero.
 */
import { rmSync } from "node:fs";

export function removeAuthCopy(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Nothing more can be done from an exit handler.
	}
}

const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** `childGroups` is read at signal time and returns the process-group ids of the Codex children started so far. */
export function guardAuthCopy(path: string, childGroups: () => number[]): void {
	process.on("exit", () => removeAuthCopy(path));
	for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
		process.on(signal, () => {
			removeAuthCopy(path);
			for (const group of childGroups()) {
				try {
					process.kill(-group, "SIGKILL");
				} catch {
					// Not a group leader or already gone.
				}
			}
			process.exit(code);
		});
	}
}
