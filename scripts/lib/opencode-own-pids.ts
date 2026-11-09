/**
 * OpenCode's caller of `lib/own-pids.ts` (AGEN-141, phase 0): processes named `opencode` whose environment names
 * this run's exact XDG_DATA_HOME. A person's own OpenCode (any other value, or none), another run's children and
 * the user's relay and supervisor are never selected. The process name is a first filter only, never a match.
 */
import { type OwnProcessSpec, ownPids, ownPidsAny, signalOwnProcesses } from "./own-pids.js";

const OPENCODE: OwnProcessSpec = { processName: "opencode", envVar: "XDG_DATA_HOME" };

export const ownOpenCodePids = (dataHome: string): number[] => ownPids(OPENCODE, dataHome);

/** The same for many data directories in one scan. */
export const ownOpenCodePidsAny = (dataHomes: readonly string[]): number[] =>
	ownPidsAny(OPENCODE, dataHomes);

export function killOwnOpenCodeProcesses(
	dataHome: string,
	signal: NodeJS.Signals = "SIGKILL",
): void {
	signalOwnProcesses(OPENCODE, dataHome, signal);
}
