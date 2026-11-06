/**
 * Environment variables a launch may not set. The agent CLIs take their configuration,
 * settings files, plugin and hook locations and credentials' endpoints from the
 * environment, so a launch that could set them could undo the permission flags the
 * supervisor applies (point the agent at another config dir, a managed-settings file,
 * another HOME, or inject code through the runtime). The server refuses such a template
 * and the supervisor refuses such a launch or resume; both use this one list.
 *
 * Names checked against the installed CLIs (2026-10-18): the strings in the Claude Code
 * 2.1.303 binary include CLAUDE_CONFIG_DIR, ANTHROPIC_CONFIG_DIR,
 * CLAUDE_CODE_MANAGED_SETTINGS_PATH, CLAUDE_CODE_REMOTE_SETTINGS_PATH,
 * CLAUDE_CODE_PLUGIN_DIRS, CLAUDE_BG_SESSION_PERMISSION_RULES,
 * CLAUDE_CODE_AUTO_MODE_EXTERNAL_PERMISSIONS and some 1000 other CLAUDE_*, CLAUDE_CODE_*
 * and ANTHROPIC_* names, too many to vet one by one, so every name with those prefixes
 * is refused except a short allow-list of credentials and model choice. Codex reads
 * CODEX_HOME (config.toml, auth, rules) and OPENAI_BASE_URL; every CODEX_* and OPENAI_*
 * name is refused except the API key and model.
 */

const DENIED_EXACT: ReadonlySet<string> = new Set([
	"HOME",
	"USERPROFILE",
	"PATH",
	"SHELL",
	"ENV",
	"BASH_ENV",
	"ZDOTDIR",
	"PROMPT_COMMAND",
	"SHELLOPTS",
	"BASHOPTS",
	"IFS",
	"TMPDIR",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"BUN_OPTIONS",
	"PYTHONPATH",
	"PYTHONHOME",
	"PYTHONSTARTUP",
	"PERL5OPT",
	"RUBYOPT",
	"JAVA_TOOL_OPTIONS",
	"OPENSSL_CONF",
	"GCONV_PATH",
	"GLIBC_TUNABLES",
	"LOCPATH",
	"HOSTALIASES",
	"_JAVA_OPTIONS",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"CURL_CA_BUNDLE",
	"REQUESTS_CA_BUNDLE",
	"SSH_ASKPASS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
]);

const DENIED_PREFIXES = [
	"DYLD_",
	"LD_",
	"BUN_CONFIG_",
	"GIT_",
	"XDG_",
	"SSH_",
	"NPM_CONFIG_",
	"UV_",
	"PIP_",
	"AGENTPULSE_",
	"CLAUDE_",
	"ANTHROPIC_",
	"CODEX_",
	"OPENAI_",
];

const ALLOWED_CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"OPENAI_API_KEY",
	"OPENAI_MODEL",
]);

/** A name the operating system's environment can carry without ambiguity: no `=`, no spaces, no NUL. */
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvName(name: string): boolean {
	return VALID_ENV_NAME.test(name);
}

export function isDeniedLaunchEnvName(name: string): boolean {
	const upper = name.toUpperCase();
	if (ALLOWED_CREDENTIAL_NAMES.has(upper)) return false;
	return DENIED_EXACT.has(upper) || DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** The names in `env` a launch may not set. Empty when the env is fine. */
export function deniedLaunchEnvNames(env: Record<string, unknown> | null | undefined): string[] {
	return Object.keys(env ?? {}).filter(isDeniedLaunchEnvName);
}

/** The longest value one variable may carry (UTF-8 bytes). */
export const MAX_ENV_VALUE_BYTES = 32 * 1024;

function valueErrors(env: Record<string, unknown>): string[] {
	const errors: string[] = [];
	const withNul = Object.keys(env).filter(
		(name) => typeof env[name] === "string" && (env[name] as string).includes("\0"),
	);
	if (withNul.length > 0) {
		errors.push(
			`Environment variable values can't contain NUL characters (${withNul.join(", ")}).`,
		);
	}
	const tooLong = Object.keys(env).filter(
		(name) =>
			typeof env[name] === "string" && Buffer.byteLength(env[name] as string) > MAX_ENV_VALUE_BYTES,
	);
	if (tooLong.length > 0) {
		errors.push(
			`Environment variable values may be at most ${MAX_ENV_VALUE_BYTES / 1024} KB (${tooLong.join(", ")}).`,
		);
	}
	return errors;
}

export function launchEnvErrors(env: Record<string, unknown> | null | undefined): string[] {
	const valueProblems = valueErrors(env ?? {});
	if (valueProblems.length > 0) return [...valueProblems, ...nameErrors(env)];
	return nameErrors(env);
}

function nameErrors(env: Record<string, unknown> | null | undefined): string[] {
	// A name containing `=` would be split by the child at the first `=`, so
	// `NODE_OPTIONS=--import x//` with an empty value is `NODE_OPTIONS` with a value: it must
	// never reach a name check as if it were a different name.
	const malformed = Object.keys(env ?? {}).filter((name) => !isValidEnvName(name));
	if (malformed.length > 0) {
		return [
			`Environment variable names may only contain letters, digits and underscores, and can't start with a digit (${malformed.map((name) => JSON.stringify(name.slice(0, 40))).join(", ")}).`,
		];
	}
	const denied = deniedLaunchEnvNames(env);
	return denied.length === 0
		? []
		: [
				`Environment variable${denied.length > 1 ? "s" : ""} ${denied.join(", ")} can't be set on a launch: ${denied.length > 1 ? "they change" : "it changes"} where the agent reads its settings or what it runs, which could undo the launch's permissions.`,
			];
}

// This is a denylist over an open namespace, so it is defence in depth, not the boundary: the
// boundary is the trusted operator who may launch on a host at all.

// ---- the environment a takeover fork's Claude gets (AGEN-117 T18) ----

/**
 * Variables a running Claude Code puts in its own children's environment to say "you are inside a Claude
 * session". A fork started from a supervisor that was itself started from inside one would inherit them and
 * attach to the parent (the messaging socket and token especially). Exact names, no glob over
 * `CLAUDE_CODE_*`: `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
 * `ANTHROPIC_*`, `AWS_*` and the rest are the person's login and must survive. A marker added by a later
 * Claude Code is the residual.
 */
export const FORK_ENV_STRIP_EXACT: readonly string[] = [
	"CLAUDECODE",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_MESSAGING_TOKEN",
	"CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"AI_AGENT",
];

/** Matched case-insensitively. A fork reports nothing through AgentPulse's own variables. */
export const FORK_ENV_STRIP_PREFIXES: readonly string[] = ["AGENTPULSE_"];

export function isForkStrippedEnvName(name: string): boolean {
	const upper = name.toUpperCase();
	return (
		FORK_ENV_STRIP_EXACT.includes(upper) ||
		FORK_ENV_STRIP_PREFIXES.some((prefix) => upper.startsWith(prefix))
	);
}

/**
 * The environment of every Claude process a takeover starts (the login probes and the fork itself), from
 * one function, so a probe can't see a login the fork won't. The supervisor's own environment minus the
 * session markers; a credential the person put there passes through untouched and is never read.
 */
export function forkChildEnv(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || isForkStrippedEnvName(name)) continue;
		out[name] = value;
	}
	// Ours, set after the strip and never from the person's environment: the installed hooks (HTTP, command and
	// the relay) all honour it, so a hook a probe or a fork runs (a user `SessionStart` command hook fires once
	// per `ask` probe, measured) reaches the server as a skip (answered 200, nothing stored) and cannot create a
	// session row for a process that has no row of its own yet.
	out.AGENTPULSE_SKIP = "1";
	return out;
}
