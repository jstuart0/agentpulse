/**
 * Keeps the OpenCode canary from leaving its work behind (AGEN-141, phase 0). Children are detached, so a
 * Ctrl-C, a kill signal, a crash or the run's own kill timer must end them. It signals only the process groups
 * and pids this run recorded and, per recorded data directory, the processes whose own environment names that
 * exact XDG_DATA_HOME (`lib/opencode-own-pids.ts`). Never by name. Same shape as `claude-canary-guard.ts`.
 */
import { rmSync } from "node:fs";
import { startedPids } from "./lib/opencode-canary-spawn.js";
import { killOwnOpenCodeProcesses } from "./lib/opencode-own-pids.js";

const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export interface OpenCodeGuard {
	/** A data directory some child of this run carries in its environment. */
	addDataHome(dir: string): void;
	/** A directory removed at the end (only if the run made it). */
	removeAtEnd(dir: string): void;
	/** A function run during cleanup (stop a stub, a stand-in server). */
	onCleanup(fn: () => void): void;
	cleanup(): void;
	fire(code: number): never;
}

let installed: OpenCodeGuard | null = null;

export function installOpenCodeGuard(
	options: { onExit?: (code: number) => void; kill?: typeof process.kill } = {},
): OpenCodeGuard {
	if (installed) return installed;
	const kill = options.kill ?? process.kill.bind(process);
	const dataHomes = new Set<string>();
	const removals = new Set<string>();
	const hooks: Array<() => void> = [];
	let done = false;
	const cleanup = () => {
		if (done) return;
		done = true;
		for (const pid of startedPids) {
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
		for (const dir of dataHomes) {
			try {
				killOwnOpenCodeProcesses(dir, "SIGKILL");
			} catch {
				// Nothing more can be done from an exit handler.
			}
		}
		for (const fn of hooks) {
			try {
				fn();
			} catch {
				// Same.
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
	const guard: OpenCodeGuard = {
		addDataHome: (dir) => void dataHomes.add(dir),
		removeAtEnd: (dir) => void removals.add(dir),
		onCleanup: (fn) => void hooks.push(fn),
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
export function resetOpenCodeGuardForTest(): void {
	installed = null;
}
