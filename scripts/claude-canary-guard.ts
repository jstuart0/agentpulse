/**
 * Keeps the Claude canary from leaving its work behind (AGEN-117, phase 7, P7-X1). Children are detached and hold
 * the credential in their environment, so a Ctrl-C, a kill signal, a crash or the run's own kill timer must end
 * them, and the scratch directory (homes with transcripts, the throwaway server database) goes with them.
 *
 * What it signals, and nothing else: the process groups and pids this run recorded (a real supervisor it
 * spawned, a stand-in process, a `ClaudeStream` child) and, per recorded run config directory, the processes
 * whose own environment names that exact `CLAUDE_CONFIG_DIR` (`lib/claude-own-pids.ts`). Never by name.
 * `install` once, before any child starts; it is the same shape as `codex-canary-guard.ts`.
 */
import { rmSync } from "node:fs";
import { startedPids } from "./lib/claude-canary-spawn.js";
import { killOwnClaudeProcesses } from "./lib/claude-own-pids.js";

const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export interface ClaudeGuard {
	/** A process group this run started (its leader's pid). */
	addGroup(pgid: number): void;
	/** A group that is verified gone: forgotten, so a recycled id is never signalled. */
	forgetGroup(pgid: number): void;
	/** A config directory some child of this run carries in its environment. */
	addConfigDir(dir: string): void;
	/** A directory removed at the end (only if the run made it). */
	removeAtEnd(dir: string): void;
	/** Ends everything recorded, synchronously, once. Safe to call again. */
	cleanup(): void;
	/** `cleanup`, then exit with `code`: for the kill timer. */
	fire(code: number): never;
}

let installed: ClaudeGuard | null = null;

export function installClaudeGuard(
	options: { onExit?: (code: number) => void; kill?: typeof process.kill } = {},
): ClaudeGuard {
	if (installed) return installed;
	const kill = options.kill ?? process.kill.bind(process);
	const groups = new Set<number>();
	const configDirs = new Set<string>();
	const removals = new Set<string>();
	let done = false;

	const signalGroup = (pgid: number) => {
		try {
			kill(-pgid, "SIGKILL");
		} catch {
			// Not a group leader, or already gone.
		}
	};
	const cleanup = () => {
		if (done) return;
		done = true;
		for (const pgid of groups) signalGroup(pgid);
		for (const pid of startedPids) {
			if (groups.has(pid)) continue;
			try {
				kill(-pid, "SIGKILL");
			} catch {
				try {
					kill(pid, "SIGKILL");
				} catch {
					// Exited.
				}
			}
		}
		for (const dir of configDirs) {
			try {
				killOwnClaudeProcesses(dir, "SIGKILL");
			} catch {
				// Nothing more can be done from an exit handler.
			}
		}
		for (const dir of removals) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Same.
			}
		}
	};
	const guard: ClaudeGuard = {
		addGroup: (pgid) => void groups.add(pgid),
		forgetGroup: (pgid) => void groups.delete(pgid),
		addConfigDir: (dir) => void configDirs.add(dir),
		removeAtEnd: (dir) => void removals.add(dir),
		cleanup,
		fire(code) {
			cleanup();
			(options.onExit ?? ((c: number) => process.exit(c)))(code);
			return undefined as never;
		},
	};
	process.on("exit", cleanup);
	for (const [signal, code] of Object.entries(SIGNAL_EXIT))
		process.on(signal, () => guard.fire(code));
	installed = guard;
	return guard;
}

/** For tests: forget the installed guard (the process handlers it added stay, and are harmless once `done`). */
export function resetClaudeGuardForTest(): void {
	installed = null;
}
