import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupervisorConfig } from "./config.js";
import { captureExecutableVersion, withExecutableCapabilities } from "./config.js";

let scratchDir: string;

beforeEach(async () => {
	scratchDir = await mkdtemp(join(tmpdir(), "ap-exec-version-"));
});

afterEach(async () => {
	if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
});

async function writeExecutableScript(name: string, script: string): Promise<string> {
	const path = join(scratchDir, name);
	await writeFile(path, script, { mode: 0o755 });
	return path;
}

async function writeNonExecutableFile(name: string, contents: string): Promise<string> {
	const path = join(scratchDir, name);
	await writeFile(path, contents, { mode: 0o644 });
	return path;
}

const CLAUDE_VERSION_SCRIPT = '#!/bin/sh\necho "2.1.212 (Claude Code)"\n';
const CODEX_VERSION_SCRIPT = '#!/bin/sh\necho "codex-cli 0.144.5"\n';

function makeConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
	return {
		serverUrl: "http://localhost:3000",
		hostName: "test-host",
		platform: "darwin",
		arch: "arm64",
		version: "0.1.0",
		trustedRoots: [],
		capabilities: {
			version: 1,
			agentTypes: ["claude_code", "codex_cli"],
			launchModes: ["headless"],
			os: "macos",
			terminalSupport: [],
			features: [],
		},
		...overrides,
	};
}

describe("captureExecutableVersion", () => {
	test("parses the semver token out of real Claude-shaped version output", async () => {
		const path = await writeExecutableScript("claude-stub.sh", CLAUDE_VERSION_SCRIPT);
		expect(await captureExecutableVersion(path)).toBe("2.1.212");
	});

	test("parses the semver token out of real Codex-shaped version output", async () => {
		const path = await writeExecutableScript("codex-stub.sh", CODEX_VERSION_SCRIPT);
		expect(await captureExecutableVersion(path)).toBe("0.144.5");
	});

	test("resolves null when the executable exits non-zero", async () => {
		const path = await writeExecutableScript("fails.sh", "#!/bin/sh\nexit 1\n");
		expect(await captureExecutableVersion(path)).toBeNull();
	});

	test("resolves null when the executable prints nothing", async () => {
		const path = await writeExecutableScript("silent.sh", "#!/bin/sh\nexit 0\n");
		expect(await captureExecutableVersion(path)).toBeNull();
	});

	test("resolves null on garbage output with no recognizable version token", async () => {
		const path = await writeExecutableScript(
			"garbage.sh",
			'#!/bin/sh\necho "no version info here"\n',
		);
		expect(await captureExecutableVersion(path)).toBeNull();
	});

	test("does not false-positive-match a stray single digit as a version", async () => {
		const path = await writeExecutableScript(
			"stray-digit.sh",
			'#!/bin/sh\necho "build 4 complete"\n',
		);
		expect(await captureExecutableVersion(path)).toBeNull();
	});

	test("parses only the first line — version on line 1 with trailing banner text still resolves", async () => {
		const path = await writeExecutableScript(
			"version-then-banner.sh",
			'#!/bin/sh\nprintf "2.1.212 (Claude Code)\\nSome extra banner line\\nMore text\\n"\n',
		);
		expect(await captureExecutableVersion(path)).toBe("2.1.212");
	});

	test("parses only the first line — banner before the version line resolves null, not a scan-ahead match", async () => {
		const path = await writeExecutableScript(
			"banner-then-version.sh",
			'#!/bin/sh\nprintf "Welcome to the CLI\\n2.1.212 (Claude Code)\\n"\n',
		);
		expect(await captureExecutableVersion(path)).toBeNull();
	});

	test("resolves null immediately when the resolved path is null (absence tolerance)", async () => {
		expect(await captureExecutableVersion(null)).toBeNull();
	});

	test("resolves null without throwing when spawning a non-executable file (EACCES)", async () => {
		const path = await writeNonExecutableFile("not-executable.sh", CLAUDE_VERSION_SCRIPT);
		await expect(captureExecutableVersion(path)).resolves.toBeNull();
	});

	test("times out on a hanging process without exceeding the timeout window", async () => {
		const path = await writeExecutableScript("hangs.sh", "#!/bin/sh\nsleep 5\n");
		const start = Date.now();
		const result = await captureExecutableVersion(path);
		const elapsed = Date.now() - start;
		expect(result).toBeNull();
		expect(elapsed).toBeLessThan(3_000);
	});
});

describe("withExecutableCapabilities", () => {
	test("captures binaryVersion for both executables and preserves the full existing shape", async () => {
		const claudePath = await writeExecutableScript("claude-stub.sh", CLAUDE_VERSION_SCRIPT);
		const codexPath = await writeExecutableScript("codex-stub.sh", CODEX_VERSION_SCRIPT);

		const result = await withExecutableCapabilities(
			makeConfig({ claudeCommand: claudePath, codexCommand: codexPath }),
		);

		expect(result.capabilities.executables?.claude).toEqual({
			available: true,
			command: claudePath,
			resolvedPath: claudePath,
			source: "config",
			binaryVersion: "2.1.212",
		});
		expect(result.capabilities.executables?.codex).toEqual({
			available: true,
			command: codexPath,
			resolvedPath: codexPath,
			source: "config",
			binaryVersion: "0.144.5",
		});
	});

	test("absence tolerance: missing executables resolve binaryVersion to null without throwing", async () => {
		const missingClaude = join(scratchDir, "does-not-exist-claude");
		const missingCodex = join(scratchDir, "does-not-exist-codex");

		const result = await withExecutableCapabilities(
			makeConfig({ claudeCommand: missingClaude, codexCommand: missingCodex }),
		);

		expect(result.capabilities.executables?.claude).toEqual({
			available: false,
			command: missingClaude,
			resolvedPath: null,
			source: "config",
			binaryVersion: null,
		});
		expect(result.capabilities.executables?.codex).toEqual({
			available: false,
			command: missingCodex,
			resolvedPath: null,
			source: "config",
			binaryVersion: null,
		});
	});

	test("a failing --version on an otherwise resolvable executable does not crash capability detection", async () => {
		const claudePath = await writeExecutableScript("claude-fails.sh", "#!/bin/sh\nexit 1\n");

		const result = await withExecutableCapabilities(makeConfig({ claudeCommand: claudePath }));

		expect(result.capabilities.executables?.claude).toEqual({
			available: true,
			command: claudePath,
			resolvedPath: claudePath,
			source: "config",
			binaryVersion: null,
		});
	});
});
