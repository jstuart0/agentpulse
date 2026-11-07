/**
 * D10: no test sends a real signal to a pid it didn't start. The guard that enforces it is tested with
 * `process.kill` replaced by a recorder, so a broken guard still cannot signal anything. The source scan
 * keeps the rule from decaying: a `killPid`/`killGroup` double that calls `process.kill` itself is exactly
 * what let a mutated stop path reach the relay and the user's Claude sessions.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createSignalGuard } from "./signal-guard.js";

const SUPERVISOR_DIR = join(import.meta.dir, "..");

async function withRecordedProcessKill(body: (calls: Array<[number, unknown]>) => void) {
	const calls: Array<[number, unknown]> = [];
	const spy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: unknown) => {
		calls.push([pid, signal]);
		return true;
	}) as typeof process.kill);
	try {
		body(calls);
	} finally {
		spy.mockRestore();
	}
}

describe("the signal guard", () => {
	test("sends to a pid the test allowed, and to its group only as a group leader", async () => {
		await withRecordedProcessKill((calls) => {
			const guard = createSignalGuard();
			guard.allow(4242);
			guard.killPid(4242, "SIGTERM");
			guard.killGroup(4242, "SIGKILL");
			expect(calls).toEqual([
				[4242, "SIGTERM"],
				[-4242, "SIGKILL"],
			]);
			expect(guard.sent).toEqual([
				[4242, "SIGTERM"],
				[4242, "SIGKILL"],
			]);
			expect(guard.refused).toEqual([]);
		});
	});

	test("refuses any other pid with EPERM, sends nothing and records the refusal", async () => {
		await withRecordedProcessKill((calls) => {
			const guard = createSignalGuard();
			guard.allow(4242);
			for (const pid of [4243, 1, 0, -1, process.pid, process.ppid]) {
				expect(() => guard.killPid(pid, "SIGTERM")).toThrow(/not in this test's tree/);
				expect(() => guard.killGroup(pid, "SIGKILL")).toThrow(/not in this test's tree/);
			}
			expect(calls).toEqual([]);
			expect(guard.sent).toEqual([]);
			expect(guard.refused).toHaveLength(12);
		});
	});

	test("a test that provokes a refusal can clear it", async () => {
		await withRecordedProcessKill(() => {
			const guard = createSignalGuard();
			expect(() => guard.killPid(4243, "SIGTERM")).toThrow();
			expect(guard.refused).toHaveLength(1);
			guard.clearRefused();
			expect(guard.refused).toEqual([]);
		});
	});

	test("refuses this process and its parent even when a test allowed them", async () => {
		await withRecordedProcessKill((calls) => {
			const guard = createSignalGuard();
			for (const pid of [1, process.pid, process.ppid]) guard.allow(pid);
			for (const pid of [1, process.pid, process.ppid]) {
				expect(() => guard.killPid(pid, "SIGTERM")).toThrow();
			}
			expect(calls).toEqual([]);
		});
	});
});

function testFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return testFiles(path);
		return name.endsWith(".test.ts") ? [path] : [];
	});
}

/** The text of the function or expression that follows `index`: to the matching brace, else to the next comma. */
function bodyAfter(source: string, index: number): string {
	const arrow = source.indexOf("=>", index);
	const start = arrow === -1 ? index : arrow + 2;
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{" || ch === "(") depth += 1;
		else if (ch === "}" || ch === ")") {
			if (depth === 0) return source.slice(start, i);
			depth -= 1;
			if (depth === 0 && ch === "}") return source.slice(start, i + 1);
		} else if (ch === "," && depth === 0) return source.slice(start, i);
	}
	return source.slice(start);
}

/** Receiver `killPid:` / `killGroup:` / `killPid =` doubles whose body calls `process.kill` directly. */
function directKillDoubles(source: string): number[] {
	const hits: number[] = [];
	for (const match of source.matchAll(/\b(killPid|killGroup)\s*[:=]/g)) {
		if (/process\.kill\s*\(/.test(bodyAfter(source, match.index as number))) {
			hits.push(source.slice(0, match.index).split("\n").length);
		}
	}
	return hits;
}

describe("the source scan", () => {
	test("finds a double that calls process.kill, and passes one that goes through the guard", () => {
		const bad =
			"const r = descendantReach(root, {\n\tkillPid: (pid, signal) => {\n\t\tprocess.kill(pid, signal);\n\t},\n});";
		const badOneLine = "descendantReach(root, { killPid: (p, s) => process.kill(p, s) });";
		const good = "descendantReach(root, { killPid: guard.killPid });";
		const goodRecorder = "descendantReach(root, { killPid: (pid) => void sent.push(pid) });";
		expect(directKillDoubles(bad)).toEqual([2]);
		expect(directKillDoubles(badOneLine)).toEqual([1]);
		expect(directKillDoubles(good)).toEqual([]);
		expect(directKillDoubles(goodRecorder)).toEqual([]);
	});

	test("no supervisor test has a killPid or killGroup double that calls process.kill", () => {
		// This file is skipped: its own fixtures are the bad examples.
		const offenders = testFiles(SUPERVISOR_DIR)
			.filter((file) => file !== import.meta.path)
			.flatMap((file) =>
				directKillDoubles(readFileSync(file, "utf8")).map(
					(line) => `${relative(SUPERVISOR_DIR, file)}:${line}`,
				),
			);
		expect(offenders).toEqual([]);
	});

	test("the headless stop suites make no live process.kill call except the existence probe", () => {
		// `process.kill(pid, 0)` only asks whether a pid exists. Any other call in these files is live.
		const suites = [
			join(SUPERVISOR_DIR, "providers", "claude-headless-stop.test.ts"),
			join(SUPERVISOR_DIR, "control-actions-claude-stop.test.ts"),
		];
		for (const file of suites) {
			const live = readFileSync(file, "utf8")
				.split("\n")
				.filter((line) => /process\.kill\s*\(/.test(line) && !/,\s*0\s*\)/.test(line));
			expect(live).toEqual([]);
		}
	});
});
