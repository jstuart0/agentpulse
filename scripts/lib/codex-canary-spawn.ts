/**
 * The one place a canary starts Codex (AGEN-115, phase 5). It builds the environment (a throwaway `HOME` and
 * `CODEX_HOME`, `AGENTPULSE_SKIP=1`), allows only the subcommands a canary needs, refuses any `daemon`
 * subcommand but `start`, `stop` and `version`, and never starts a terminal user interface. See
 * `codex-canary-safety.ts` for the rules the CI scan holds the rest of `scripts/` to.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { ALLOWED_DAEMON_SUBCOMMANDS } from "./codex-canary-safety.js";

export interface CodexRunOptions {
	codexHome: string;
	home: string;
	cwd: string;
	/** Extra environment, applied last except for the three names this module owns. */
	env?: Record<string, string>;
	timeoutMs?: number;
}

/**
 * Throws unless `args` is something a canary may run: `exec`, `--version`, a plain `app-server` (stdio), and
 * `app-server daemon` with only `start`, `stop` or `version`. `bootstrap` installs a durable service on the
 * machine, `update` and `restart` change one that may hold someone else's work: none of them, ever.
 */
export function assertAllowedCodexArgs(args: readonly string[]): void {
	const [first, second, third] = args;
	if (first === "exec" || first === "--version") return;
	if (first === "app-server" && second === undefined) return;
	if (first === "app-server" && second === "daemon") {
		if (
			third &&
			(ALLOWED_DAEMON_SUBCOMMANDS as readonly string[]).includes(third) &&
			args.length === 3
		)
			return;
		throw new Error(`codex app-server daemon ${third ?? ""} isn't allowed in a canary`);
	}
	throw new Error(`codex ${args.join(" ") || "(no subcommand)"} isn't allowed in a canary`);
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
