/**
 * No path from the server, the web or MCP to the updater (rule 7): nothing there imports `src/updater`, and
 * nothing there spawns a process that names the updater, `update`, `launchctl` or `systemctl`. The server reads
 * `src/shared/update-files.ts`, which has no writer. The updater, in turn, imports nothing from `src/server`,
 * reads no environment variable of its own accord, and never names the files rule 18 protects.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { code, findViolations, walk } from "./test-utils/no-server-reach.js";

const ROOT = join(import.meta.dir, "..", "..");
let temp: string | null = null;
afterEach(() => {
	if (temp) rmSync(temp, { recursive: true, force: true });
	temp = null;
});

describe("no path from the server, web or MCP to the updater", () => {
	test("the repository has none", () => {
		expect(findViolations(ROOT)).toEqual([]);
	});

	test("the detector finds a planted spawn and a planted import (jackson's mutation, run once)", () => {
		temp = mkdtempSync(join(tmpdir(), "ap-reach-"));
		mkdirSync(join(temp, "src", "server"), { recursive: true });
		writeFileSync(
			join(temp, "src/server/evil.ts"),
			'export const go = () => Bun.spawn(["agentpulse", "update"]);\n',
		);
		writeFileSync(
			join(temp, "src/server/evil2.ts"),
			'import { runUpdate } from "../updater/updater.js";\nexport const x = runUpdate;\n',
		);
		writeFileSync(
			join(temp, "src/server/evil3.ts"),
			'import { execFileSync } from "node:child_process";\nexport const y = () => execFileSync("launchctl", ["bootout", "x"]);\n',
		);
		writeFileSync(
			join(temp, "src/server/fine.ts"),
			'export const z = () => Bun.spawn(["git", "status"]);\n',
		);
		const found = findViolations(temp);
		expect(found.some((v) => v.startsWith("src/server/evil.ts"))).toBe(true);
		expect(found.some((v) => v.startsWith("src/server/evil2.ts"))).toBe(true);
		expect(found.some((v) => v.startsWith("src/server/evil3.ts"))).toBe(true);
		expect(found.some((v) => v.startsWith("src/server/fine.ts"))).toBe(false);
	});

	test("the server's only link to update files is the read-only shared module", () => {
		const text = readFileSync(join(ROOT, "src/shared/update-files.ts"), "utf-8");
		expect(text).not.toMatch(/writeFile|writeSync|appendFile|rename|unlink|mkdir|Bun\.write|spawn/);
	});
});

describe("the updater itself", () => {
	const files = walk(join(ROOT, "src/updater"));
	const texts = files.map((f) => ({ f: relative(ROOT, f), t: code(readFileSync(f, "utf-8")) }));

	test("imports nothing from src/server, and the CLI is the only thing that reads process.env", () => {
		for (const { f, t } of texts) {
			expect(t, f).not.toMatch(/from\s+["'][^"']*\/server\//);
			if (!/real-deps|cli\.ts$/.test(f)) expect(t, f).not.toMatch(/process\.env/);
		}
	});

	test("the only environment variable that changes what it does is the real-services opt-in", () => {
		const real = readFileSync(join(ROOT, "src/updater/real-deps.ts"), "utf-8");
		expect(real).not.toMatch(/env\.(AGENTPULSE_[A-Z_]+|REPO|KEYS)/);
	});

	test("never names a file rule 18 protects", () => {
		for (const { f, t } of [
			...texts,
			{
				f: "update-drain.ts",
				t: code(readFileSync(join(ROOT, "src/supervisor/services/update-drain.ts"), "utf-8")),
			},
		]) {
			expect(t, f).not.toMatch(
				/hook-auth-header|claude-fork-mcp|supervisor-gate-state|supervisor\.json|["'`]exclude["'`]/,
			);
		}
	});
});

void dirname;
