/**
 * Claude's caller of `lib/own-pids.ts` (AGEN-117, phase 0): processes named `claude` whose environment names
 * this run's exact CLAUDE_CONFIG_DIR. A person's own Claude sessions, the supervisor's launches and any other
 * run's children all carry another value (or none) and are never selected.
 */
import {
	type EnvMatcher,
	type OwnProcessSpec,
	namesEnvValue,
	ownPids,
	signalOwnProcesses,
} from "./own-pids.js";

const CLAUDE: OwnProcessSpec = { processName: "claude", envVar: "CLAUDE_CONFIG_DIR" };

export function namesClaudeConfigDir(command: string, configDir: string): boolean {
	return namesEnvValue(command, CLAUDE.envVar, configDir);
}

export function ownClaudePids(
	configDir: string,
	matches: (command: string, configDir: string) => boolean = namesClaudeConfigDir,
): number[] {
	const adapt: EnvMatcher = (command, _envVar, value) => matches(command, value);
	return ownPids(CLAUDE, configDir, adapt);
}

/** SIGTERM first by default: SIGKILL of Claude leaves a running Bash behind in its own group (phase 0, m10). */
export function killOwnClaudeProcesses(
	configDir: string,
	signal: NodeJS.Signals = "SIGTERM",
): void {
	signalOwnProcesses(CLAUDE, configDir, signal);
}
