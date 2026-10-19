/**
 * The asker is recorded when a thread is made, and a turn only ever continues a thread
 * its asker may reach. Whole turns, with the scripted LLM: SQLite only, like the other
 * Ask turn suites (the world fixture writes through the raw handle). The read, list and
 * archive rules are tabled in ask-thread-owner.test.ts on both dialects.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const llm = await import("../test-utils/scripted-llm.js");
const REGISTRY_PATH = "../services/ai/llm/registry.js";
const realRegistry = { ...(await import("../services/ai/llm/registry.js")) };
mock.module(REGISTRY_PATH, () => ({ getAdapter: () => llm.scriptedAdapter }));

const { config } = await import("../config.js");
const { getSqlite } = await import("../db/client.js");
const { app } = await import("../app.js");
const { TELEGRAM_ACTOR } = await import("../auth/actor.js");
const fixture = await import("../test-utils/ask-turn-fixture.js");
const service = await import("../services/ask/ask-service.js");
const limiter = await import("../services/ask/ask-turn-limiter.js");
const { registerRunningTurn } = await import("../services/ask/running-turns.js");
const { resetIdentityState } = await import("../test-utils/identity-reset.js");
const {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} = await import("../test-utils/team-fixtures.js");

const cfg = config as unknown as Record<string, number>;
const originalMax = cfg.askMaxConcurrent;
const finishers: Array<() => void> = [];

interface ThreadRow {
	id: string;
	owner_user_id: string | null;
	owner_key_id: string | null;
	origin: string;
}
const threadRows = () =>
	getSqlite()
		.prepare("SELECT id, owner_user_id, owner_key_id, origin FROM ask_threads ORDER BY created_at")
		.all() as ThreadRow[];
const messageCount = (threadId: string) =>
	(
		getSqlite()
			.prepare("SELECT COUNT(*) AS n FROM ask_messages WHERE thread_id = ?")
			.get(threadId) as {
			n: number;
		}
	).n;

function ask(headers: Headers, body: Record<string, unknown>, route = "/api/v1/ai/ask") {
	const merged = new Headers(headers);
	merged.set("content-type", "application/json");
	return app.request(route, { method: "POST", headers: merged, body: JSON.stringify(body) });
}

beforeAll(async () => {
	if (!isSqliteTest) return;
	await fixture.setupAskFixture();
});
afterAll(() => {
	mock.module(REGISTRY_PATH, () => realRegistry);
	if (!isSqliteTest) return;
	fixture.teardownAskFixture();
});
beforeEach(async () => {
	if (!isSqliteTest) return;
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = 4;
	await fixture.resetAskWorld();
	await setStoredMode("team");
});
afterEach(async () => {
	if (!isSqliteTest) return;
	for (const finish of finishers.splice(0)) finish();
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = originalMax;
	await resetIdentityState();
	await clearInstanceSettings();
});

describeSqliteOnly("a new thread records who asked it", () => {
	test("a signed-in user owns it, by user", async () => {
		const alice = await seedLocalUser("ot-alice");
		const res = await ask(await cookieHeadersFor(alice.id), { message: "hello there caching" });
		expect(res.status).toBe(200);
		expect(threadRows()).toEqual([
			{ id: expect.any(String), owner_user_id: alice.id, owner_key_id: null, origin: "web" },
		]);
	});

	test("a key owned by a person is that person's, not the key's", async () => {
		const alice = await seedLocalUser("ot-alice2");
		const key = await seedKey("ot-alice-key", ["manage"], alice.id);
		await ask(bearerHeaders(key.key), { message: "hello there caching" });
		expect(threadRows()).toEqual([
			{ id: expect.any(String), owner_user_id: alice.id, owner_key_id: null, origin: "web" },
		]);
	});

	test("a key with no owner is recorded by its own id", async () => {
		const key = await seedKey("ot-loose", ["manage"], null);
		await ask(bearerHeaders(key.key), { message: "hello there caching" });
		expect(threadRows()).toEqual([
			{ id: expect.any(String), owner_user_id: null, owner_key_id: key.id, origin: "web" },
		]);
	});

	test("the streaming route records it the same way", async () => {
		const alice = await seedLocalUser("ot-alice3");
		const res = await ask(
			await cookieHeadersFor(alice.id),
			{ message: "hello there caching" },
			"/api/v1/ai/ask/stream",
		);
		await res.text();
		expect(threadRows().map((t) => t.owner_user_id)).toEqual([alice.id]);
	});

	test("a Telegram chat's thread has no owner, and the chat keeps using it in team mode", async () => {
		const made = await service.findOrCreateTelegramThread({
			telegramChatId: "chat-1",
			seedTitle: "hello there caching",
		});
		expect(threadRows()).toEqual([
			{ id: made.id, owner_user_id: null, owner_key_id: null, origin: "telegram" },
		]);
		const turn = await service.runAskTurn({
			threadId: made.id,
			message: "hello again caching",
			origin: "telegram",
			telegramChatId: "chat-1",
			actor: TELEGRAM_ACTOR,
		});
		expect(turn.thread.id).toBe(made.id);
		expect(messageCount(made.id)).toBe(2);
	});
});

describeSqliteOnly("a turn continues only a thread its asker may reach", () => {
	test("another member naming someone's thread id starts a new thread of their own; the first is untouched", async () => {
		const alice = await seedLocalUser("ot-a-owner");
		const bob = await seedLocalUser("ot-b-intruder");
		const first = await (
			await ask(await cookieHeadersFor(alice.id), { message: "hello there caching" })
		).json();
		const aliceThread = (first as { thread: { id: string } }).thread.id;
		const before = messageCount(aliceThread);

		const second = await (
			await ask(await cookieHeadersFor(bob.id), {
				message: "hello again caching",
				threadId: aliceThread,
			})
		).json();
		const bobThread = (second as { thread: { id: string } }).thread.id;

		expect(bobThread).not.toBe(aliceThread);
		expect(messageCount(aliceThread)).toBe(before);
		const rows = threadRows();
		expect(rows.find((t) => t.id === bobThread)?.owner_user_id).toBe(bob.id);
	});

	test("the Telegram chat's actor continues its own thread and cannot reach a web thread, whatever it names", async () => {
		const alice = await seedLocalUser("ot-a-tg");
		const first = await (
			await ask(await cookieHeadersFor(alice.id), { message: "hello there caching" })
		).json();
		const webThread = (first as { thread: { id: string } }).thread.id;
		const before = messageCount(webThread);

		const turn = await service.runAskTurn({
			threadId: webThread,
			message: "hello again caching",
			origin: "telegram",
			telegramChatId: "chat-2",
			actor: TELEGRAM_ACTOR,
		});
		expect(turn.thread.id).not.toBe(webThread);
		expect(turn.thread.origin).toBe("telegram");
		expect(messageCount(webThread)).toBe(before);
	});

	test("naming another person's thread of a different origin is not told apart from naming nothing: no error that says it exists", async () => {
		const made = await service.findOrCreateTelegramThread({
			telegramChatId: "chat-3",
			seedTitle: "hello there caching",
		});
		const bob = await seedLocalUser("ot-b-origin");
		const admin = await seedLocalUser("ot-admin-origin", "admin");

		// A member can't reach the chat's thread: a new web thread, not "this thread is telegram-only".
		const res = await ask(await cookieHeadersFor(bob.id), {
			message: "hello again caching",
			threadId: made.id,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { thread: { id: string; origin: string } };
		expect(body.thread.id).not.toBe(made.id);
		expect(body.thread.origin).toBe("web");

		// An admin can reach it, so the origin rule applies to them as it always did.
		const refused = await ask(await cookieHeadersFor(admin.id), {
			message: "hello again caching",
			threadId: made.id,
		});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ error: "invalid_request" });
	});

	test("the asker, and an admin, continue it", async () => {
		const alice = await seedLocalUser("ot-a-cont");
		const admin = await seedLocalUser("ot-admin-cont", "admin");
		const first = await (
			await ask(await cookieHeadersFor(alice.id), { message: "hello there caching" })
		).json();
		const id = (first as { thread: { id: string } }).thread.id;

		for (const headers of [await cookieHeadersFor(alice.id), await cookieHeadersFor(admin.id)]) {
			const again = await (
				await ask(headers, { message: "and another caching question", threadId: id })
			).json();
			expect((again as { thread: { id: string } }).thread.id).toBe(id);
		}
		expect(threadRows()).toHaveLength(1);
		expect(messageCount(id)).toBe(6);
	});

	test("a thread running a turn answers 409 busy only to someone who may reach it", async () => {
		const alice = await seedLocalUser("ot-a-busy");
		const bob = await seedLocalUser("ot-b-busy");
		const first = await (
			await ask(await cookieHeadersFor(alice.id), { message: "hello there caching" })
		).json();
		const id = (first as { thread: { id: string } }).thread.id;
		const turn = registerRunningTurn(id, { userId: alice.id, keyId: null });
		if (!turn) throw new Error("the thread was already running");
		finishers.push(turn.finish);

		const mine = await ask(
			await cookieHeadersFor(alice.id),
			{ message: "hello again caching", threadId: id },
			"/api/v1/ai/ask/stream",
		);
		expect(mine.status).toBe(409);
		expect(await mine.json()).toMatchObject({ error: "thread_busy" });

		const theirs = await ask(
			await cookieHeadersFor(bob.id),
			{ message: "hello again caching", threadId: id },
			"/api/v1/ai/ask/stream",
		);
		expect(theirs.status).toBe(200);
		await theirs.text();
	});

	test("solo: any caller continues any thread, as before", async () => {
		await setStoredMode("solo");
		const one = await seedKey("ot-solo-1", ["manage"], null);
		const two = await seedKey("ot-solo-2", ["manage"], null);
		const first = await (
			await ask(bearerHeaders(one.key), { message: "hello there caching" })
		).json();
		const id = (first as { thread: { id: string } }).thread.id;
		const again = await (
			await ask(bearerHeaders(two.key), { message: "hello again caching", threadId: id })
		).json();
		expect((again as { thread: { id: string } }).thread.id).toBe(id);
		expect(threadRows()).toHaveLength(1);
	});
});
