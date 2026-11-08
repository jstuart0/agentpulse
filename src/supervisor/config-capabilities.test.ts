/**
 * AGEN-91 (Pattern 3): a supervisor feature has to be in both feature lists, the default one and the one
 * built from what the host really has. `codex_follow_up_prompts` says "this process can start a turn on a
 * managed Codex thread"; the server withholds Codex prompts from a host that lacks it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_FORK_SUBAGENTS } from "../shared/claude-fork-subagents.js";
import { CLAUDE_STOP, CLAUDE_TURN_CONTROL, CODEX_FOLLOW_UP_PROMPTS } from "../shared/constants.js";
import { RESUMES_SESSIONS } from "../shared/session-resume.js";
import { buildDefaultConfig, withExecutableCapabilities } from "./config.js";
import { installFakeCodex } from "./providers/__fixtures__/fake-codex.js";

let scratch: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "ap-config-capabilities-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("codex_follow_up_prompts", () => {
	test("is the literal the server reads", () => {
		expect(CODEX_FOLLOW_UP_PROMPTS).toBe("codex_follow_up_prompts");
	});

	test("is in the default list, which has grown by it", () => {
		const features = buildDefaultConfig().capabilities.features;
		expect(features).toContain("codex_follow_up_prompts");
		// Ten entries before this feature: an emptied list can't satisfy this.
		expect(features.length).toBeGreaterThanOrEqual(11);
	});

	test("is in the detected list only when Codex resolved", async () => {
		const withCodex = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: installFakeCodex(scratch),
		});
		const without = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: join(scratch, "no-such-codex"),
		});
		expect(withCodex.capabilities.features).toContain("codex_follow_up_prompts");
		expect(withCodex.capabilities.features).toContain("managed_codex");
		expect(without.capabilities.features).not.toContain("codex_follow_up_prompts");
		expect(without.capabilities.features).not.toContain("managed_codex");
		// Exactly the three Codex entries differ: managed_codex, codex_follow_up_prompts and resumes_sessions.
		expect(withCodex.capabilities.features.length - without.capabilities.features.length).toBe(3);
		expect(without.capabilities.features.length).toBeGreaterThanOrEqual(5);
	});
});

describe("resumes_sessions (AGEN-115, Pattern 8)", () => {
	test("is the literal the server reads", () => {
		expect(RESUMES_SESSIONS).toBe("resumes_sessions");
	});

	test("is in the default list", () => {
		expect(buildDefaultConfig().capabilities.features).toContain("resumes_sessions");
	});

	test("is in the detected list only when Codex resolved: a host without Codex can't resume anything", async () => {
		const withCodex = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: installFakeCodex(scratch),
		});
		const without = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: join(scratch, "no-such-codex"),
		});
		expect(withCodex.capabilities.features).toContain("resumes_sessions");
		expect(without.capabilities.features).not.toContain("resumes_sessions");
	});

	test("both lists carry it, so neither builder can drop it unnoticed (a source check on config.ts)", () => {
		const text = require("node:fs").readFileSync(
			new URL("./config.ts", import.meta.url),
			"utf8",
		) as string;
		expect(text.match(/RESUMES_SESSIONS/g)?.length).toBeGreaterThanOrEqual(3);
	});
});

describe("claude_stop (AGEN-110)", () => {
	test("is the literal the server reads", () => {
		expect(CLAUDE_STOP).toBe("claude_stop");
	});

	test("is in the default list", () => {
		expect(buildDefaultConfig().capabilities.features).toContain("claude_stop");
	});

	test("is in the detected list whether or not Codex resolved: it is about Claude", async () => {
		const withCodex = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: installFakeCodex(scratch),
		});
		const without = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: join(scratch, "no-such-codex"),
		});
		expect(withCodex.capabilities.features).toContain("claude_stop");
		expect(without.capabilities.features).toContain("claude_stop");
	});

	test("both lists carry it (a source check on config.ts)", () => {
		const text = require("node:fs").readFileSync(
			new URL("./config.ts", import.meta.url),
			"utf8",
		) as string;
		expect(text.match(/\bCLAUDE_STOP\b/g)?.length).toBeGreaterThanOrEqual(3);
	});
});

describe("claude_turn_control (AGEN-117)", () => {
	test("is the literal the server reads and advertises", () => {
		expect(CLAUDE_TURN_CONTROL).toBe("claude_turn_control");
	});

	test("is in the default list", () => {
		expect(buildDefaultConfig().capabilities.features).toContain("claude_turn_control");
	});

	test("is in the detected list whether or not Codex resolved: it is about Claude", async () => {
		const withCodex = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: installFakeCodex(scratch),
		});
		const without = await withExecutableCapabilities({
			...buildDefaultConfig(),
			codexCommand: join(scratch, "no-such-codex"),
		});
		expect(withCodex.capabilities.features).toContain("claude_turn_control");
		expect(without.capabilities.features).toContain("claude_turn_control");
	});

	test("both lists carry it (a source check on config.ts)", () => {
		const text = require("node:fs").readFileSync(
			new URL("./config.ts", import.meta.url),
			"utf8",
		) as string;
		expect(text.match(/\bCLAUDE_TURN_CONTROL\b/g)?.length).toBeGreaterThanOrEqual(3);
	});
});

describe("claude_fork_subagents (AGEN-120)", () => {
	const claudeAt = (version: string) => {
		const path = join(scratch, `claude-${version}`);
		writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
		chmodSync(path, 0o755);
		return path;
	};
	const featuresFor = async (claudeCommand: string) =>
		(await withExecutableCapabilities({ ...buildDefaultConfig(), claudeCommand })).capabilities
			.features;

	test("is the literal the server and the dialog read", () => {
		expect(CLAUDE_FORK_SUBAGENTS).toBe("claude_fork_subagents");
	});

	test("is not in the default list: it says what this host's Claude Code was measured with", () => {
		expect(buildDefaultConfig().capabilities.features).not.toContain(CLAUDE_FORK_SUBAGENTS);
	});

	test("is advertised for a measured Claude Code on macOS and for no other version or when claude is missing", async () => {
		const measured = await featuresFor(claudeAt("2.1.319"));
		const newer = await featuresFor(claudeAt("2.1.320"));
		const missing = await featuresFor(join(scratch, "no-such-claude"));
		if (process.platform === "darwin") {
			expect(measured).toContain(CLAUDE_FORK_SUBAGENTS);
			expect(measured).toContain("claude_takeover");
		} else {
			expect(measured).not.toContain(CLAUDE_FORK_SUBAGENTS);
		}
		// Positive control above: the feature exists for the measured one; the others lack it.
		expect(newer).not.toContain(CLAUDE_FORK_SUBAGENTS);
		expect(missing).not.toContain(CLAUDE_FORK_SUBAGENTS);
	});
});
