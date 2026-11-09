/**
 * The rules a live OpenCode canary keeps, as code, so a CI test with no OpenCode can hold them (AGEN-141,
 * phase 0). The measurement run once ran `opencode --version` without a sandbox and created directories in the
 * real home; these make that impossible, not merely discouraged.
 *
 *  1. OpenCode starts only through `scripts/lib/opencode-canary-spawn.ts`, whose every spawn calls
 *     `assertOpenCodeSandbox` first: the environment is built from nothing; HOME, every XDG variable and TMPDIR
 *     are throwaway directories strictly inside the scratch root (clear of the person's real state, links
 *     followed); the cwd is inside scratch; autoupdate and the models fetch are off; stdin is closed.
 *  2. The binary is an absolute path whose version and sha256 equal a pin (`opencode-canary-pins.ts`).
 *  3. Only `run`, `serve`, `--version` and `service start|stop|status` (plus `--standalone`) run. Never
 *     `upgrade`, `plugin`, `auth` or `uninstall`.
 *  4. Nothing is killed by name. A process is signalled by a pid this run started, or by a pid whose own
 *     environment names this run's exact XDG_DATA_HOME (`lib/own-pids.ts`, the one searching helper).
 *  5. Loopback only; the model is a stub. Every child runs under `sandbox-exec` with `NETWORK_PROFILE`, which
 *     refuses all outbound traffic except to localhost and unix sockets (measured: a bare 1.19.5 run connected
 *     to the npm registry on its own, so a "sample the sockets and fail" watch alone isn't enough).
 *
 * `scanText` is an advisory tripwire for accidents, not a barrier: what holds the line is rule 1 at run time.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PROCESS_SEARCH_FILE, stripComments } from "./codex-canary-safety.js";
import { assertThrowawayHome, inside } from "./throwaway-home.js";

/** The person's real home, read once when this module loads: before anything in the run can override HOME. */
export const REAL_HOME = homedir();

/** Files that may start OpenCode. */
export const OPENCODE_SPAWN_ALLOWED_FILES = ["scripts/lib/opencode-canary-spawn.ts"];
/** The file that holds the rules; the scan doesn't read it, since its own patterns are what it looks for. */
export const RULES_FILE = "scripts/lib/opencode-canary-safety.ts";
export { PROCESS_SEARCH_FILE };

/** The person's real OpenCode state and the other agents' homes: never reached, never written. */
export function forbiddenPaths(realHome: string = REAL_HOME): string[] {
	return [
		realHome,
		join(realHome, ".config", "opencode"),
		join(realHome, ".local", "share", "opencode"),
		join(realHome, ".local", "state", "opencode"),
		join(realHome, ".cache", "opencode"),
		join(realHome, ".agentpulse"),
		join(realHome, ".claude"),
		join(realHome, ".codex"),
	];
}

/** The seven variables that must each be a throwaway directory. */
export const SANDBOX_DIR_VARS = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	"TMPDIR",
] as const;

export const SANDBOX_PATH = "/usr/bin:/bin";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** macOS seatbelt profile: everything allowed except outbound network other than localhost and unix sockets. */
export const NETWORK_PROFILE = `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
`;

/** Optional variables, each a path that must be inside scratch when set. */
const OPTIONAL_PATH_VARS = ["OPENCODE_CONFIG_DIR", "OPENCODE_DB"] as const;
const REQUIRED_FLAGS = ["OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_MODELS_FETCH"] as const;
/** Extra names a scenario may add: its own probe and stub settings, and the skip switch under test. */
const EXTRA_NAME =
	/^(PROBE_[A-Z0-9_]+|STUB_[A-Z0-9_]+|AGENTPULSE_SKIP|NPM_CONFIG_REGISTRY|BUN_CONFIG_REGISTRY|OPENCODE_SERVER_(PASSWORD|USERNAME))$/;
/** A package registry a canary names must be on loopback (a stand-in that refuses or answers locally). */
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
const KNOWN_NAMES = new Set<string>([
	"PATH",
	...SANDBOX_DIR_VARS,
	...OPTIONAL_PATH_VARS,
	...REQUIRED_FLAGS,
]);

export function assertOpenCodeSandbox(
	env: Record<string, string | undefined>,
	scratchRoot: string,
	cwd: string,
	realHome: string = REAL_HOME,
): void {
	const forbidden = forbiddenPaths(realHome);
	const check = (name: string, value: string | undefined) =>
		assertThrowawayHome({
			name,
			value,
			scratchRoot,
			forbidden,
			forbiddenLabel: "the real home or one of its agent directories",
		});
	for (const name of SANDBOX_DIR_VARS) check(name, env[name]);
	for (const name of OPTIONAL_PATH_VARS) {
		if (env[name] !== undefined) check(name, env[name]);
	}
	check("cwd", cwd);
	for (const name of REQUIRED_FLAGS) {
		if (env[name] !== "1") throw new Error(`${name}=1 is required`);
	}
	if (env.PATH !== SANDBOX_PATH) throw new Error(`PATH must be exactly ${SANDBOX_PATH}`);
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (!KNOWN_NAMES.has(name) && !EXTRA_NAME.test(name)) {
			throw new Error(`${name} is not an allowed variable in a canary's environment`);
		}
		if (/_CONFIG_REGISTRY$/.test(name) && !LOOPBACK_URL.test(value)) {
			throw new Error(`${name} must be a loopback URL`);
		}
		if (name !== "PATH" && isAbsolute(value) && !inside(scratchRoot, value)) {
			throw new Error(`${name} is a path outside the scratch directory`);
		}
	}
}

/** The exact environment a child gets, built from nothing (no copy of ours). */
export function buildOpenCodeEnv(
	paths: Record<(typeof SANDBOX_DIR_VARS)[number], string>,
	extras: { configDir?: string; db?: string; extra?: Record<string, string> } = {},
): Record<string, string> {
	const env: Record<string, string> = { PATH: SANDBOX_PATH, ...paths };
	if (extras.configDir) env.OPENCODE_CONFIG_DIR = extras.configDir;
	if (extras.db) env.OPENCODE_DB = extras.db;
	env.OPENCODE_DISABLE_AUTOUPDATE = "1";
	env.OPENCODE_DISABLE_MODELS_FETCH = "1";
	for (const [name, value] of Object.entries(extras.extra ?? {})) {
		if (!EXTRA_NAME.test(name))
			throw new Error(`${name} may not be added to a canary's environment`);
		env[name] = value;
	}
	return env;
}

const ALLOWED_SERVICE = ["start", "stop", "status"] as const;
const ALLOWED_FIRST = ["run", "serve", "--version", "service"] as const;
const REFUSED_ANYWHERE = ["upgrade", "plugin", "plugins", "auth", "uninstall", "--mdns", "--cors"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Throws unless `args` is something a canary may run. A path-like argument must sit inside scratch. */
export function assertAllowedOpenCodeArgs(args: readonly string[], scratchRoot: string): void {
	const [first, second] = args;
	if (first === undefined || !(ALLOWED_FIRST as readonly string[]).includes(first)) {
		throw new Error(`opencode ${args.join(" ") || "(no arguments)"} isn't allowed in a canary`);
	}
	if (first === "--version" && args.length !== 1) throw new Error("--version takes no arguments");
	if (first === "service") {
		if (!second || !(ALLOWED_SERVICE as readonly string[]).includes(second)) {
			throw new Error("only `service start`, `service stop` and `service status` run in a canary");
		}
	}
	for (const [index, arg] of args.entries()) {
		if (REFUSED_ANYWHERE.includes(arg)) throw new Error(`${arg} isn't allowed in a canary`);
		if (arg === "--hostname" || arg === "--host") {
			const value = args[index + 1];
			if (!value || !LOOPBACK.has(value)) throw new Error("a canary binds loopback only");
		}
		if (isAbsolute(arg) && !inside(scratchRoot, arg)) {
			throw new Error(`${arg} is a path outside the scratch directory`);
		}
	}
}

export interface SourceFile {
	path: string;
	text: string;
}
export interface Finding {
	rule: "opencode-spawn" | "kill-by-name" | "process-search" | "refused-subcommand";
	path: string;
	detail: string;
}

/** What each rule looks for, applied to one file's text. */
export function scanText(path: string, raw: string): Finding[] {
	if (path === RULES_FILE) return [];
	const text = stripComments(raw);
	const findings: Finding[] = [];
	const add = (rule: Finding["rule"], detail: string) => findings.push({ rule, path, detail });

	if (!OPENCODE_SPAWN_ALLOWED_FILES.includes(path)) {
		const spawn =
			/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*[^)]*["'`][^"'`]*\bopencode(?:\.exe)?["'`]|Bun\.spawn(?:Sync)?\(\s*\[[^\]]*["'`][^"'`]*\bopencode["'`]/;
		const m = spawn.exec(text);
		if (m) add("opencode-spawn", m[0]);
	}
	const byName =
		/\bpkill\b|\bkillall\b|xargs\s+kill|kill\s+(?:-\w+\s+)?\$\(\s*pgrep|kill\s+(?:-\w+\s+)?`pgrep/;
	const nameMatch = byName.exec(text);
	if (nameMatch) add("kill-by-name", nameMatch[0]);
	if (path !== PROCESS_SEARCH_FILE) {
		const search =
			/["'`]pgrep["'`]\s*,\s*\[[^\]]*["'`]-x["'`]|["'`]pgrep["'`]\s*,\s*\[[^\]]*["'`]-f["'`][^\]]*\][\s\S]{0,200}process\.kill/;
		const m = search.exec(text);
		if (m) add("process-search", m[0]);
	}
	const refused =
		/["'`](upgrade|uninstall)["'`]\s*[,\]]\s*[^\n]{0,60}\bopencode\b|\bopencode\s+(?:upgrade|uninstall|plugin|auth)\b/;
	const refusedMatch = refused.exec(text);
	if (refusedMatch) add("refused-subcommand", refusedMatch[0]);
	return findings;
}

export function scanCanarySource(files: SourceFile[]): Finding[] {
	return files.flatMap((file) => scanText(file.path, file.text));
}
