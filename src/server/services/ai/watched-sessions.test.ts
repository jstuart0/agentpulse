import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { sessions, watcherConfigs } = await import("../../db/schema/index.js");
const {
	invalidateWatchedSessions,
	isWatched,
	resetWatchedSessionsForTest,
	setWatchedSessionsClockForTest,
	setWatchedSessionsLoaderForTest,
} = await import("./watched-sessions.js");
const { deleteWatcherConfig, upsertWatcherConfig } = await import("./watcher-config-service.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	resetWatchedSessionsForTest();
	await getDb().delete(watcherConfigs);
	await getDb().delete(sessions);
	for (const id of ["w1", "w2"]) {
		await getDb().insert(sessions).values({ sessionId: id, agentType: "claude_code" });
	}
});

afterEach(() => resetWatchedSessionsForTest());

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("isWatched", () => {
	test("flips immediately after a config write, with no TTL wait", async () => {
		let clock = 1_000;
		setWatchedSessionsClockForTest(() => clock);
		await upsertWatcherConfig({
			sessionId: "w1",
			providerId: "p",
			enabled: true,
			notifyEnabled: true,
		});
		expect(await isWatched("w1")).toBe(true);

		await upsertWatcherConfig({ sessionId: "w1", enabled: false });
		// Same instant: the cached set would still say true without the invalidation.
		expect(await isWatched("w1")).toBe(false);

		await upsertWatcherConfig({ sessionId: "w1", enabled: true });
		expect(await isWatched("w1")).toBe(true);

		await deleteWatcherConfig("w1");
		expect(await isWatched("w1")).toBe(false);
		clock += 1;
	});

	test("both modes off means not watched", async () => {
		await upsertWatcherConfig({
			sessionId: "w1",
			providerId: "p",
			enabled: true,
			notifyEnabled: false,
			continueEnabled: false,
		});
		expect(await isWatched("w1")).toBe(false);
		await upsertWatcherConfig({ sessionId: "w1", continueEnabled: true });
		expect(await isWatched("w1")).toBe(true);
	});

	test("one query per TTL when nothing is invalidated; the TTL then expires", async () => {
		let queries = 0;
		let clock = 0;
		setWatchedSessionsClockForTest(() => clock);
		setWatchedSessionsLoaderForTest(async () => {
			queries += 1;
			return new Set(["w1"]);
		});
		await Promise.all([isWatched("w1"), isWatched("w2"), isWatched("w1")]);
		expect(queries).toBe(1);
		await isWatched("w1");
		expect(queries).toBe(1);
		clock += 31_000;
		await isWatched("w1");
		expect(queries).toBe(2);
	});

	test("a database error is logged and answers false", async () => {
		setWatchedSessionsLoaderForTest(async () => {
			throw new Error("db is down");
		});
		const original = console.error;
		const logged: unknown[] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			expect(await isWatched("w1")).toBe(false);
		} finally {
			console.error = original;
		}
		expect(logged.length).toBe(1);
	});
});

describe("the invalidate-during-load race", () => {
	test("a load held open across an invalidation does not populate the cache", async () => {
		const gate = deferred<void>();
		let queries = 0;
		setWatchedSessionsLoaderForTest(async () => {
			queries += 1;
			await gate.promise;
			// Answers with the state as of when the query ran: stale after the invalidation.
			return new Set(["w1"]);
		});
		const held = isWatched("w1");
		await Promise.resolve();
		invalidateWatchedSessions();
		gate.resolve();
		expect(await held).toBe(true);

		// The stale answer was not stored: the next call reloads.
		setWatchedSessionsLoaderForTest(async () => {
			queries += 1;
			return new Set();
		});
		expect(await isWatched("w1")).toBe(false);
		expect(queries).toBe(2);
	});

	test("a call that starts after the invalidation, while the old load is still held, issues its own query", async () => {
		const gate = deferred<void>();
		let queries = 0;
		setWatchedSessionsLoaderForTest(async () => {
			queries += 1;
			if (queries === 1) {
				await gate.promise;
				return new Set(["w1"]); // the pre-write state
			}
			return new Set<string>(); // the state after the write
		});
		const old = isWatched("w1");
		await Promise.resolve();
		invalidateWatchedSessions();
		const fresh = await isWatched("w1");
		expect(queries).toBe(2);
		expect(fresh).toBe(false);
		gate.resolve();
		expect(await old).toBe(true);
		// The older load finished last but must not overwrite the newer answer.
		expect(await isWatched("w1")).toBe(false);
	});
});
