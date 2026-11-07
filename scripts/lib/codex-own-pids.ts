/** Codex's caller of `lib/own-pids.ts`: processes named `codex` whose environment names this run's exact CODEX_HOME. */
import {
	type EnvMatcher,
	type OwnProcessSpec,
	namesEnvValue,
	ownPids,
	signalOwnProcesses,
} from "./own-pids.js";

const CODEX: OwnProcessSpec = { processName: "codex", envVar: "CODEX_HOME" };

/** True when the whole token `CODEX_HOME=<codexHome>` is in `command`. */
export function namesCodexHome(command: string, codexHome: string): boolean {
	return namesEnvValue(command, CODEX.envVar, codexHome);
}

/** Codex processes whose environment names this run's CODEX_HOME. */
export function ownCodexPids(
	codexHome: string,
	matches: (command: string, codexHome: string) => boolean = namesCodexHome,
): number[] {
	const adapt: EnvMatcher = (command, _envVar, value) => matches(command, value);
	return ownPids(CODEX, codexHome, adapt);
}

/** SIGKILL the group of each of this run's Codex processes, or the process itself when it leads no group. */
export function killOwnCodexProcesses(codexHome: string): void {
	signalOwnProcesses(CODEX, codexHome, "SIGKILL");
}
