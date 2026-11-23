import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity } from "../shared/process-identity.js";
import { type LockDeps, acquireLock, lockIsStale } from "./lock.js";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ap-lock-"));
	path = join(dir, "update.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const real = (over: Partial<LockDeps> = {}): LockDeps => ({
	now: () => Date.now(),
	pid: process.pid,
	identityOf: processIdentity,
	bootTimeMs: () => null,
	...over,
});

describe("update.lock", () => {
	test("is taken exclusively and released", () => {
		const release = acquireLock(path, real());
		expect(release).not.toBeNull();
		expect(JSON.parse(readFileSync(path, "utf-8")).pid).toBe(process.pid);
		// a live holder keeps a second taker out
		expect(acquireLock(path, real())).toBeNull();
		release?.();
		expect(existsSync(path)).toBe(false);
		expect(acquireLock(path, real())).not.toBeNull();
	});

	test("a holder that has exited (a child this test started) is stale and taken over", async () => {
		const child = Bun.spawn(["sleep", "30"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const identity = processIdentity(child.pid);
		expect(identity).not.toBeNull();
		writeFileSync(
			path,
			`${JSON.stringify({ pid: child.pid, processStartedAt: identity, takenAt: Date.now() })}\n`,
		);
		// still alive: not stale
		expect(lockIsStale(path, real())).toBe(false);
		expect(acquireLock(path, real())).toBeNull();
		child.kill();
		await child.exited;
		expect(lockIsStale(path, real())).toBe(true);
		const release = acquireLock(path, real());
		expect(release).not.toBeNull();
		release?.();
	});

	test("a pid that now belongs to a different process (another start time) is stale", () => {
		writeFileSync(
			path,
			`${JSON.stringify({ pid: process.pid, processStartedAt: "Mon Jan  1 00:00:00 1990", takenAt: Date.now() })}\n`,
		);
		expect(lockIsStale(path, real())).toBe(true);
	});

	test("a lock taken before the machine booted is stale", () => {
		writeFileSync(
			path,
			`${JSON.stringify({ pid: process.pid, processStartedAt: processIdentity(process.pid), takenAt: 1000 })}\n`,
		);
		expect(lockIsStale(path, real({ bootTimeMs: () => 5000 }))).toBe(true);
		expect(lockIsStale(path, real({ bootTimeMs: () => 500 }))).toBe(false);
	});

	test("a torn or unreadable lock is stale only once it has sat unmodified for 5 seconds", () => {
		writeFileSync(path, '{"pid":');
		// a taker may be between creating the file and writing it
		expect(lockIsStale(path, real())).toBe(false);
		expect(acquireLock(path, real())).toBeNull();
		expect(lockIsStale(path, real({ wallNow: () => Date.now() + 6_000 }))).toBe(true);
		expect(acquireLock(path, real({ wallNow: () => Date.now() + 6_000 }))).not.toBeNull();
	});

	test("two takers of one stale lock: the slower one finds the faster one's live lock and leaves it alone", async () => {
		const child = Bun.spawn(["sleep", "30"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const dead = processIdentity(child.pid);
		child.kill();
		await child.exited;
		writeFileSync(
			path,
			`${JSON.stringify({ pid: child.pid, processStartedAt: dead, takenAt: Date.now() })}\n`,
		);
		let fast: (() => void) | null = null;
		const slow = acquireLock(
			path,
			real({
				// A has judged the lock stale; before it moves it, B takes over and holds a live lock.
				afterJudgedStale: () => {
					fast = acquireLock(path, real());
				},
			}),
		);
		expect(fast).not.toBeNull();
		expect(slow).toBeNull();
		expect(JSON.parse(readFileSync(path, "utf-8")).pid).toBe(process.pid);
		expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
		(fast as unknown as () => void)();
	});

	test("a symlink at the lock path is never written through", () => {
		const target = join(dir, "elsewhere");
		symlinkSync(target, path);
		expect(acquireLock(path, real())).toBeNull();
		expect(existsSync(target)).toBe(false);
	});
});
