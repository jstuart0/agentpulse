/**
 * The one place a canary starts Codex (AGEN-115, phase 5). It builds the environment (a throwaway `HOME` and
 * `CODEX_HOME`, `AGENTPULSE_SKIP=1`), allows only the subcommands a canary needs, refuses any `daemon`
 * subcommand but `start`, `stop` and `version`, and never starts a terminal user interface. See
 * `codex-canary-safety.ts` for the rules the CI scan holds the rest of `scripts/` to.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { ALLOWED_CODEX_SUBCOMMANDS, ALLOWED_DAEMON_SUBCOMMANDS } from "./codex-canary-safety.js";

export interface CodexRunOptions {
	codexHome: string;
	home: string;
	cwd: string;
	/** Extra environment, applied last except for the three names this module owns. */
	env?: Record<string, string>;
	timeoutMs?: number;
}

/** Throws unless `args` is something a canary may run. Exported so the CI test can drive it with no Codex. */
export function assertAllowedCodexArgs(args: readonly string[]): void {
	const first = args[0];
	if (!first || !(ALLOWED_CODEX_SUBCOMMANDS as readonly string[]).includes(first)) {
		throw new Error(`codex ${first ?? "(no subcommand)"} isn't allowed in a canary`);
	}
	if (first === "daemon") {
		const sub = args[1];
		if (!sub || !(ALLOWED_DAEMON_SUBCOMMANDS as readonly string[]).includes(sub)) {
			throw new Error(`codex daemon ${sub ?? ""} isn't allowed in a canary`);
		}
	}
}

function envFor(options: CodexRunOptions): NodeJS.ProcessEnv {
	return {
		...process.env,
		...options.env,
		HOME: options.home,
		CODEX_HOME: options.codexHome,
		AGENTPULSE_SKIP: "1",
	};
}

/** Runs one allowed Codex command to completion. */
export function runCodex(args: readonly string[], options: CodexRunOptions) {
	assertAllowedCodexArgs(args);
	return spawnSync("codex", [...args], {
		cwd: options.cwd,
		env: envFor(options),
		encoding: "utf8",
		timeout: options.timeoutMs ?? 120_000,
	});
}

/** Starts one allowed Codex command in its own process group, for the caller to speak to and to end. */
export function startCodex(args: readonly string[], options: CodexRunOptions): ChildProcess {
	assertAllowedCodexArgs(args);
	return spawn("codex", [...args], {
		cwd: options.cwd,
		env: envFor(options),
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
}
