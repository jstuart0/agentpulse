import { describe, expect, test } from "bun:test";
import {
	MAX_ENV_VALUE_BYTES,
	deniedLaunchEnvNames,
	isDeniedLaunchEnvName,
	isValidEnvName,
	launchEnvErrors,
} from "./launch-env-policy.js";

describe("launch env policy", () => {
	test.each([
		"CLAUDE_CONFIG_DIR",
		"CLAUDE_CODE_MANAGED_SETTINGS_PATH",
		"CLAUDE_CODE_USE_BEDROCK",
		"ANTHROPIC_CONFIG_DIR",
		"ANTHROPIC_BASE_URL",
		"CODEX_HOME",
		"OPENAI_BASE_URL",
		"HOME",
		"PATH",
		"NODE_OPTIONS",
		"BUN_OPTIONS",
		"LD_PRELOAD",
		"DYLD_INSERT_LIBRARIES",
		"DYLD_LIBRARY_PATH",
		"PYTHONPATH",
		"GIT_CONFIG_GLOBAL",
		"home",
		"claude_config_dir",
	])("%s is refused", (name) => {
		expect(isDeniedLaunchEnvName(name)).toBe(true);
	});

	test.each([
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_MODEL",
		"OPENAI_API_KEY",
		"MY_TOKEN",
		"FOO",
		"HOMEBREW_PREFIX",
		"PATHEXT_X",
	])("%s is allowed", (name) => {
		expect(isDeniedLaunchEnvName(name)).toBe(false);
	});

	test("deniedLaunchEnvNames lists exactly the refused names; errors name them", () => {
		const env = { FOO: "1", HOME: "/x", CODEX_HOME: "/y", ANTHROPIC_API_KEY: "k" };
		expect(deniedLaunchEnvNames(env)).toEqual(["HOME", "CODEX_HOME"]);
		expect(launchEnvErrors(env)[0]).toContain("HOME, CODEX_HOME");
		expect(launchEnvErrors({ FOO: "1" })).toEqual([]);
		expect(launchEnvErrors(null)).toEqual([]);
	});
});

describe("env names must be plain names", () => {
	test.each([
		"A=b",
		"NODE_OPTIONS=--import x//",
		"NODE_OPTIONS=",
		"X Y",
		"1ABC",
		"",
		"A-B",
		"A\0B",
		"A\nB",
		"é",
	])("%j is refused as malformed", (name) => {
		expect(isValidEnvName(name)).toBe(false);
		const errors = launchEnvErrors({ [name]: "" });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("letters, digits and underscores");
	});

	test("a malformed name can't slip through as a different, allowed-looking name", () => {
		// The child splits at the first '=': this is NODE_OPTIONS with a value.
		expect(launchEnvErrors({ "NODE_OPTIONS=--import x//": "" })).not.toEqual([]);
		expect(deniedLaunchEnvNames({ "FOO=bar": "" })).toEqual([]);
		expect(launchEnvErrors({ "FOO=bar": "" })).not.toEqual([]);
	});

	test.each(["FOO", "_x", "a1", "MY_TOKEN"])("%s is a plain name", (name) => {
		expect(isValidEnvName(name)).toBe(true);
	});
});

describe("the wider denylist", () => {
	test.each([
		"AGENTPULSE_SKIP",
		"AGENTPULSE_API_KEY",
		"AGENTPULSE_URL",
		"ZDOTDIR",
		"PROMPT_COMMAND",
		"SHELLOPTS",
		"BASHOPTS",
		"BASH_ENV",
		"ENV",
		"IFS",
		"GIT_SSH_COMMAND",
		"GIT_DIR",
		"GIT_ASKPASS",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_TLS_REJECT_UNAUTHORIZED",
		"NODE_EXTRA_CA_CERTS",
		"CURL_CA_BUNDLE",
		"REQUESTS_CA_BUNDLE",
		"NPM_CONFIG_REGISTRY",
		"npm_config_registry",
		"PERL5OPT",
		"RUBYOPT",
		"JAVA_TOOL_OPTIONS",
		"_JAVA_OPTIONS",
		"TMPDIR",
		"EDITOR",
		"VISUAL",
		"PAGER",
		"XDG_CONFIG_HOME",
		"XDG_RUNTIME_DIR",
		"SSH_AUTH_SOCK",
		"SSH_ASKPASS",
	])("%s is refused", (name) => {
		expect(isDeniedLaunchEnvName(name)).toBe(true);
	});

	test.each(["AGENTPULSE", "MYGIT_X", "SSHX", "MY_AGENTPULSE_X"])(
		"%s is not caught by a prefix it only resembles",
		(name) => {
			expect(isDeniedLaunchEnvName(name)).toBe(false);
		},
	);
});

describe("values and the last denylist additions", () => {
	test.each([
		"OPENSSL_CONF",
		"GCONV_PATH",
		"GLIBC_TUNABLES",
		"LOCPATH",
		"HOSTALIASES",
		"UV_THREADPOOL_SIZE",
		"PIP_INDEX_URL",
		"uv_x",
	])("%s is refused", (name) => {
		expect(isDeniedLaunchEnvName(name)).toBe(true);
	});

	test("a NUL in a value is refused", () => {
		const errors = launchEnvErrors({ FOO: "a\0b" });
		expect(errors.join(" ")).toContain("NUL");
		expect(errors.join(" ")).toContain("FOO");
	});

	test("a value over 32 KB is refused, exactly 32 KB is fine, and the limit counts bytes", () => {
		expect(MAX_ENV_VALUE_BYTES).toBe(32768);
		expect(launchEnvErrors({ FOO: "x".repeat(32768) })).toEqual([]);
		expect(launchEnvErrors({ FOO: "x".repeat(32769) }).join(" ")).toContain("32 KB");
		expect(launchEnvErrors({ FOO: "é".repeat(16385) }).join(" ")).toContain("32 KB");
		expect(launchEnvErrors({ FOO: "é".repeat(16384) })).toEqual([]);
	});

	test("value problems and name problems are both reported", () => {
		const errors = launchEnvErrors({ "BAD=NAME": "a\0", HOME: "x" });
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});
});

/** What the strip adds after the person's own environment: the hook skip, and no Claude-started turns (phase 7). */
const OURS = { AGENTPULSE_SKIP: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };

describe("forkChildEnv (AGEN-117 T18)", () => {
	test("background tasks are off in the child whatever the person's environment says (a Claude-started turn ends the fork)", async () => {
		const { forkChildEnv } = await import("./launch-env-policy.js");
		for (const own of ["0", "", "false", "1"]) {
			expect(
				forkChildEnv({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: own })
					.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
			).toBe("1");
		}
		expect(forkChildEnv({}).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
	});

	test("AGENTPULSE_SKIP is ours: the person's own value, in any case or spelling, never reaches the child", async () => {
		const { forkChildEnv } = await import("./launch-env-policy.js");
		for (const own of ["0", "", "false", "no", "1"]) {
			expect(forkChildEnv({ AGENTPULSE_SKIP: own }).AGENTPULSE_SKIP).toBe("1");
			expect(forkChildEnv({ agentpulse_skip: own })).toEqual({ ...OURS });
		}
	});

	test("strips exactly the session markers and AgentPulse's own variables, by set equality", async () => {
		const { FORK_ENV_STRIP_EXACT, FORK_ENV_STRIP_PREFIXES, forkChildEnv, isForkStrippedEnvName } =
			await import("./launch-env-policy.js");
		expect([...FORK_ENV_STRIP_EXACT].sort()).toEqual(
			[
				"AI_AGENT",
				"CLAUDECODE",
				"CLAUDE_CODE_CHILD_SESSION",
				"CLAUDE_CODE_ENTRYPOINT",
				"CLAUDE_CODE_EXECPATH",
				"CLAUDE_CODE_MESSAGING_SOCKET",
				"CLAUDE_CODE_MESSAGING_TOKEN",
				"CLAUDE_CODE_SESSION_ATTENDED",
				"CLAUDE_CODE_SESSION_ID",
				"CLAUDE_EFFORT",
				"CLAUDE_PID",
			].sort(),
		);
		// Floor twelve, counted from the names written out above and not from the list under test: eleven exact
		// names and the AgentPulse prefix, with the named member present.
		expect(FORK_ENV_STRIP_EXACT).toHaveLength(11);
		expect([...FORK_ENV_STRIP_PREFIXES]).toEqual(["AGENTPULSE_"]);
		expect(FORK_ENV_STRIP_EXACT).toContain("CLAUDE_CODE_MESSAGING_SOCKET");
		const parent: Record<string, string> = Object.fromEntries(
			[...FORK_ENV_STRIP_EXACT, "AGENTPULSE_KEY", "agentpulse_lower", "AgentPulse_Mixed"].map(
				(n) => [n, "x"],
			),
		);
		// What is left is what the person had, plus ours: the skip flag, set after the strip.
		expect(forkChildEnv({ ...parent, PATH: "/bin", HOME: "/h" })).toEqual({
			PATH: "/bin",
			HOME: "/h",
			...OURS,
		});
		expect(isForkStrippedEnvName("agentpulse_anything")).toBe(true);
	});

	test("the login variables and the rest of CLAUDE_CODE_*, ANTHROPIC_* and AWS_* survive", async () => {
		const { forkChildEnv } = await import("./launch-env-policy.js");
		const login = {
			CLAUDE_CODE_OAUTH_TOKEN: "t",
			CLAUDE_CODE_USE_BEDROCK: "1",
			CLAUDE_CODE_USE_VERTEX: "1",
			ANTHROPIC_API_KEY: "k",
			ANTHROPIC_BASE_URL: "u",
			AWS_PROFILE: "p",
			AWS_REGION: "r",
			CLAUDE_CONFIG_DIR: "/c",
			CLAUDE_CODE_SOMETHING_ELSE: "1",
		};
		expect(forkChildEnv(login)).toEqual({ ...login, ...OURS });
	});

	test("drops undefined values", async () => {
		const { forkChildEnv } = await import("./launch-env-policy.js");
		expect(forkChildEnv({ A: "1", B: undefined })).toEqual({ A: "1", ...OURS });
	});
});
