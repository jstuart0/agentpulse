/**
 * SQLite has one connection, so the general transaction helper and the admin
 * lock (an open BEGIN IMMEDIATE) can't overlap on it. The helper waits for the
 * lock when it is held, instead of throwing "cannot start a transaction within
 * a transaction" and losing the work. Made deterministic with latches.
 */
import { afterEach, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase, getDb } = await import("./client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { withAdminLock } = await import("./admin-lock.js");
const { withTransaction } = await import("./with-transaction.js");
const { processHookEvent } = await import("../services/event-processor.js");

beforeAll(async () => {
	await initializeDatabase();
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	// A failing assertion must not leave the lock held for the next test.
	for (const cleanup of cleanups.splice(0)) await cleanup();
	await resetIdentityState();
	await getDb().delete(events);
	await getDb().delete(sessions);
});

function latch() {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { held, release };
}

/** Holds the admin lock until `release()`; the body notes its start and end in `order`. */
async function holdAdminLock(order: string[] = [], name = "lock") {
	const gate = latch();
	const entered = latch();
	const done = withAdminLock(
		async () => {
			order.push(`${name}-start`);
			entered.release();
			await gate.held;
			order.push(`${name}-end`);
		},
		{ sqliteAllowYield: true },
	);
	cleanups.push(async () => {
		gate.release();
		await done.catch(() => {});
	});
	await entered.held;
	return { release: gate.release, done };
}

describeSqliteOnly("the transaction helper and a held admin lock", () => {
	test("a transaction started while the lock is held runs after it ends, instead of throwing", async () => {
		const order: string[] = [];
		const lock = await holdAdminLock(order);

		const waiter = withTransaction(async () => {
			order.push("transaction");
			return "done";
		});
		await Bun.sleep(20);
		expect(order).toEqual(["lock-start"]);

		lock.release();
		await lock.done;
		expect(await waiter).toBe("done");
		expect(order).toEqual(["lock-start", "lock-end", "transaction"]);
	});

	test("it also waits behind lock holders that were already queued", async () => {
		const order: string[] = [];
		const first = await holdAdminLock(order, "first");
		const second = withAdminLock(async () => {
			order.push("second");
		});
		const waiter = withTransaction(async () => {
			order.push("transaction");
		});
		await Bun.sleep(20);
		first.release();
		await Promise.all([first.done, second, waiter]);
		expect(order).toEqual(["first-start", "first-end", "second", "transaction"]);
	});

	test("a hook event that needs a transaction while the lock is held is stored, not lost", async () => {
		const sessionId = "wl-session";
		await getDb()
			.insert(sessions)
			.values({ sessionId, agentType: "claude_code", status: "active" });
		const lock = await holdAdminLock();

		const event = processHookEvent(
			{ session_id: sessionId, hook_event_name: "PermissionRequest", tool_use_id: "tu-1" },
			"claude_code",
		);
		await Bun.sleep(20);
		lock.release();
		await lock.done;
		await event;

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect((row?.metadata as { permissionWait?: unknown }).permissionWait).toBeDefined();
		expect(
			(await getDb().select().from(events).where(eq(events.sessionId, sessionId))).length,
		).toBeGreaterThan(0);
	});

	test("several transactions queued behind one held lock all commit, one at a time", async () => {
		const lock = await holdAdminLock();
		const open: number[] = [];
		let maxOpen = 0;
		const writers = Array.from({ length: 5 }, (_, i) =>
			withTransaction(async (tx) => {
				open.push(i);
				maxOpen = Math.max(maxOpen, open.length);
				await tx.insert(sessions).values({
					sessionId: `queued-${i}`,
					agentType: "claude_code",
					status: "active",
				});
				await tx.insert(events).values({
					sessionId: `queued-${i}`,
					eventType: "UserPromptSubmit",
					rawPayload: {},
				});
				open.splice(open.indexOf(i), 1);
			}),
		);
		await Bun.sleep(20);
		lock.release();
		await lock.done;
		const settled = await Promise.allSettled(writers);

		expect(settled.map((s) => s.status)).toEqual(Array(5).fill("fulfilled"));
		expect(maxOpen).toBe(1);
		const stored = await getDb().select().from(events);
		expect(stored.filter((e) => e.sessionId.startsWith("queued-")).length).toBe(5);
	});

	test("transactions started together, with no lock held, queue instead of colliding", async () => {
		const settled = await Promise.allSettled(
			Array.from({ length: 5 }, (_, i) =>
				withTransaction(async (tx) => {
					await tx.insert(sessions).values({
						sessionId: `free-${i}`,
						agentType: "claude_code",
						status: "active",
					});
				}),
			),
		);
		expect(settled.map((s) => s.status)).toEqual(Array(5).fill("fulfilled"));
		expect((await getDb().select().from(sessions)).length).toBe(5);
	});

	test("a transaction nested inside another is refused at once, not left waiting for itself", async () => {
		const outcome = await Promise.race([
			withTransaction(async () => {
				await withTransaction(async () => "inner");
			}).then(
				() => "completed",
				(error: Error) => error.message,
			),
			Bun.sleep(1500).then(() => "hung"),
		]);
		expect(outcome).not.toBe("hung");
		expect(outcome).not.toBe("completed");
		expect(await withTransaction(async () => "after")).toBe("after");
	});

	test("with the lock free the helper runs straight away and still rolls back on a throw", async () => {
		const sessionId = "wl-rollback";
		await getDb()
			.insert(sessions)
			.values({ sessionId, agentType: "claude_code", status: "active", displayName: "before" });
		await expect(
			withTransaction(async (tx) => {
				await tx
					.update(sessions)
					.set({ displayName: "after" })
					.where(eq(sessions.sessionId, sessionId));
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row?.displayName).toBe("before");
	});
});
