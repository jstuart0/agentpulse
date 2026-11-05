/**
 * The canary's only search-and-kill helper. `pgrep -x codex` produces candidates; a candidate is signalled
 * only when its environment names this run's exact CODEX_HOME. Never select a process by name alone.
 */
import { spawnSync } from "node:child_process";

/** True when the whole token `CODEX_HOME=<codexHome>` is in `command`: not a prefix of a longer path, not part of another name. */
export function namesCodexHome(command: string, codexHome: string): boolean {
	const escaped = codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|\\s)CODEX_HOME=${escaped}(\\s|$)`).test(command);
}

/** Codex processes whose environment names this run's CODEX_HOME: also those a launch still in flight hasn't returned yet. */
export function ownCodexPids(
	codexHome: string,
	matches: (command: string, codexHome: string) => boolean = namesCodexHome,
): number[] {
	return spawnSync("pgrep", ["-x", "codex"], { encoding: "utf8" })
		.stdout.split("\n")
		.filter(Boolean)
		.filter((pid) =>
			matches(
				spawnSync("ps", ["-Eww", "-p", pid, "-o", "command="], { encoding: "utf8" }).stdout.trim(),
				codexHome,
			),
		)
		.map(Number);
}

/** SIGKILL the group of each of this run's Codex processes, or the process itself when it leads no group. */
export function killOwnCodexProcesses(codexHome: string): void {
	for (const pid of ownCodexPids(codexHome)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
}
