/**
 * Holds the Claude canary's own source to the safety rules in CI, with no Claude and no key (AGEN-117, phase 7):
 * nothing but the one spawner starts Claude, nothing signals a process by name or by a command substitution,
 * the only `process.kill` calls are the ones that name a pid this run started, the key is dropped from the
 * canary's own environment before anything else loads and never reaches a file or an argument, and every
 * thing the run prints is redacted. The scan is a tripwire for accidents; the run-time checks are the line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanClaudeText } from "./lib/claude-canary-safety.js";

const scriptsDir = import.meta.dir;
const canary = readFileSync(join(scriptsDir, "claude-takeover-canary.ts"), "utf8");

function canaryFiles(): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
		if (entry.isFile() && /\.(ts|mjs|js|sh)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
			out.push(`scripts/${entry.name}`);
		}
	}
	for (const entry of readdirSync(join(scriptsDir, "lib"), { withFileTypes: true })) {
		if (entry.isFile() && /\.(ts|mjs|js|sh)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
			out.push(`scripts/lib/${entry.name}`);
		}
	}
	return out;
}

describe("the scan of the Claude canary's files", () => {
	test("finds nothing in the scripts as they are, and reads something", () => {
		const files = canaryFiles();
		expect(files).toContain("scripts/claude-takeover-canary.ts");
		expect(files).toContain("scripts/lib/claude-canary-spawn.ts");
		const findings = files.flatMap((path) =>
			scanClaudeText(path, readFileSync(join(scriptsDir, "..", path), "utf8")),
		);
		expect(findings).toEqual([]);
	});

	test("a planted spawn of claude outside the spawner, and a kill by name, are flagged", () => {
		const spawnPlant = scanClaudeText(
			"scripts/claude-x.ts",
			'import { spawn } from "node:child_process";\nspawn("claude", ["-p", "x"]);\n',
		);
		expect(spawnPlant.map((f) => f.rule)).toContain("claude-spawn");
		const killPlant = scanClaudeText("scripts/claude-x.ts", 'sh("pkill -f claude");\n');
		expect(killPlant.map((f) => f.rule)).toContain("kill-by-name");
		const substitution = scanClaudeText("scripts/claude-x.ts", 'sh("kill $(pgrep claude)");\n');
		expect(substitution.map((f) => f.rule)).toContain("kill-by-name");
	});

	test("the spawner itself may spawn claude", () => {
		expect(
			scanClaudeText(
				"scripts/lib/claude-canary-spawn.ts",
				'spawn("/opt/homebrew/bin/claude", args);\n',
			),
		).toEqual([]);
	});
});

describe("the canary's own source", () => {
	test("every process.kill names a pid this run started, or checks one with signal 0", () => {
		const calls = canary.match(/process\.kill\([^)]*\)/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		const allowed = [
			/^process\.kill\(pid, 0\)$/, // pidAlive: sends nothing
			/^process\.kill\(pid, "SIGKILL"\)$/, // a pid from ownClaudePids (this run's CLAUDE_CONFIG_DIR)
			/^process\.kill\(-pid, signal\)$/, // the supervisor process group this run spawned
			/^process\.kill\(first\.pid, "SIGKILL"\)$/, // the supervisor this run spawned
		];
		for (const call of calls) {
			expect(
				allowed.some((pattern) => pattern.test(call)),
				call,
			).toBe(true);
		}
	});

	test("the key is dropped from the environment before the first dynamic import, and output is redacted", () => {
		const start = canary.indexOf("export async function runClaudeCanary");
		const body = canary.slice(start);
		const dropped = body.indexOf("delete process.env.ANTHROPIC_API_KEY");
		const redacted = body.indexOf("redactOutput(key)");
		const firstImport = body.indexOf("await import(");
		expect(dropped).toBeGreaterThan(0);
		expect(redacted).toBeGreaterThan(dropped);
		expect(firstImport).toBeGreaterThan(redacted);
	});

	test("the exit guard is installed before the first child can exist, the kill timer goes through it, and a failed supervisor start stops its own group", () => {
		const start = canary.indexOf("export async function runClaudeCanary");
		const body = canary.slice(start);
		const installed = body.indexOf("installClaudeGuard()");
		expect(installed).toBeGreaterThan(0);
		expect(installed).toBeLessThan(body.indexOf("await import("));
		expect(body.indexOf("mkdirSync(root")).toBeGreaterThan(installed);
		expect(body).toMatch(/killTimer = setTimeout\([\s\S]*?guard\?\.fire\(2\)/);
		expect(canary).not.toMatch(/kill timer[^\n]*\n[^\n]*process\.exit/);
		// A supervisor that fails to register is stopped by its own group before the error leaves.
		expect(canary).toMatch(
			/\.catch\(async \(error\) => \{[\s\S]*?await stopOwnGroup\(\);[\s\S]*?throw error;/,
		);
		// The guard module signals only what was recorded, and the signal handlers are installed by it.
		const guardSource = readFileSync(join(scriptsDir, "claude-canary-guard.ts"), "utf8");
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(guardSource).toContain(signal);
		expect(guardSource).toContain('process.on("exit", cleanup)');
		expect(guardSource).toContain("killOwnClaudeProcesses");
		expect(guardSource).not.toMatch(/pkill|killall|pgrep/);
	});

	test("no file write and no argument carries the key", () => {
		for (const call of canary.match(/(?:writeFileSync|appendFileSync)\([^;]*;/gs) ?? []) {
			expect(call, call.slice(0, 80)).not.toMatch(/run\.key|\bkey\b[,)]|ANTHROPIC_API_KEY/);
		}
		expect(canary).not.toMatch(/kubectl/);
		// The helper script prints a variable of its own environment; the file holds no value.
		expect(canary).toContain("$CANARY_HELPER_VALUE");
	});

	test("the child environment is built from names, never copied from this process", () => {
		expect(canary).not.toMatch(/\.\.\.process\.env/);
		expect(canary).not.toMatch(/env:\s*process\.env/);
	});
});
