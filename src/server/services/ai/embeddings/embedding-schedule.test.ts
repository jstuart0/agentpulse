/**
 * AGEN-79: the embedder resumes and backfills on its own.
 *
 * What stopped it: inline embedding listens on the session bus, hook-delivered
 * events are announced only on the WebSocket channel, and the only other trigger
 * was a backfill at boot. So an install embedded nothing new after its boot
 * backfill finished, and a provider outage during that backfill left a backlog
 * until the next restart. These tests drive the scheduled tick the way a
 * running server does: events arrive with no bus notification, the provider
 * fails and comes back, a backlog is larger than one pass.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../../../test-utils/backend.js";
import "../../../db/__test_db.js";

const { config } = await import("../../../config.js");
const { getSqlite, initializeDatabase } = await import("../../../db/client.js");
const service = await import("./embedding-service.js");
const schedule = await import("./embedding-schedule.js");
const { insertEventRow, resetEmbeddingWorld } = await import(
	"../../../test-utils/embedding-fixtures.js"
);

const { installStatementMeter } = await import("../../../test-utils/statement-meter.js");

const MODEL = "schedule-model";
const STAGE_ONE = /octet_length\(e\.raw_payload\)/;
const originalVectorSearch = config.vectorSearchEnabled;
const NO_PAUSE = { pauseMs: 0 };

let embedCalls: string[];
let failing: boolean;

function useAdapter(model = MODEL) {
	service.__setEmbeddingAdapterForTests({
		kind: "ollama",
		model,
		dim: 4,
		embed: async (text: string) => {
			if (failing) throw new Error("provider down");
			embedCalls.push(text);
			return new Float32Array(4).fill(0.1);
		},
	});
}

function addEvents(count: number, label = "e"): number[] {
	return Array.from({ length: count }, (_, i) =>
		insertEventRow({ type: "UserPromptSubmit", rawPayload: { prompt: `${label}-${i}` } }),
	);
}

function embeddedIds(model = MODEL): number[] {
	return (
		getSqlite()
			.prepare(
				"SELECT event_id FROM event_embeddings WHERE model = ? AND dim = 4 ORDER BY event_id",
			)
			.all(model) as Array<{ event_id: number }>
	).map((r) => r.event_id);
}

beforeAll(async () => {
	if (!isSqliteTest) return;
	await initializeDatabase();
	(config as Record<string, unknown>).vectorSearchEnabled = true;
	service.__setBackfillBackoffForTests(() => 0);
});
afterAll(() => {
	if (!isSqliteTest) return;
	(config as Record<string, unknown>).vectorSearchEnabled = originalVectorSearch;
	service.__setBackfillBackoffForTests((attempt) => Math.min(1_000 * 2 ** (attempt - 1), 30_000));
	service.__resetEmbeddingAdapterForTests();
});
beforeEach(() => {
	if (!isSqliteTest) return;
	resetEmbeddingWorld();
	service.__resetEmbeddingAdapterForTests();
	schedule.__resetEmbeddingScheduleForTests();
	embedCalls = [];
	failing = false;
	useAdapter();
});
afterEach(() => {
	if (!isSqliteTest) return;
	service.__resetEmbeddingAdapterForTests();
});

describeSqliteOnly(
	"events that arrive after the first pass are embedded (the 2026-10 stall)",
	() => {
		test("hook events with no bus notification are picked up by the next tick", async () => {
			const first = addEvents(3, "boot");
			await schedule.runScheduledBackfillTick(NO_PAUSE);
			expect(embeddedIds()).toEqual(first);

			// The server keeps running; new hook events land. Nothing emits on the session bus.
			const later = addEvents(4, "later");
			embedCalls = [];
			const outcome = await schedule.runScheduledBackfillTick(NO_PAUSE);

			expect(embeddedIds()).toEqual([...first, ...later]);
			expect(outcome.handled).toBe(4);
			// Only the new events were embedded: the earlier ones were not walked again.
			expect(embedCalls.sort()).toEqual(["later-0", "later-1", "later-2", "later-3"]);
		});

		test("a later pass continues from the remembered cursor instead of walking the table from id 0", async () => {
			// Ids 1 and 21,000 leave four empty 5,000-id windows between them.
			insertEventRow({ id: 1, type: "UserPromptSubmit", rawPayload: { prompt: "old" } });
			insertEventRow({ id: 21_000, type: "UserPromptSubmit", rawPayload: { prompt: "mid" } });
			await schedule.runScheduledBackfillTick(NO_PAUSE);
			expect(embeddedIds()).toEqual([1, 21_000]);

			insertEventRow({ id: 21_001, type: "UserPromptSubmit", rawPayload: { prompt: "new" } });
			const meter = installStatementMeter();
			try {
				await schedule.runScheduledBackfillTick(NO_PAUSE);
				// One window above the cursor finds it; a walk from 0 would read five.
				expect(meter.matching(STAGE_ONE).length).toBeLessThanOrEqual(2);
			} finally {
				meter.restore();
			}
			expect(embeddedIds()).toEqual([1, 21_000, 21_001]);
		});

		test("a scheduled pass does not scan the whole events table to count it", async () => {
			addEvents(3);
			const meter = installStatementMeter();
			try {
				await schedule.runScheduledBackfillTick(NO_PAUSE);
				expect(meter.matching(/COUNT\(\*\)[\s\S]*FROM events/i)).toHaveLength(0);
			} finally {
				meter.restore();
			}
			expect(embeddedIds()).toHaveLength(3);
		});

		test("an idle tick embeds nothing, asks for the normal wait, and costs one MAX(id) read", async () => {
			addEvents(2);
			await schedule.runScheduledBackfillTick(NO_PAUSE);
			embedCalls = [];
			const outcome = await schedule.runScheduledBackfillTick(NO_PAUSE);
			expect(embedCalls).toEqual([]);
			expect(outcome).toEqual({ nextDelayMs: schedule.BACKFILL_TICK_MS, handled: 0 });
		});
	},
);

describeSqliteOnly("a backlog is worked off in bounded passes", () => {
	test("more events than one pass may take: each tick handles a slice, asks for a quick next tick, and the last one finishes", async () => {
		const ids = addEvents(70); // 32 + 32 + 6 per batch
		const one = { maxBatches: 1, pauseMs: 0 };

		const t1 = await schedule.runScheduledBackfillTick(one);
		expect(embeddedIds()).toHaveLength(32);
		expect(t1.nextDelayMs).toBe(schedule.BACKFILL_CATCHUP_TICK_MS);

		const t2 = await schedule.runScheduledBackfillTick(one);
		expect(embeddedIds()).toHaveLength(64);
		expect(t2.nextDelayMs).toBe(schedule.BACKFILL_CATCHUP_TICK_MS);

		const t3 = await schedule.runScheduledBackfillTick(one);
		expect(embeddedIds()).toEqual(ids);
		expect(t3.nextDelayMs).toBe(schedule.BACKFILL_TICK_MS);

		// Each event was embedded exactly once across the three passes.
		expect(embedCalls).toHaveLength(70);
		expect(new Set(embedCalls).size).toBe(70);
	});

	test("a pass pauses between batches, so ingest gets its turn", async () => {
		addEvents(70);
		const started = Date.now();
		await schedule.runScheduledBackfillTick({ maxBatches: 3, pauseMs: 30 });
		// Three batches, a 30 ms pause after each.
		expect(Date.now() - started).toBeGreaterThanOrEqual(80);
		expect(embeddedIds()).toHaveLength(70);
	});

	test("the default pass is bounded and paused", () => {
		expect(schedule.BACKFILL_BATCHES_PER_PASS).toBeGreaterThan(0);
		expect(schedule.BACKFILL_BATCHES_PER_PASS).toBeLessThanOrEqual(200);
		expect(schedule.BACKFILL_BATCH_PAUSE_MS).toBeGreaterThan(0);
	});
});

describeSqliteOnly("a provider outage heals without a restart", () => {
	test("failing passes back off, skip nothing, and the first good pass embeds everything", async () => {
		const ids = addEvents(5);
		failing = true;

		const f1 = await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(embeddedIds()).toEqual([]);
		expect(f1.nextDelayMs).toBe(schedule.BACKFILL_TICK_MS * 2);

		const f2 = await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(f2.nextDelayMs).toBe(schedule.BACKFILL_TICK_MS * 4);

		failing = false;
		const ok = await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(embeddedIds()).toEqual(ids);
		expect(ok.nextDelayMs).toBe(schedule.BACKFILL_TICK_MS);

		// And the backoff reset: the next failure starts from the first step again.
		failing = true;
		addEvents(1);
		const f3 = await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(f3.nextDelayMs).toBe(schedule.BACKFILL_TICK_MS * 2);
	});

	test("an embedding host that is down for a long while: one probe per wait, then it resumes on its own (the 2026-10 reboot)", async () => {
		const ids = addEvents(40);
		let attempts = 0;
		service.__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: MODEL,
			dim: 4,
			embed: async (text: string) => {
				attempts++;
				if (failing) throw new Error("host down");
				embedCalls.push(text);
				return new Float32Array(4).fill(0.1);
			},
		});
		failing = true;

		// The first pass finds the host down and opens the circuit after its 5 failures.
		await schedule.runScheduledBackfillTick(NO_PAUSE);
		// A batch embeds its 32 texts at once: 5 failed batches.
		expect(attempts).toBe(5 * service.BACKFILL_BATCH_ROWS);

		// While it stays down, every retry is half-open: exactly one probe batch.
		for (let i = 0; i < 6; i++) {
			attempts = 0;
			const outcome = await schedule.runScheduledBackfillTick(NO_PAUSE);
			expect(attempts).toBe(service.BACKFILL_BATCH_ROWS);
			expect(outcome.nextDelayMs).toBeLessThanOrEqual(schedule.BACKFILL_MAX_BACKOFF_MS);
		}
		expect(embeddedIds()).toEqual([]);

		// The host returns. The next probe succeeds and the same pass embeds everything pending.
		failing = false;
		const recovered = await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(embeddedIds()).toEqual(ids);
		expect(recovered.nextDelayMs).toBe(schedule.BACKFILL_TICK_MS);
	});

	test("the wait never exceeds its ceiling", async () => {
		addEvents(1);
		failing = true;
		let delay = 0;
		for (let i = 0; i < 12; i++)
			delay = (await schedule.runScheduledBackfillTick(NO_PAUSE)).nextDelayMs;
		expect(delay).toBe(schedule.BACKFILL_MAX_BACKOFF_MS);
	});

	test("an outage that begins mid-backlog resumes where it stopped, not from the start", async () => {
		addEvents(64);
		await schedule.runScheduledBackfillTick({ maxBatches: 1, pauseMs: 0 });
		expect(embeddedIds()).toHaveLength(32);
		failing = true;
		await schedule.runScheduledBackfillTick(NO_PAUSE);
		failing = false;
		embedCalls = [];
		await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(embeddedIds()).toHaveLength(64);
		expect(embedCalls).toHaveLength(32);
	});
});

describeSqliteOnly("what makes a pass start over", () => {
	test("a different embedding model embeds everything again, under its own name", async () => {
		const ids = addEvents(3);
		await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(embeddedIds()).toEqual(ids);

		useAdapter("schedule-model-2");
		await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(embeddedIds("schedule-model-2")).toEqual(ids);
	});

	test("an event whose vector went missing is found again by the periodic full walk, and not before", async () => {
		const ids = addEvents(3);
		const t0 = 1_000_000;
		await schedule.runScheduledBackfillTick({ ...NO_PAUSE, nowMs: t0 });
		getSqlite().prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(ids[1]);

		await schedule.runScheduledBackfillTick({ ...NO_PAUSE, nowMs: t0 + 1_000 });
		expect(embeddedIds()).toEqual([ids[0], ids[2]]);

		await schedule.runScheduledBackfillTick({
			...NO_PAUSE,
			nowMs: t0 + schedule.BACKFILL_FULL_WALK_MS + 1,
		});
		expect(embeddedIds()).toEqual(ids);
	});

	test("with vector search off, or no embedding provider, a tick does nothing and does not throw", async () => {
		addEvents(2);
		(config as Record<string, unknown>).vectorSearchEnabled = false;
		try {
			const off = await schedule.runScheduledBackfillTick(NO_PAUSE);
			expect(off.handled).toBe(0);
			expect(embeddedIds()).toEqual([]);
		} finally {
			(config as Record<string, unknown>).vectorSearchEnabled = true;
		}
		service.__setEmbeddingAdapterForTests(null);
		const none = await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(none).toEqual({ nextDelayMs: schedule.BACKFILL_TICK_MS, handled: 0 });
	});

	test("a pass already running (the manual button) is left alone", async () => {
		addEvents(2);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		service.__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: MODEL,
			dim: 4,
			embed: async () => {
				await gate;
				return new Float32Array(4).fill(0.1);
			},
		});
		const manual = service.runBackfill();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const tick = await schedule.runScheduledBackfillTick(NO_PAUSE);
		expect(tick).toEqual({ nextDelayMs: schedule.BACKFILL_TICK_MS, handled: 0 });
		release();
		await manual;
		expect(embeddedIds()).toHaveLength(2);
	});
});

describeSqliteOnly("concurrent starts run one pass (the guard is taken before any await)", () => {
	test("two passes started in the same tick: one runs, the other reports it did not", async () => {
		addEvents(40);
		const [a, b] = await Promise.all([service.runBackfillPass(), service.runBackfillPass()]);
		expect([a.ran, b.ran].sort()).toEqual([false, true]);
		// Every event embedded exactly once: no second pass raced the first.
		expect(embedCalls).toHaveLength(40);
		expect(embeddedIds()).toHaveLength(40);
		expect(service.isBackfillRunning()).toBe(false);
	});

	test("the manual button and a scheduled tick started together do not duplicate work", async () => {
		addEvents(40);
		const [progress, tick] = await Promise.all([
			service.runBackfill(),
			schedule.runScheduledBackfillTick(NO_PAUSE),
		]);
		expect(progress).toBeDefined();
		expect(embedCalls).toHaveLength(40);
		// The one that lost the race handled nothing and waits its normal interval.
		expect([tick.handled, 40 - tick.handled].includes(0)).toBe(true);
	});

	test("the guard is released when a pass ends, however it ends", async () => {
		addEvents(2);
		failing = true;
		await service.runBackfillPass({ failureLimit: 1 });
		expect(service.isBackfillRunning()).toBe(false);
		failing = false;
		const again = await service.runBackfillPass();
		expect(again.ran).toBe(true);
		expect(embeddedIds()).toHaveLength(2);
	});

	test("isBackfillRunning is true for exactly the life of a pass (the rebuild route reads it)", async () => {
		addEvents(2);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		service.__setEmbeddingAdapterForTests({
			kind: "ollama",
			model: MODEL,
			dim: 4,
			embed: async () => {
				await gate;
				return new Float32Array(4).fill(0.1);
			},
		});
		const running = service.runBackfill();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(service.isBackfillRunning()).toBe(true);
		release();
		await running;
		expect(service.isBackfillRunning()).toBe(false);
	});
});

describe("startEmbeddingBackfillSchedule", () => {
	function manualTimers(ticks: Array<{ nextDelayMs: number; handled: number }>) {
		const armed: Array<{ run: () => void; delayMs: number }> = [];
		const cleared: unknown[] = [];
		let tickCount = 0;
		const deps = {
			setTimer: (run: () => void, delayMs: number) => {
				const handle = { run, delayMs };
				armed.push(handle);
				return handle;
			},
			clearTimer: (handle: unknown) => {
				cleared.push(handle);
			},
			tick: async () => ticks[tickCount++] ?? { nextDelayMs: 1, handled: 0 },
		};
		return { deps, armed, cleared, tickCount: () => tickCount };
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	test("first tick after boot, then each tick waits as long as the last one asked", async () => {
		const t = manualTimers([
			{ nextDelayMs: 5_000, handled: 10 },
			{ nextDelayMs: 120_000, handled: 0 },
		]);
		schedule.startEmbeddingBackfillSchedule(t.deps);
		expect(t.armed.map((a) => a.delayMs)).toEqual([schedule.BACKFILL_FIRST_TICK_MS]);

		t.armed[0]?.run();
		await settle();
		expect(t.armed.map((a) => a.delayMs)).toEqual([schedule.BACKFILL_FIRST_TICK_MS, 5_000]);

		t.armed[1]?.run();
		await settle();
		expect(t.armed.map((a) => a.delayMs)).toEqual([
			schedule.BACKFILL_FIRST_TICK_MS,
			5_000,
			120_000,
		]);
	});

	test("stop clears the timer and a tick still in flight does not re-arm", async () => {
		const t = manualTimers([{ nextDelayMs: 5_000, handled: 0 }]);
		const stop = schedule.startEmbeddingBackfillSchedule(t.deps);
		t.armed[0]?.run();
		stop();
		await settle();
		expect(t.cleared).toHaveLength(1);
		expect(t.armed).toHaveLength(1);
	});
});

describe("wiring", () => {
	test("the server starts the schedule, and no longer relies on a boot-only backfill", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("../../../index.ts", import.meta.url), "utf8");
		expect(source).toMatch(/^startEmbeddingBackfillSchedule\(\);$/m);
		expect(source).not.toContain("startBackfillIfNeeded");
	});
});
