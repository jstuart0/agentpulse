/**
 * RunLeaser unit tests.
 *
 * Covers:
 *   1. Drain processes every queued run and terminates when the queue is empty.
 *   2. Busy guard blocks re-entrant drain calls (timer-fires-while-busy pattern).
 *   3. Empty queue returns immediately with no processRun calls.
 *   4. Macrotask yield — the core fix for the bun event-loop soft-lockup
 *      (see thoughts/shared/investigations/active/2026-06-29-diagnose-bun-soft-lockup.md).
 *      A macrotask scheduled before drain starts must fire BETWEEN two processed
 *      runs, not after drain completes — proving the yield surrenders the event
 *      loop between iterations.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { enqueueRun } = await import("./watcher-runs-service.js");
const { aiWatcherRuns, sessions } = await import("../../db/schema/index.js");
const { RunLeaser } = await import("./run-leaser.js");

const SESSION_IDS = ["rl-s1", "rl-s2", "rl-s3"];

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(aiWatcherRuns).execute();
	await getDb().delete(sessions).execute();
	for (const id of SESSION_IDS) {
		await getDb()
			.insert(sessions)
			.values({ sessionId: id, agentType: "claude_code" })
			.onConflictDoNothing();
	}
});

describe("RunLeaser.drain", () => {
	test("processes all queued runs and terminates when queue is empty", async () => {
		for (const id of SESSION_IDS) {
			await enqueueRun({ sessionId: id, triggerKind: "idle" });
		}

		const processed: string[] = [];
		const leaser = new RunLeaser({
			leaseOwner: "test-owner",
			leaseDurationMs: 10_000,
			intervalMs: 60_000,
			shouldRun: async () => true,
			processRun: async (run) => {
				processed.push(run.sessionId);
			},
		});

		await leaser.drain();

		expect(processed).toHaveLength(3);
		expect(new Set(processed)).toEqual(new Set(SESSION_IDS));
	});

	test("busy guard blocks re-entrant drain called while drain is active", async () => {
		// This reproduces the production pattern: setInterval fires while a drain
		// is already in progress. The busy flag is set before the while loop, so
		// the re-entrant call sees busy=true and returns immediately.
		await enqueueRun({ sessionId: "rl-s1", triggerKind: "idle" });

		let processCallCount = 0;
		let reentrancyAttempted = false;
		// Structural type so the closure can reference the leaser without a
		// circular initializer; RunLeaser from a dynamic import can't be used
		// directly as a type annotation.
		let leaserRef: { drain(): Promise<void> } = {
			drain: async () => {},
		};

		const leaser = new RunLeaser({
			leaseOwner: "test-owner",
			leaseDurationMs: 10_000,
			intervalMs: 60_000,
			shouldRun: async () => true,
			processRun: async (_run) => {
				processCallCount++;
				reentrancyAttempted = true;
				// Simulate the interval timer firing while drain is already running.
				// this.busy is true at this point, so the second call must return
				// immediately without processing any runs.
				void leaserRef.drain();
			},
		});
		leaserRef = leaser;

		await leaser.drain();

		expect(reentrancyAttempted).toBe(true);
		// Re-entrant drain was blocked: processRun called exactly once.
		expect(processCallCount).toBe(1);
	});

	test("empty queue returns immediately without calling processRun", async () => {
		const processed: string[] = [];
		const leaser = new RunLeaser({
			leaseOwner: "test-owner",
			leaseDurationMs: 10_000,
			intervalMs: 60_000,
			shouldRun: async () => true,
			processRun: async (run) => {
				processed.push(run.sessionId);
			},
		});

		await leaser.drain();

		expect(processed).toHaveLength(0);
	});

	test("yield surrenders the event loop between runs (macrotask-starvation fix)", async () => {
		// Root cause: without the yield, bun:sqlite Promises resolve as microtasks
		// so the while(true) loop drains the entire queue in one unbroken microtask
		// burst — a macrotask scheduled before drain starts could only fire AFTER
		// drain completes, starving timers and I/O.
		//
		// Fix: `await new Promise(r => setTimeout(r, 0))` after each processRun
		// surrenders to the macrotask queue. Because the pre-scheduled macrotask
		// was enqueued first, it fires before the yield's own resolve — meaning it
		// fires BETWEEN run-1 and run-2, not after the drain finishes.
		//
		// Assertion: macrotaskIdx > runIndices[0]  (fired after first run)
		//             macrotaskIdx < runIndices[last] (fired before last run)
		// Without the yield both conditions would fail (macrotask fires last).

		await enqueueRun({ sessionId: "rl-s1", triggerKind: "idle" });
		await enqueueRun({ sessionId: "rl-s2", triggerKind: "idle" });

		const order: string[] = [];

		// Schedule before drain. With the yield this fires between run-1 and run-2
		// because: (a) it's already in the macrotask queue when the first yield
		// schedules its own resolve, and (b) Bun drains the macrotask queue FIFO,
		// so the pre-scheduled callback wins the next macrotask slot.
		setTimeout(() => order.push("macrotask"), 0);

		const leaser = new RunLeaser({
			leaseOwner: "test-owner",
			leaseDurationMs: 10_000,
			intervalMs: 60_000,
			shouldRun: async () => true,
			processRun: async (run) => {
				order.push(`run-${run.sessionId}`);
			},
		});

		await leaser.drain();

		// Both runs must have been processed.
		const runIndices = order
			.map((s, i) => ({ s, i }))
			.filter(({ s }) => s.startsWith("run-"))
			.map(({ i }) => i);

		expect(runIndices).toHaveLength(2);

		// Macrotask must have fired: between first and last run.
		const macrotaskIdx = order.indexOf("macrotask");
		expect(macrotaskIdx).toBeGreaterThan(runIndices[0]); // after first run
		expect(macrotaskIdx).toBeLessThan(runIndices[runIndices.length - 1]); // before last run
	});
});
