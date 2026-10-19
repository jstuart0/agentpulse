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
