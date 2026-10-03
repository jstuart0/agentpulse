/**
 * The write side's lock: `agentpulse exclude add` takes an exclusive lock file
 * (`exclude.lock`) next to the rules file.
 *
 *  - the wait is bounded on every path through the loop: a lock that is
 *    something other than a file (a directory) and looks stale used to be
 *    "broken" with an unlink that can't remove it, then retried with the
 *    deadline never checked, forever;
 *  - a stale lock is taken over by renaming it to a unique name and deleting
 *    that, and only if what was renamed is the lock that was judged stale: two
 *    waiters that both saw the same stale lock must not remove each other's
 *    fresh one.
 *
 * Every test builds its own directory under a throwaway root.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as writeModule from "./exclude-rules-write.js";

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function newDir(): string {
	const root = mkdtempSync(join(tmpdir(), "ap-exclude-lock-"));
	roots.push(root);
	const dir = join(root, ".agentpulse");
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

/** The lock function, looked up by name so a missing export fails the test, not the import. */
function acquire(
	dir: string,
	hooks: {
		afterStaleJudgement?: () => void;
		waitMs?: number;
		rename?: (from: string, to: string) => void;
		sleep?: (ms: number) => void;
	} = {},
): (() => void) | null {
	const fn = (writeModule as unknown as Record<string, unknown>).acquireExcludeLock;
	if (typeof fn !== "function") throw new Error("acquireExcludeLock is not exported");
	return (fn as (d: string, h: object) => (() => void) | null)(dir, hooks);
}

const OLD = new Date(Date.now() - 10 * 60 * 1000);
const DEAD_PID = "999999";

describe("exclude lock — the wait is bounded", () => {
	test("a free lock is taken and released", () => {
		const dir = newDir();
		const release = acquire(dir, { waitMs: 300 });
		expect(release).not.toBeNull();
		expect(existsSync(join(dir, "exclude.lock"))).toBe(true);
		release?.();
		expect(existsSync(join(dir, "exclude.lock"))).toBe(false);
	});

	test("a fresh lock held by a live process makes the call wait, then give up", () => {
		const dir = newDir();
		writeFileSync(join(dir, "exclude.lock"), `${process.pid}\n`);
		const started = Date.now();
		expect(acquire(dir, { waitMs: 300 })).toBeNull();
		expect(Date.now() - started).toBeLessThan(3000);
		expect(readFileSync(join(dir, "exclude.lock"), "utf-8")).toBe(`${process.pid}\n`);
	});

	test("an OLD lock that is a directory is not spun on forever: a child process gives up inside the wait", async () => {
		const dir = newDir();
		const lock = join(dir, "exclude.lock");
		mkdirSync(lock);
		utimesSync(lock, OLD, OLD);
		// In a child, so a spin can be killed instead of hanging the test run.
		const child = Bun.spawn(
			[
				"bun",
				"-e",
				`import { acquireExcludeLock } from ${JSON.stringify(join(import.meta.dir, "exclude-rules-write.ts"))};
				 const release = acquireExcludeLock(${JSON.stringify(dir)}, { waitMs: 400 });
				 process.exit(release ? 0 : 3);`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 8000);
		await child.exited;
		clearTimeout(timer);
		expect(timedOut, "the call spun until it was killed").toBe(false);
		expect(child.exitCode === 0 || child.exitCode === 3).toBe(true);
	}, 20_000);
});

describe("exclude lock — a takeover that keeps failing waits between tries", () => {
	test("a stale lock that can't be renamed away: every failed takeover is followed by one pause, never an immediate retry (no real waiting: the pause hook ends the run)", () => {
		const dir = newDir();
		writeFileSync(join(dir, "exclude.lock"), `${DEAD_PID}\n`);
		let judgements = 0;
		const sleeps: number[] = [];
		const END = "the third pause ends the run";
		let thrown: unknown;
		try {
			acquire(dir, {
				// far beyond the test: only the pause hook can end the loop
				waitMs: 10 * 60_000,
				afterStaleJudgement: () => {
					judgements++;
					if (judgements > 10) throw new Error("spun: more tries than pauses");
				},
				rename: () => {
					throw new Error("EPERM");
				},
				sleep: (ms) => {
					sleeps.push(ms);
					if (sleeps.length === 3) throw new Error(END);
				},
			});
		} catch (err) {
			thrown = err;
		}
		expect((thrown as Error | undefined)?.message).toBe(END);
		expect(sleeps).toHaveLength(3);
		expect(judgements, "one judgement per pass, one pause after each").toBe(3);
	});

	test("a takeover that works does not sleep first (positive control for the test above)", () => {
		const dir = newDir();
		writeFileSync(join(dir, "exclude.lock"), `${DEAD_PID}\n`);
		const sleeps: number[] = [];
		const release = acquire(dir, { waitMs: 1000, sleep: (ms) => sleeps.push(ms) });
		expect(release).not.toBeNull();
		expect(sleeps).toEqual([]);
		release?.();
	});
});

describe("exclude lock — stale takeover by rename", () => {
	test("a stale lock (dead pid) is taken over and the lock file left behind is ours", () => {
		const dir = newDir();
		const lock = join(dir, "exclude.lock");
		writeFileSync(lock, `${DEAD_PID}\n`);
		const release = acquire(dir, { waitMs: 1000 });
		expect(release).not.toBeNull();
		expect(readFileSync(lock, "utf-8")).toBe(`${process.pid}\n`);
		release?.();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("no renamed leftovers remain after a takeover", () => {
		const dir = newDir();
		writeFileSync(join(dir, "exclude.lock"), `${DEAD_PID}\n`);
		const release = acquire(dir, { waitMs: 1000 });
		expect(readdirSync(dir)).toEqual(["exclude.lock"]);
		release?.();
	});

	test("a rival that replaced the stale lock with a fresh one between the check and the takeover keeps it: the fresh lock is not removed", () => {
		const dir = newDir();
		const lock = join(dir, "exclude.lock");
		writeFileSync(lock, `${DEAD_PID}\n`);
		const release = acquire(dir, {
			waitMs: 400,
			afterStaleJudgement: () => {
				// the other waiter: removes the stale lock and takes a fresh one
				rmSync(lock);
				writeFileSync(lock, `${process.pid}\n`);
			},
		});
		expect(release, "the fresh lock is live, so this waiter must not get the lock").toBeNull();
		expect(existsSync(lock), "the rival's fresh lock is still there").toBe(true);
		expect(readFileSync(lock, "utf-8")).toBe(`${process.pid}\n`);
		expect(readdirSync(dir), "nothing renamed is left behind").toEqual(["exclude.lock"]);
	});

	// Linux filesystems hand a just-freed inode number to the next file created, so a
	// fresh lock can carry the stale one's device and inode. Overwriting the stale lock
	// in place is the deterministic form of that: same inode, new holder.
	test("a fresh lock that carries the stale lock's inode is still told apart from it and is not removed", () => {
		const dir = newDir();
		const lock = join(dir, "exclude.lock");
		writeFileSync(lock, `${DEAD_PID}\n`);
		const inoBefore = statSync(lock).ino;
		let inoDuringRival = -1;
		const release = acquire(dir, {
			waitMs: 400,
			afterStaleJudgement: () => {
				writeFileSync(lock, `${process.pid}\n`);
				inoDuringRival = statSync(lock).ino;
			},
		});
		expect(inoDuringRival, "the rival's lock reuses the inode (the case under test)").toBe(
			inoBefore,
		);
		expect(release, "the fresh lock is live, so this waiter must not get the lock").toBeNull();
		expect(readFileSync(lock, "utf-8")).toBe(`${process.pid}\n`);
		expect(readdirSync(dir), "nothing renamed is left behind").toEqual(["exclude.lock"]);
	});
});
