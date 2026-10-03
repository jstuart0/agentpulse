/**
 * Phase 5 (D12/D13, r6): the parity guard's no-stdout rule — proves the
 * check actually discriminates (a real command passes; a tampered one with
 * an appended `; echo ok` fails), and that the guard's Codex-shape rule
 * runs clean against the current tree.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBashHookCommand } from "../src/shared/hook-command.js";
import { checkClaudeHttpHookSites, checkNoStdoutShape } from "./check-hook-event-parity.js";

describe("checkNoStdoutShape (guard self-test)", () => {
	test("a real generated command passes clean", () => {
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(checkNoStdoutShape(cmd, "test")).toEqual([]);
	});

	test("appending `; echo ok` is caught", () => {
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const tampered = `${cmd}; echo ok`;
		const violations = checkNoStdoutShape(tampered, "test");
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.some((v) => v.includes("echo"))).toBe(true);
	});

	test("the trim-set printf is the one allowed printf: a second printf is still caught", () => {
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain("printf");
		expect(checkNoStdoutShape(cmd, "test").some((v) => v.includes("printf"))).toBe(false);
		const tampered = cmd.replace(") </dev/null", "; printf ok ) </dev/null");
		expect(checkNoStdoutShape(tampered, "test").some((v) => v.includes("printf"))).toBe(true);
	});

	test("a bare `cat` (not `cat >`) is caught", () => {
		const violations = checkNoStdoutShape('cat "$t" ) </dev/null >/dev/null 2>&1 & exit 0', "test");
		expect(violations.some((v) => v.includes("bare cat"))).toBe(true);
	});

	test('`cat > "$t"` is not flagged as a bare cat', () => {
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain('cat > "$t"');
		expect(checkNoStdoutShape(cmd, "test").some((v) => v.includes("bare cat"))).toBe(false);
	});
});

describe("check-hook-event-parity.ts (the real guard, end to end)", () => {
	test("exits 0 against the current tree", async () => {
		const proc = Bun.spawn(["bun", "scripts/check-hook-event-parity.ts"], {
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
	});
});

describe("checkClaudeHttpHookSites (guard self-test)", () => {
	const ROOT = new URL("..", import.meta.url).pathname;
	const real = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

	test("the real tree: nine constructs across six sites, no problems", () => {
		const result = checkClaudeHttpHookSites(real);
		expect(result.problems).toEqual([]);
		expect(result.constructCount).toBe(9);
	});

	test("a site that drops the skip header is named", () => {
		const result = checkClaudeHttpHookSites((rel) =>
			rel === "bin/cli.ts" ? real(rel).replaceAll("X-AgentPulse-Skip", "X-Other") : real(rel),
		);
		expect(result.problems.some((p) => p.startsWith("bin/cli.ts") && p.includes("header"))).toBe(
			true,
		);
	});

	test("a site whose allowedEnvVars lacks the skip variable is named", () => {
		const result = checkClaudeHttpHookSites((rel) =>
			rel === "src/web/pages/SetupPage.tsx"
				? real(rel).replace(/allowedEnvVars: \[[^\]]*\]/, 'allowedEnvVars: ["AGENTPULSE_API_KEY"]')
				: real(rel),
		);
		expect(
			result.problems.some(
				(p) => p.startsWith("src/web/pages/SetupPage.tsx") && p.includes("allowedEnvVars"),
			),
		).toBe(true);
	});

	test("a construct that vanishes from a site shrinks the count and is reported", () => {
		const result = checkClaudeHttpHookSites((rel) =>
			rel === "scripts/setup-hooks.sh"
				? real(rel).replaceAll("HOOKS_JSON+=", "HOOKS_JSON_PART=")
				: real(rel),
		);
		expect(result.problems.some((p) => p.startsWith("scripts/setup-hooks.sh"))).toBe(true);
		expect(result.constructCount).toBeLessThan(9);
	});
});

describe("checkClaudeHttpHookSites (guard self-test): every site and every kind of site", () => {
	const ROOT = new URL("..", import.meta.url).pathname;
	const real = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");
	const SITES: { site: string; kind: string }[] = [
		{ site: "scripts/setup-hooks.sh", kind: "shell lines" },
		{ site: "scripts/setup-relay.sh", kind: "shell lines" },
		{ site: "src/server/routes/setup.ts", kind: "the /setup.sh template" },
		{ site: "scripts/install-local.ps1", kind: "PowerShell" },
		{ site: "bin/cli.ts", kind: "TypeScript objects" },
		{ site: "src/web/pages/SetupPage.tsx", kind: "TypeScript objects" },
	];

	for (const { site, kind } of SITES) {
		test(`${site} (${kind}): dropping the skip header is named`, () => {
			const result = checkClaudeHttpHookSites((rel) =>
				rel === site ? real(rel).replaceAll("X-AgentPulse-Skip", "X-Other") : real(rel),
			);
			expect(result.problems.some((p) => p.startsWith(site) && p.includes("header"))).toBe(true);
		});

		test(`${site} (${kind}): an allowedEnvVars list without the skip variable is named`, () => {
			const result = checkClaudeHttpHookSites((rel) =>
				rel === site
					? real(rel).replace(/(allowedEnvVars[^\]\n]*?)AGENTPULSE_SKIP/g, "$1AGENTPULSE_OTHER")
					: real(rel),
			);
			expect(
				result.problems.some((p) => p.startsWith(site) && p.includes("AGENTPULSE_SKIP")),
				`${site}: ${JSON.stringify(result.problems)}`,
			).toBe(true);
		});
	}
});
