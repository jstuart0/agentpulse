/**
 * Running the commands an update needs (git, bun, bash), with an environment built from an allowlist.
 * Nothing the parent process holds that is secret reaches a child: no API key, no supervisor credential, no
 * `ANTHROPIC_API_KEY`, no forwardauth secret (rule 29). Git also ignores the person's own git config (a hook,
 * a credential helper or an fsmonitor there could run code), and never prompts.
 */
export type RunResult = { code: number; stdout: string; stderr: string };
export type RunFn = (
	cmd: string[],
	options: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<RunResult>;

/** What a child may inherit: where programs are, a home, the locale, a temp directory and the person's proxy settings. */
const INHERITED = [
	"PATH",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"NO_PROXY",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

export function baseEnv(
	parent: Record<string, string | undefined>,
	home: string,
): Record<string, string> {
	const env: Record<string, string> = { HOME: home };
	for (const name of INHERITED) {
		const value = parent[name];
		if (typeof value === "string" && value !== "") env[name] = value;
	}
	return env;
}

/** Git's protocol rules for one remote: https only for the real remote, `file` only where the caller's remote is a path. */
export function gitProtocolArgs(remote: string): string[] {
	return remote.startsWith("https://")
		? ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"]
		: ["-c", "protocol.allow=never", "-c", "protocol.file.allow=always"];
}

/** The environment and flags every git call runs with (the plan's step 8). */
export function gitEnv(
	parent: Record<string, string | undefined>,
	home: string,
): Record<string, string> {
	return {
		...baseEnv(parent, home),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

export const SAFE_GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export const defaultRun: RunFn = async (cmd, options) => {
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), options.timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
};
