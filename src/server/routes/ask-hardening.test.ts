/**
 * Hardening of the Ask entry points: pinned session ids are validated before
 * anything is saved or any slot is taken; internal error text (paths, SQL)
 * never reaches a client; and a Telegram turn takes its slot before it makes a
 * thread or shows a typing indicator.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const llm = await import("../test-utils/scripted-llm.js");
mock.module("../services/ai/llm/registry.js", () => ({ getAdapter: () => llm.scriptedAdapter }));

const { config } = await import("../config.js");
const { getDb, getSqlite } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const fixture = await import("../test-utils/ask-turn-fixture.js");
const service = await import("../services/ask/ask-service.js");
const limiter = await import("../services/ask/ask-turn-limiter.js");
const { createFakeClock } = await import("../test-utils/fake-clock.js");

const cfg = config as unknown as Record<string, number>;
const originalMax = cfg.askMaxConcurrent;
const ROUTES = ["/api/v1/ai/ask", "/api/v1/ai/ask/stream"] as const;
const LEAKY =
	"SQLITE_CORRUPT: no such table events at /var/lib/agentpulse/data/agentpulse.db: SELECT * FROM events WHERE id IN (?, ?)";

let key = "";
const held: Array<{ release(): void }> = [];

const rows = (table: string) =>
	(getSqlite().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const stats = () => limiter.getAskTurnLimiterStats();

function post(route: string, body: unknown) {
	return app.request(route, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function waitFor(condition: () => boolean, what: string, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** Makes building a turn's context fail with a message full of internals. */
function breakContext() {
	const db = getDb();
	const realSelect = db.select.bind(db);
	return spyOn(db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
		if (fields && "displayName" in fields && "lastActivityAt" in fields) throw new Error(LEAKY);
		return realSelect(fields as never);
	}) as never);
}

beforeAll(async () => {
	if (!isSqliteTest) return;
	await fixture.setupAskFixture();
	key = (await createApiKey(`ask-hardening-${crypto.randomUUID()}`, ["manage"])).key;
});
afterAll(() => {
	if (!isSqliteTest) return;
	fixture.teardownAskFixture();
});
beforeEach(async () => {
	if (!isSqliteTest) return;
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = 2;
	await fixture.resetAskWorld();
});
afterEach(() => {
	if (!isSqliteTest) return;
	for (const slot of held.splice(0)) slot.release();
	limiter.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = originalMax;
});

describeSqliteOnly(
	"pinned session ids are validated before anything is saved or any slot is taken",
	() => {
		const bad: Array<[string, unknown]> = [
			["a string", "sess-alpha"],
			["an object", { 0: "sess-alpha" }],
			["a number", 5],
			["more than 20 ids", Array.from({ length: 21 }, (_, i) => `sess-${i}`)],
			["an id of 129 characters", ["x".repeat(129)]],
			["mixed types", ["sess-alpha", 5]],
			["a null element", ["sess-alpha", null]],
			["an empty id", [""]],
		];

		for (const route of ROUTES) {
			for (const [name, sessionIds] of bad) {
				test(`${route}: ${name} is a 400 invalid_session_ids and saves nothing`, async () => {
					const res = await post(route, { message: "hello there", sessionIds });
					expect(res.status).toBe(400);
					expect(await res.json()).toEqual({ error: "invalid_session_ids", max: 20 });
					expect(rows("ask_threads")).toBe(0);
					expect(rows("ask_messages")).toBe(0);
					expect(stats()).toMatchObject({ running: 0, waiting: 0 });
					expect(fixture.embedCalls.length).toBe(0);
				});
			}

			test(`${route}: the limits are inclusive (20 ids of 128 characters, an empty array, no field) and a refused request holds no slot even when the limiter is full`, async () => {
				const ids = Array.from({ length: 20 }, (_, i) => `${"s".repeat(127)}${i % 10}`);
				const ok = await post(route, { message: "hello there", sessionIds: ids });
				expect(ok.status).toBe(200);
				await ok.text();
				for (const body of [
					{ message: "hello there", sessionIds: [] },
					{ message: "hello there" },
				]) {
					const res = await post(route, body);
					expect(res.status).toBe(200);
					await res.text();
				}

				held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
				const refused = await post(route, { message: "hello there", sessionIds: "nope" });
				expect(refused.status).toBe(400); // not 503: validation comes before the limiter
				expect(stats()).toMatchObject({ running: 2, waiting: 0, rejected: 0 });
			});
		}

		test("the service refuses the same input before taking a slot, for the sync and the stream path", async () => {
			held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
			const tooMany = Array.from({ length: 21 }, (_, i) => `sess-${i}`);
			await expect(
				service.runAskTurn({ message: "hello", sessionIds: tooMany, actor: fixture.ASK_ACTOR }),
			).rejects.toBeInstanceOf(service.AskInvalidSessionIdsError);
			await expect(
				(async () => {
					for await (const _event of service.runAskTurnStream({
						message: "hello",
						sessionIds: "nope" as unknown as string[],
						actor: fixture.ASK_ACTOR,
					})) {
						// drain
					}
				})(),
			).rejects.toBeInstanceOf(service.AskInvalidSessionIdsError);
			expect(stats()).toMatchObject({ running: 2, waiting: 0, rejected: 0 });
			expect(rows("ask_messages")).toBe(0);
		});
	},
);

describeSqliteOnly("internal error text never reaches a client", () => {
	test("POST /ai/ask answers a generic 500 with no path or SQL, and logs the detail", async () => {
		const failing = breakContext();
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await post(ROUTES[0], { message: "hello there caching" });
			expect(res.status).toBe(500);
			const text = await res.text();
			expect(text).not.toMatch(/\/var|SQLITE|SELECT|events|agentpulse\.db/);
			expect(JSON.parse(text)).toEqual({ error: "ask_failed" });
			const logged = errors.mock.calls
				.map((c) => c.map((a) => (typeof a === "string" ? a : "[object]")).join(" "))
				.join("\n");
			expect(logged).toContain("SQLITE_CORRUPT");
			for (const call of errors.mock.calls)
				for (const arg of call) expect(typeof arg).toBe("string");
		} finally {
			failing.mockRestore();
			errors.mockRestore();
		}
	});

	test("the stream sends one generic error frame with no path or SQL", async () => {
		const failing = breakContext();
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await post(ROUTES[1], { message: "hello there caching" });
			const text = await res.text();
			expect(text).not.toMatch(/\/var|SQLITE|SELECT|agentpulse\.db/);
			const frames = text
				.split("\n\n")
				.filter((f) => f.startsWith("data: "))
				.map((f) => JSON.parse(f.slice(6)));
			expect(frames.length).toBe(1);
			expect(frames[0]).toMatchObject({ kind: "error", assistantMessage: null });
			expect(typeof frames[0].message).toBe("string");
			expect(frames[0].message.length).toBeGreaterThan(0);
		} finally {
			failing.mockRestore();
			errors.mockRestore();
		}
	});

	test("a mistake the caller can fix is still told what it was", async () => {
		const res = await post(ROUTES[0], { message: "   " });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_request", message: "Empty message." });
	});
});

describeSqliteOnly("Telegram turns", () => {
	async function enrolChat() {
		const { createPendingChannel, completeEnrollment } = await import(
			"../services/channels/channels-service.js"
		);
		const credentials = await import("../services/channels/telegram-credentials.js");
		getSqlite().exec("DELETE FROM notification_channels");
		const { channel } = await createPendingChannel({ kind: "telegram", label: "hardening" });
		await completeEnrollment({ channelId: channel.id, chatId: "4242" });
		await credentials.clearTelegramCredentials();
		(config as Record<string, unknown>).telegramBotToken = "test-token";
		await credentials.refreshTelegramCredentials();
		return credentials;
	}

	async function withTelegram<T>(
		run: (sent: { messages: string[]; actions: string[] }) => Promise<T>,
	): Promise<T> {
		const credentials = await enrolChat();
		const sent = { messages: [] as string[], actions: [] as string[] };
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
			if (String(url).endsWith("/sendMessage")) sent.messages.push(body.text ?? "");
			if (String(url).endsWith("/sendChatAction")) sent.actions.push("typing");
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}) as typeof fetch;
		try {
			return await run(sent);
		} finally {
			globalThis.fetch = realFetch;
			(config as Record<string, unknown>).telegramBotToken = "";
			await credentials.refreshTelegramCredentials();
		}
	}

	const update = (text: string) =>
		({ update_id: 1, message: { message_id: 1, chat: { id: 4242 }, text } }) as never;

	test("a turn that fails sends the fixed generic reply, never the error text, and logs only strings", async () => {
		const { ASK_FAILED_REPLY } = await import("../services/channels/telegram-replies.js");
		const { handleTelegramUpdate } = await import("./channels.js");
		const failing = breakContext();
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			await withTelegram(async (sent) => {
				await handleTelegramUpdate(update("hello there caching"));
				expect(sent.messages).toEqual([ASK_FAILED_REPLY]);
				expect(sent.messages.join(" ")).not.toMatch(/\/var|SQLITE|SELECT|agentpulse\.db/);
			});
			for (const call of errors.mock.calls)
				for (const arg of call) expect(typeof arg).toBe("string");
		} finally {
			failing.mockRestore();
			errors.mockRestore();
		}
	});

	test("a busy server leaves no thread row, sends exactly one busy reply and no typing indicator", async () => {
		const { ASK_BUSY_REPLY } = await import("../services/channels/telegram-replies.js");
		const { handleTelegramUpdate } = await import("./channels.js");
		const clock = createFakeClock();
		limiter.__setAskLimiterClockForTests({
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
		await withTelegram(async (sent) => {
			const handled = handleTelegramUpdate(update("hello there"));
			await waitFor(() => stats().waiting === 1, "the turn to queue");
			expect(sent.actions).toEqual([]);
			clock.advance(30_000);
			await handled;
			expect(sent.messages).toEqual([ASK_BUSY_REPLY]);
			expect(sent.actions).toEqual([]);
			expect(rows("ask_threads")).toBe(0);
			expect(rows("ask_messages")).toBe(0);
		});
	});

	test("the slot is held for the turn and released on success and when the turn throws", async () => {
		const { handleTelegramUpdate } = await import("./channels.js");
		await withTelegram(async (sent) => {
			const release = llm.holdLlmCalls();
			const handled = handleTelegramUpdate(update("hello there"));
			await waitFor(() => llm.llmCalls.length > 0, "the turn to reach the LLM");
			expect(stats().running).toBe(1);
			expect(sent.actions).toEqual(["typing"]);
			release();
			await handled;
			expect(stats().running).toBe(0);

			const failing = breakContext();
			const errors = spyOn(console, "error").mockImplementation(() => {});
			try {
				await handleTelegramUpdate(update("hello again caching"));
			} finally {
				failing.mockRestore();
				errors.mockRestore();
			}
			expect(stats().running).toBe(0);
		});
	});

	test("a message over the cap never takes a slot, even when the limiter is full", async () => {
		const { ASK_TOO_LONG_REPLY } = await import("../services/channels/telegram-replies.js");
		const { handleTelegramUpdate } = await import("./channels.js");
		held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
		await withTelegram(async (sent) => {
			await handleTelegramUpdate(update("a".repeat(8_001)));
			expect(sent.messages).toEqual([ASK_TOO_LONG_REPLY]);
			expect(stats()).toMatchObject({ running: 2, waiting: 0, rejected: 0 });
		});
	});
});
