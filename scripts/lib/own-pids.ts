/**
 * The canaries' only search-and-signal helper (Codex and Claude both call it through a thin wrapper). A
 * process whose name is `processName` is a candidate; it is signalled only when its own environment carries the
 * whole token `<envVar>=<value>` for this run's exact throwaway directory. Never select a process by name alone.
 *
 * macOS only: a process's environment is read with `ps -Eww`. Where that flag isn't supported nothing matches,
 * so on other platforms this selects (and signals) nothing rather than guessing.
 */
import { spawnSync } from "node:child_process";

export interface OwnProcessSpec {
	/** The executable name as `pgrep -x` sees it. */
	processName: string;
	/** The environment variable that names this run's throwaway directory. */
	envVar: string;
}

export type EnvMatcher = (command: string, envVar: string, value: string) => boolean;

/** True when the whole token `<envVar>=<value>` is in `command`: not a prefix of a longer path, not part of another name. */
export const namesEnvValue: EnvMatcher = (command, envVar, value) => {
	const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|\\s)${escapeRegex(envVar)}=${escapeRegex(value)}(\\s|$)`).test(command);
};

/** Matching processes whose environment names this run's directory: also those a launch still in flight hasn't returned yet. */
export function ownPids(
	spec: OwnProcessSpec,
	value: string,
	matches: EnvMatcher = namesEnvValue,
): number[] {
	return spawnSync("pgrep", ["-x", spec.processName], { encoding: "utf8" })
		.stdout.split("\n")
		.filter(Boolean)
		.filter((pid) =>
			matches(
				spawnSync("ps", ["-Eww", "-p", pid, "-o", "command="], { encoding: "utf8" }).stdout.trim(),
				spec.envVar,
				value,
			),
		)
		.map(Number);
}

/** Signal the group of each of this run's processes, or the process itself when it leads no group. */
export function signalOwnProcesses(
	spec: OwnProcessSpec,
	value: string,
	signal: NodeJS.Signals = "SIGKILL",
): void {
	for (const pid of ownPids(spec, value)) {
		try {
			process.kill(-pid, signal);
		} catch {
			try {
				process.kill(pid, signal);
			} catch {}
		}
	}
}
