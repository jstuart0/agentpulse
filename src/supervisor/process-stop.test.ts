/**
 * The stop ladder (AGEN-110): ordering with a scripted reach, and the two reaches against real child
 * processes. Every real signal goes through a signal guard (D10) that sends only to a pid this test
 * started and throws for anything else; nothing is matched by name, and every wait is a few hundred
 * milliseconds. A pid-reuse decoy is a real process that the ladder is told has a different start time
 * than the one it recorded. The default killers are tested only with `process.kill` replaced by a recorder.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GracefulStep,
	type ProcessInfo,
	type ProcessTable,
	type Reach,
	__setDescendantKillerForTests,
	createSystemProcessTable,
	defaultKillGroup,
	defaultKillPid,
	descendantReach,
	groupReach,
	isSignalablePid,
	runStopLadder,
	systemProcessTable,
} from "./process-stop.js";
import { fakeClaudeReady } from "./test-utils/fake-claude.js";
import { type SignalGuard, createSignalGuard } from "./test-utils/signal-guard.js";

const FAKE = join(import.meta.dir, "providers", "__fixtures__", "fake-claude-tree.ts");
const TIMES = { termMs: 250, killMs: 3000 };

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const dirs: string[] = [];
const strays: number[] = [];
const spawned: Array<ChildProcess | ReturnType<typeof Bun.spawn>> = [];
let guard: SignalGuard;
beforeEach(() => {
	guard = createSignalGuard();
});
afterEach(() => {
	// A stop that went for a pid outside the test's tree was refused; that is a failure of the code under
	// test even if its own assertions passed. A test that provokes a refusal clears it first.
	const refused = [...guard.refused];
	// Only pids this test recorded from its own fixtures; the guard refuses any other.
	for (const pid of strays.splice(0)) {
		try {
			guard.killPid(pid, "SIGKILL");
		} catch {}
	}
	for (const proc of spawned.splice(0)) {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	expect(refused).toEqual([]);
});

function logEntries(path: string): Array<Record<string, unknown>> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function until(check: () => boolean, what: string) {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

/** Starts the fake and waits until it has recorded itself (and its child, when it has one). */
async function startFake(env: Record<string, string>, how: "bun" | "group-leader") {
	const dir = mkdtempSync(join(tmpdir(), "ap-stop-"));
	dirs.push(dir);
	const log = join(dir, "fake.log");
	const fullEnv = { ...process.env, FAKE_CLAUDE_LOG: log, ...env };
	let root: { pid: number; hasExited(): boolean; kill(s: NodeJS.Signals): void };
	if (how === "bun") {
		const proc = Bun.spawn({
			cmd: [process.execPath, FAKE],
			env: fullEnv,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		spawned.push(proc);
		root = {
			pid: guard.allow(proc.pid),
			hasExited: () => proc.exitCode !== null || proc.signalCode !== null,
			kill: (signal) => proc.kill(signal),
		};
	} else {
		const child = spawn(process.execPath, [FAKE], {
			env: fullEnv,
			stdio: "ignore",
			detached: true,
		});
		spawned.push(child);
		root = {
			pid: guard.allow(child.pid as number),
			hasExited: () => child.exitCode !== null || child.signalCode !== null,
			kill: (signal) => {
				child.kill(signal);
			},
		};
	}
	await until(() => fakeClaudeReady(logEntries(log), env), "the fake to be ready");
	const entries = logEntries(log);
	const grandchild = entries.find((e) => e.role === "child")?.pid as number | undefined;
	if (grandchild) strays.push(guard.allow(grandchild));
	return { root, log, grandchild };
}

describe("the ladder's order", () => {
	function scripted(goneAfter: string | null) {
		const calls: string[] = [];
		const reach: Reach = {
			signal: (signal) => {
				calls.push(signal);
			},
			gone: () => goneAfter !== null && calls.includes(goneAfter),
		};
		return { calls, reach };
	}
	const steps = (calls: string[]): GracefulStep[] => [
		{ name: "interrupt", act: () => void calls.push("interrupt"), waitMs: 30 },
		{ name: "stdin", act: () => void calls.push("stdin"), waitMs: 30 },
	];

	test("polite steps first, then SIGTERM, then SIGKILL", async () => {
		const { calls, reach } = scripted("SIGKILL");
		const left = await runStopLadder({ reach, graceful: steps(calls), termMs: 30, killMs: 30 });
		expect(left).toBe(true);
		expect(calls).toEqual(["interrupt", "stdin", "SIGTERM", "SIGKILL"]);
	});

	test("a process that leaves after a polite step is never signalled", async () => {
		const calls: string[] = [];
		const reach: Reach = {
			signal: (signal) => {
				calls.push(signal);
			},
			gone: () => calls.includes("stdin"),
		};
		expect(await runStopLadder({ reach, graceful: steps(calls), termMs: 30, killMs: 30 })).toBe(
			true,
		);
		expect(calls).toEqual(["interrupt", "stdin"]);
	});

	test("a process that leaves on SIGTERM is not killed", async () => {
		const { calls, reach } = scripted("SIGTERM");
		expect(await runStopLadder({ reach, termMs: 30, killMs: 30 })).toBe(true);
		expect(calls).toEqual(["SIGTERM"]);
	});

	test("one that never leaves reports false after SIGKILL and the kill wait", async () => {
		const { calls, reach } = scripted(null);
		const began = Date.now();
		expect(await runStopLadder({ reach, termMs: 40, killMs: 60 })).toBe(false);
		expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
		expect(Date.now() - began).toBeGreaterThanOrEqual(90);
	});

	test("prepare runs once, before any step", async () => {
		const calls: string[] = [];
		const reach: Reach = {
			prepare: async () => void calls.push("prepare"),
			signal: (signal) => {
				calls.push(signal);
			},
			gone: () => calls.includes("SIGTERM"),
		};
		await runStopLadder({ reach, graceful: steps(calls), termMs: 30, killMs: 30 });
		expect(calls).toEqual(["prepare", "interrupt", "stdin", "SIGTERM"]);
	});
});

describe("descendantReach against real processes", () => {
	test("a child that called setsid is reached; a group signal alone misses it", async () => {
		// Why the snapshot exists: the fake leads its own group, its child leads another. Signalling the
		// group stops the fake and leaves the child running.
		const group = await startFake({ FAKE_CLAUDE_CHILD: "setsid" }, "group-leader");
		const groupRoot = group.root;
		const viaGroup = groupReach(
			{ pid: groupRoot.pid, hasExited: groupRoot.hasExited, kill: groupRoot.kill },
			{ killGroup: guard.killGroup },
		);
		await runStopLadder({ reach: viaGroup, ...TIMES });
		expect(alive(group.grandchild as number)).toBe(true);
		guard.killPid(group.grandchild as number, "SIGKILL");
		await Bun.sleep(50);

		const snapshot = await startFake({ FAKE_CLAUDE_CHILD: "setsid" }, "bun");
		const reach = descendantReach(snapshot.root, { killPid: guard.killPid });
		const left = await runStopLadder({ reach, ...TIMES });
		expect(left).toBe(true);
		expect(alive(snapshot.grandchild as number)).toBe(false);
		expect(snapshot.root.hasExited()).toBe(true);
		expect(guard.refused).toEqual([]);
	});

	test("a child that ignores SIGTERM is signalled TERM then KILL, by its recorded pid", async () => {
		const fake = await startFake(
			{
				FAKE_CLAUDE_CHILD: "setsid",
				FAKE_CLAUDE_IGNORE_TERM: "1",
				FAKE_CLAUDE_CHILD_IGNORE_TERM: "1",
			},
			"bun",
		);
		const sent: Array<[number, string]> = [];
		const reach = descendantReach(fake.root, {
			killPid: (pid, signal) => {
				sent.push([pid, signal]);
				guard.killPid(pid, signal);
			},
		});
		expect(await runStopLadder({ reach, ...TIMES })).toBe(true);
		expect(sent).toEqual([
			[fake.grandchild as number, "SIGTERM"],
			[fake.grandchild as number, "SIGKILL"],
		]);
		expect(alive(fake.grandchild as number)).toBe(false);
		expect(fake.root.hasExited()).toBe(true);
	});

	test("a recorded pid that now shows a different start time is a stranger and survives", async () => {
		const fake = await startFake({ FAKE_CLAUDE_CHILD: "setsid" }, "bun");
		const decoy = fake.grandchild as number;
		let listed = 0;
		const table: ProcessTable = {
			async list() {
				const rows = await systemProcessTable.list();
				listed += 1;
				// The first read (the snapshot) is true; every later one says the pid belongs to a
				// process that started at another time under another parent, as a reused pid would.
				return listed === 1
					? rows
					: rows.map((row) =>
							row.pid === decoy ? { ...row, ppid: 1, started: "Mon Jan  1 00:00:00 2001" } : row,
						);
			},
		};
		const sent: number[] = [];
		const reach = descendantReach(fake.root, {
			table,
			killPid: (pid, signal) => {
				sent.push(pid);
				guard.killPid(pid, signal);
			},
		});
		await runStopLadder({ reach, ...TIMES });
		expect(fake.root.hasExited()).toBe(true);
		expect(sent).not.toContain(decoy);
		expect(alive(decoy)).toBe(true);
	});

	test("a process that is not under the root is not touched, even if it is another child of ours", async () => {
		const fake = await startFake({}, "bun");
		const bystander = Bun.spawn({
			cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		spawned.push(bystander);
		await Bun.sleep(100);
		const sent: number[] = [];
		const reach = descendantReach(fake.root, {
			killPid: (pid, signal) => {
				sent.push(pid);
				guard.killPid(pid, signal);
			},
		});
		await runStopLadder({ reach, ...TIMES });
		expect(fake.root.hasExited()).toBe(true);
		expect(sent).toEqual([]);
		expect(guard.refused).toEqual([]);
		expect(alive(bystander.pid)).toBe(true);
	});

	test("a root the table doesn't show as this process's child is signalled by handle only", async () => {
		const rows: ProcessInfo[] = [
			{ pid: 4242, ppid: 1, started: "x" },
			{ pid: 4243, ppid: 4242, started: "y" },
		];
		const handleSignals: string[] = [];
		let exited = false;
		const sent: number[] = [];
		const reach = descendantReach(
			{
				pid: 4242,
				hasExited: () => exited,
				kill: (signal) => {
					handleSignals.push(signal);
					exited = true;
				},
			},
			{ table: { list: async () => rows }, killPid: (pid) => void sent.push(pid) },
		);
		expect(await runStopLadder({ reach, ...TIMES })).toBe(true);
		expect(handleSignals).toEqual(["SIGTERM"]);
		expect(sent).toEqual([]);
	});

	test("an unreadable process table signals no descendant and declares nothing gone early", async () => {
		const rows: ProcessInfo[] = [];
		let exited = false;
		const sent: number[] = [];
		const reach = descendantReach(
			{
				pid: 4242,
				hasExited: () => exited,
				kill: () => {
					exited = true;
				},
			},
			{ table: { list: async () => rows }, killPid: (pid) => void sent.push(pid) },
		);
		await runStopLadder({ reach, ...TIMES });
		expect(sent).toEqual([]);
	});
});

/** Replaces `process.kill` with a recorder for the body, so a default killer under test cannot signal anything. */
async function withRecordedProcessKill(
	body: (calls: Array<[number, unknown]>) => Promise<void> | void,
) {
	const calls: Array<[number, unknown]> = [];
	const spy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: unknown) => {
		calls.push([pid, signal]);
		return true;
	}) as typeof process.kill);
	try {
		await body(calls);
	} finally {
		spy.mockRestore();
	}
}

describe("the floor under every default killer (D10)", () => {
	const never = [0, 1, -1, Number.NaN, 1.5, process.pid, process.ppid];

	test("isSignalablePid refuses 0, 1, negatives, non-integers, this process and its parent", () => {
		for (const pid of never) expect(isSignalablePid(pid)).toBe(false);
		expect(isSignalablePid(4242)).toBe(process.pid !== 4242 && process.ppid !== 4242);
	});

	test("defaultKillPid and defaultKillGroup throw EPERM for those pids and call process.kill for none", async () => {
		await withRecordedProcessKill((calls) => {
			for (const pid of never) {
				for (const kill of [defaultKillPid, defaultKillGroup]) {
					expect(() => kill(pid, "SIGTERM")).toThrow(/refusing to signal/);
				}
			}
			expect(calls).toEqual([]);
		});
	});

	test("defaultKillPid signals a pid and defaultKillGroup its negation, for an ordinary pid", async () => {
		await withRecordedProcessKill((calls) => {
			defaultKillPid(4242, "SIGTERM");
			defaultKillGroup(4243, "SIGKILL");
			expect(calls).toEqual([
				[4242, "SIGTERM"],
				[-4243, "SIGKILL"],
			]);
		});
	});

	test("groupReach never signals a group for pid 1 or lower, this process or its parent: it uses the handle", () => {
		for (const pid of [0, 1, process.pid, process.ppid]) {
			const groups: number[] = [];
			const handle: string[] = [];
			const reach = groupReach(
				{ pid, hasExited: () => true, kill: (signal) => void handle.push(signal) },
				{ killGroup: (target) => void groups.push(target) },
			);
			reach.signal("SIGTERM");
			expect(groups).toEqual([]);
			expect(handle).toEqual(["SIGTERM"]);
		}
	});

	test("groupReach signals the group of an ordinary pid through killGroup", () => {
		const groups: Array<[number, string]> = [];
		const reach = groupReach(
			{ pid: 4242, hasExited: () => true, kill: () => {} },
			{ killGroup: (target, signal) => void groups.push([target, signal]) },
		);
		reach.signal("SIGKILL");
		expect(groups).toEqual([[4242, "SIGKILL"]]);
	});

	test("with the default killer, a descendantReach signals only the ordinary descendant of the root", async () => {
		const rows = new Map<number, ProcessInfo>();
		const add = (pid: number, ppid: number) => rows.set(pid, { pid, ppid, started: `t${pid}` });
		add(4242, process.pid);
		add(4243, 4242);
		// Rows the walk would reach through the root if it included them; the floor must still refuse them.
		for (const pid of [1, process.pid, process.ppid]) add(pid, 4242);
		const lines: string[] = [];
		const previous = __setDescendantKillerForTests(defaultKillPid);
		try {
			await withRecordedProcessKill(async (calls) => {
				const handle: string[] = [];
				const reach = descendantReach(
					{ pid: 4242, hasExited: () => false, kill: (signal) => void handle.push(signal) },
					{ table: { list: async () => [...rows.values()] }, log: (line) => void lines.push(line) },
				);
				await reach.signal("SIGTERM");
				expect(calls).toEqual([[4243, "SIGTERM"]]);
				expect(handle).toEqual(["SIGTERM"]);
			});
		} finally {
			__setDescendantKillerForTests(previous);
		}
		expect(lines.filter((line) => line.includes("EPERM"))).toHaveLength(
			new Set([1, process.pid, process.ppid]).size,
		);
	});

	test("the supervisor test preload is installed: the default killer in a test is not the real one", () => {
		const installed = __setDescendantKillerForTests(defaultKillPid);
		__setDescendantKillerForTests(installed);
		expect(installed).not.toBe(defaultKillPid);
		expect(() => installed(4242, "SIGTERM")).toThrow();
	});
});

describe("a process table that does not answer (hung ps)", () => {
	test("the root still gets SIGTERM, no descendant is signalled, and the ladder finishes", async () => {
		let exited = false;
		const handleSignals: string[] = [];
		const sent: number[] = [];
		const reach = descendantReach(
			{
				pid: 4242,
				hasExited: () => exited,
				kill: (signal) => {
					handleSignals.push(signal);
					exited = true;
				},
			},
			{
				table: { list: () => new Promise<ProcessInfo[]>(() => {}) },
				tableTimeoutMs: 40,
				killPid: (pid) => void sent.push(pid),
			},
		);
		const began = Date.now();
		expect(await runStopLadder({ reach, termMs: 250, killMs: 3000 })).toBe(true);
		expect(handleSignals).toEqual(["SIGTERM"]);
		expect(sent).toEqual([]);
		// Two reads (before the first signal, and at it) each wait out the 40 ms bound; nothing waits on ps itself.
		expect(Date.now() - began).toBeLessThan(2_000);
	});

	test("a system table whose ps hangs is killed at its timeout and returns nothing, never a partial listing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ap-ps-hang-"));
		dirs.push(dir);
		const pidFile = join(dir, "pid");
		const table = createSystemProcessTable({
			timeoutMs: 150,
			command: [
				process.execPath,
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.stdout.write('1 0 Mon Jan  1 00:00:00 2001\\n'); setInterval(() => {}, 1000);",
				pidFile,
			],
		});
		const began = Date.now();
		const rows = await table.list();
		expect(rows).toEqual([]);
		expect(Date.now() - began).toBeLessThan(3_000);
		const hung = Number(readFileSync(pidFile, "utf8"));
		strays.push(guard.allow(hung));
		await until(() => !alive(hung), "the hung ps to be killed");
	});

	test("a system table that fails to start returns nothing", async () => {
		const table = createSystemProcessTable({ command: ["/no/such/ps-binary"] });
		expect(await table.list()).toEqual([]);
	});
});

describe("how often a reach is polled", () => {
	test("a reach that reads ps asks for a slower poll than the default 25 ms", async () => {
		const noRoot = { pid: 4242, hasExited: () => true, kill: () => {} };
		const descendant = descendantReach(noRoot, { killPid: () => {} });
		expect(descendant.pollMs).toBeGreaterThanOrEqual(100);
		expect(groupReach({ pid: 4242, hasExited: () => true, kill: () => {} }).pollMs).toBeUndefined();
	});

	test("the ladder polls at the reach's own interval", async () => {
		let checks = 0;
		const reach: Reach = {
			pollMs: 100,
			signal: () => {},
			gone: () => {
				checks += 1;
				return false;
			},
		};
		await runStopLadder({ reach, termMs: 350, killMs: 1 });
		// 100 ms apart over ~350 ms is about four checks; the default 25 ms would be about fourteen.
		expect(checks).toBeLessThanOrEqual(7);
	});
});

describe("did the reach ever see the table while the root lived (treeChecked)", () => {
	const handle = () => {
		let exited = false;
		return {
			root: {
				pid: 4242,
				hasExited: () => exited,
				kill: () => {
					exited = true;
				},
			},
		};
	};
	const rows: ProcessInfo[] = [{ pid: 4242, ppid: process.pid, started: "x" }];

	test("a table that never yields a listing while the root lives: unchecked, though the root is gone", async () => {
		const { root } = handle();
		const reach = descendantReach(root, { table: { list: async () => [] }, killPid: () => {} });
		expect(await runStopLadder({ reach, termMs: 100, killMs: 100 })).toBe(true);
		expect(reach.treeChecked?.()).toBe(false);
	});

	test("a table that answers null (never resolves) is unchecked as well", async () => {
		const { root } = handle();
		const reach = descendantReach(root, {
			table: { list: () => new Promise<ProcessInfo[]>(() => {}) },
			tableTimeoutMs: 20,
			killPid: () => {},
		});
		await runStopLadder({ reach, termMs: 100, killMs: 100 });
		expect(reach.treeChecked?.()).toBe(false);
	});

	test("prepare alone tries the table a second time: one failed read before a good one is already checked", async () => {
		const { root } = handle();
		let reads = 0;
		const reach = descendantReach(root, {
			table: { list: async () => (++reads === 1 ? [] : rows) },
			killPid: () => {},
		});
		await reach.prepare?.();
		expect(reads).toBe(2);
		expect(reach.treeChecked?.()).toBe(true);
	});

	test("a good read while the root lives is checked", async () => {
		const { root } = handle();
		const reach = descendantReach(root, { table: { list: async () => rows }, killPid: () => {} });
		await runStopLadder({ reach, termMs: 100, killMs: 100 });
		expect(reach.treeChecked?.()).toBe(true);
	});

	test("a root that had already exited before the stop began has nothing to look for: checked", async () => {
		const reach = descendantReach(
			{ pid: 4242, hasExited: () => true, kill: () => {} },
			{ table: { list: async () => [] }, killPid: () => {} },
		);
		await runStopLadder({ reach, termMs: 100, killMs: 100 });
		expect(reach.treeChecked?.()).toBe(true);
	});

	test("the group reach has no tree to check: the question is not asked", () => {
		expect(
			groupReach({ pid: 4242, hasExited: () => true, kill: () => {} }).treeChecked,
		).toBeUndefined();
	});
});
