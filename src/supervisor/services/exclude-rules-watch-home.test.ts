/**
 * The supervisor says once, in its own log, when the user's rules sit under the
 * account's home but it runs with another HOME. It sends nothing anywhere and
 * changes nothing about what it reports.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warnIfHomeMismatch } from "./exclude-rules-watch.js";

let root: string;
let usedHome: string;
let accountHome: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ap-watch-home-")));
	usedHome = join(root, "service-home");
	accountHome = join(root, "account-home");
	mkdirSync(usedHome, { recursive: true });
	mkdirSync(join(accountHome, ".agentpulse"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("warnIfHomeMismatch", () => {
	test("rules under the account's home that this process never reads: one line to the local log, naming both homes", () => {
		writeFileSync(join(accountHome, ".agentpulse", "exclude"), "/x\n");
		const lines: string[] = [];
		expect(warnIfHomeMismatch(usedHome, accountHome, (l) => lines.push(l))).toBe(true);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(usedHome);
		expect(lines[0]).toContain(accountHome);
		expect(lines[0]).toContain("not being applied");
	});

	test("nothing to say: nothing is logged", () => {
		const lines: string[] = [];
		expect(warnIfHomeMismatch(usedHome, accountHome, (l) => lines.push(l))).toBe(false);
		expect(warnIfHomeMismatch(accountHome, accountHome, (l) => lines.push(l))).toBe(false);
		expect(lines).toEqual([]);
	});

	test("index.ts says it once at startup, with the account's home from the user database, through the supervisor's own log", () => {
		const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8");
		expect(source).toMatch(/warnIfHomeMismatch\(\s*home,\s*resolveAccountHome\(\),/);
		expect(source.match(/warnIfHomeMismatch\(/g)).toHaveLength(1);
		const lookup = readFileSync(join(import.meta.dir, "exclude-rules-watch.ts"), "utf-8");
		expect(lookup).toMatch(/userInfo\(\)\.homedir/);
	});
});
