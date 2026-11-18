/**
 * Dotted-version comparison for the protocol gates (Codex's floor, Claude Code's range). The code lives
 * in `src/shared/version.ts`, beside the strict release-version grammar; this file keeps the old import path.
 */
export {
	type Version,
	compareVersions,
	parseVersion,
	versionInRange,
} from "../../shared/version.js";
