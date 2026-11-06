/**
 * AGEN-117 P3 item 3 (T3 stage one): the binary, platform and transport gate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BLOCKED_CLAUDE_VERSIONS,
	CLAUDE_VERSION_CEILING,
	CLAUDE_VERSION_FLOOR,
	type ClaudeBinary,
	claudeProtocolVerdict,
	readClaudeVersion,
} from "./claude-protocol.js";
import { compareVersions, parseVersion, versionInRange } from "./version-range.js";

const bin = (version: string | null): ClaudeBinary => ({
	path: "/bin/claude",
	version,
	size: 1,
	mtimeMs: 1,
});
const HTTPS = "https://agentpulse.example";
const verdict = (
	version: string | null,
	extra: Parameters<typeof claudeProtocolVerdict>[2] = {},
	serverUrl = HTTPS,
) => claudeProtocolVerdict(bin(version), serverUrl, { platform: "darwin", ...extra });

describe("claudeProtocolVerdict", () => {
	test("the measured version is supported", () => {
		expect(verdict("2.1.318")).toEqual({ verdict: "supported", reason: "ok" });
	});

	test("a later patch and a later minor inside the range are supported", () => {
		expect(verdict("2.1.400").verdict).toBe("supported");
		expect(verdict("2.1.999").verdict).toBe("supported");
	});

	test("below the floor and at or past the ceiling are not", () => {
		expect(verdict("2.1.317")).toEqual({ verdict: "unsupported", reason: "below_floor" });
		expect(verdict("2.0.999")).toEqual({ verdict: "unsupported", reason: "below_floor" });
		expect(verdict("2.2.0")).toEqual({ verdict: "unsupported", reason: "above_range" });
		expect(verdict("3.0.0")).toEqual({ verdict: "unsupported", reason: "above_range" });
	});

	test("an unreadable version is never supported", () => {
		expect(verdict(null)).toEqual({ verdict: "unsupported", reason: "version_unknown" });
		expect(verdict("banana")).toEqual({ verdict: "unsupported", reason: "version_unknown" });
	});

	test("a blocked version is refused inside the range", () => {
		expect(verdict("2.1.320", { blockedVersions: ["2.1.320"] })).toEqual({
			verdict: "unsupported",
			reason: "blocked_version",
		});
		expect(BLOCKED_CLAUDE_VERSIONS).toEqual([]);
	});

	test("any platform but macOS is unsupported_platform, before the version is looked at", () => {
		for (const platform of ["linux", "win32"] as const) {
			expect(verdict("2.1.318", { platform })).toEqual({
				verdict: "unsupported",
				reason: "unsupported_platform",
			});
		}
	});

	test("plain http to another machine is insecure_transport; loopback http and https pass", () => {
		expect(verdict("2.1.318", {}, "http://agentpulse.example").verdict).toBe("insecure_transport");
		expect(verdict("2.1.318", {}, "http://127.0.0.1:3000").verdict).toBe("supported");
		expect(verdict("2.1.318", {}, "").verdict).toBe("insecure_transport");
	});
});

describe("version helpers", () => {
	test("parse, compare and range agree on the edges", () => {
		expect(parseVersion("2.1.318 (Claude Code)")).toEqual([2, 1, 318]);
		expect(parseVersion("v2.1.318")).toBeNull();
		expect(compareVersions([2, 1, 318], [2, 1, 318])).toBe(0);
		expect(compareVersions([2, 1, 9], [2, 1, 318])).toBeLessThan(0);
		expect(versionInRange([2, 1, 318], CLAUDE_VERSION_FLOOR, CLAUDE_VERSION_CEILING)).toBe(true);
		expect(versionInRange([2, 2, 0], CLAUDE_VERSION_FLOOR, CLAUDE_VERSION_CEILING)).toBe(false);
	});
});

describe("readClaudeVersion", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function fakeClaude(script: string): string {
		const dir = mkdtempSync(join(tmpdir(), "fake-claude-version-"));
		dirs.push(dir);
		const path = join(dir, "claude");
		writeFileSync(path, `#!/bin/sh\n${script}\n`);
		chmodSync(path, 0o755);
		return path;
	}

	test("reads the first token of --version", async () => {
		expect(await readClaudeVersion(fakeClaude('echo "2.1.318 (Claude Code)"'))).toBe("2.1.318");
	});

	test("runs under a HOME that is not the caller's, with a bare environment", async () => {
		const realHome = process.env.HOME ?? "";
		const path = fakeClaude(
			`[ "$HOME" != "${realHome}" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo "2.1.318" || echo "9.9.9 leaked"`,
		);
		process.env.ANTHROPIC_API_KEY = "test-value-not-a-key";
		try {
			expect(await readClaudeVersion(path)).toBe("2.1.318");
		} finally {
			// biome-ignore lint/performance/noDelete: restoring the environment
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	test("a failing, silent or garbled binary gives null", async () => {
		expect(await readClaudeVersion(fakeClaude("exit 3"))).toBeNull();
		expect(await readClaudeVersion(fakeClaude("echo garbage"))).toBeNull();
		expect(await readClaudeVersion("/nonexistent/claude")).toBeNull();
	});

	test("a binary that never answers is cut off", async () => {
		const started = Date.now();
		expect(await readClaudeVersion(fakeClaude("exec sleep 30"), { timeoutMs: 150 })).toBeNull();
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
