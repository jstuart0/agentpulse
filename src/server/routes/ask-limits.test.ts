/**
 * What the Ask routes and turns do under the turn limiter and the body caps:
 * who holds a slot and for how long, what a refused or abandoned caller sees,
 * and that an over-long body is refused before it is parsed. The limiter's own
 * arithmetic is in `services/ask/ask-turn-limiter.test.ts`.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { describeSqliteOnly } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const llm = await import("../test-utils/scripted-llm.js");
mock.module("../services/ai/llm/registry.js", () => ({ getAdapter: () => llm.scriptedAdapter }));

const { config } = await import("../config.js");
const { getDb, getSqlite } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const fixture = await import("../test-utils/ask-turn-fixture.js");
const cases = await import("../test-utils/ask-turn-cases.js");
const { createFakeClock } = await import("../test-utils/fake-clock.js");
const service = await import("../services/ask/ask-service.js");
const limiter = await import("../services/ask/ask-turn-limiter.js").catch(() => null);

const cfg = config as unknown as Record<string, number>;
const originalMax = cfg.askMaxConcurrent;
const BODY_LIMIT = 262_144;
const BUSY_MESSAGE = "Ask is busy right now. Try again in a few seconds.";
const ROUTES = ["/api/v1/ai/ask", "/api/v1/ai/ask/stream"] as const;

let key = "";
const held: Array<{ release(): void }> = [];

async function waitFor(condition: () => boolean, what: string, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

const stats = () =>
	limiter?.getAskTurnLimiterStats() ?? { running: -1, waiting: -1, rejected: -1, aborted: -1 };

/** Fills both slots and all four queue places. */
async function saturate(): Promise<void> {
	if (!limiter) throw new Error("no limiter");
	held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
	for (let i = 0; i < 4; i++) {
		void limiter.acquireAskTurn().then(
			(slot) => held.push(slot),
			() => {},
		);
	}
	await waitFor(() => stats().waiting === 4, "a full queue");
}

function post(route: string, body: BodyInit | null, headers: Record<string, string> = {}) {
	return app.request(route, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
		body,
		// biome-ignore lint/suspicious/noExplicitAny: Bun's Request accepts duplex for stream bodies
		...({ duplex: "half" } as any),
	});
}

const message = (text = "hello there caching") => JSON.stringify({ message: text });

/** A JSON body of exactly `bytes` bytes: a valid message padded with trailing spaces. */
function bodyOfSize(bytes: number): string {
	const base = message();
	return base + " ".repeat(bytes - base.length);
}

function chunkedStream(totalBytes: number, chunkBytes: number, counter: { pulls: number }) {
	let sent = 0;
	const chunk = new TextEncoder().encode(" ".repeat(chunkBytes));
	const first = new TextEncoder().encode(message());
	return new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				counter.pulls++;
				if (sent === 0) {
					controller.enqueue(first);
					sent += first.length;
					return;
				}
				if (sent >= totalBytes) return controller.close();
				const n = Math.min(chunkBytes, totalBytes - sent);
				controller.enqueue(chunk.subarray(0, n));
				sent += n;
			},
		},
		{ highWaterMark: 0 },
	);
}

beforeAll(async () => {
	await fixture.setupAskFixture();
	key = (await createApiKey(`ask-limits-${crypto.randomUUID()}`, ["manage"])).key;
});
afterAll(() => {
	fixture.teardownAskFixture();
});
beforeEach(async () => {
	limiter?.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = 2;
	await fixture.resetAskWorld();
});
afterEach(() => {
	for (const slot of held.splice(0)) slot.release();
	limiter?.__resetAskTurnLimiterForTests();
	cfg.askMaxConcurrent = originalMax;
});

const rows = (table: string) =>
	(getSqlite().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describeSqliteOnly("a turn holds a slot for exactly as long as it runs", () => {
	test("a turn that throws releases its slot, sync and stream", async () => {
		const db = getDb();
		const realSelect = db.select.bind(db);
		const failing = spyOn(db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
			if (fields && "displayName" in fields && "lastActivityAt" in fields) {
				throw new Error("context store unavailable");
			}
			return realSelect(fields as never);
		}) as never);
		try {
			const greeting = cases.FALLTHROUGH_CASES[0] as (typeof cases.FALLTHROUGH_CASES)[number];
			await expect(cases.runSync(cases.inputFor(greeting))).rejects.toThrow(
				"context store unavailable",
			);
			expect(stats().running).toBe(0);
			await expect(cases.runStream(cases.inputFor(greeting))).rejects.toThrow(
				"context store unavailable",
			);
			expect(stats().running).toBe(0);
		} finally {
			failing.mockRestore();
		}
		await expect(service.runAskTurn({ message: "   ", actor: fixture.ASK_ACTOR })).rejects.toThrow(
			"Empty message.",
		);
		expect(stats().running).toBe(0);
	});

	test("a gate-handled turn holds its slot for its whole duration", async () => {
		const c = cases.HANDLED_CASES.find(
			(x) => x.name === "single-session action",
		) as (typeof cases.HANDLED_CASES)[number];
		cases.applyScript(c);
		const release = llm.holdLlmCalls();
		const turn = cases.runSync(cases.inputFor(c));
		await waitFor(() => llm.llmCalls.length > 0, "the classifier call");
		expect(stats().running).toBe(1);
		release();
		await turn;
		expect(stats().running).toBe(0);
	});

	test("a turn run with a slot the caller already holds takes no second slot and does not release it", async () => {
		if (!limiter) throw new Error("no limiter");
		const slot = await limiter.acquireAskTurn();
		const release = llm.holdLlmCalls();
		const turn = service.runAskTurn({ message: "hello there", actor: fixture.ASK_ACTOR, slot });
		await waitFor(() => llm.llmCalls.length > 0, "the first LLM call");
		expect(stats().running).toBe(1);
		release();
		await turn;
		expect(stats().running).toBe(1);
		slot.release();
		slot.release();
		expect(stats().running).toBe(0);
	});

	test("with every place taken a turn is refused before it writes a thread or a message", async () => {
		await saturate();
		await expect(
			service.runAskTurn({ message: "hello there", actor: fixture.ASK_ACTOR }),
		).rejects.toBeInstanceOf(limiter?.AskBusyError ?? Error);
		expect(rows("ask_threads")).toBe(0);
		expect(rows("ask_messages")).toBe(0);
		expect(fixture.embedCalls.length).toBe(0);
		expect(llm.llmCalls.length).toBe(0);
	});

	test("a turn that cannot get a slot waits for one and then runs: oldest waiter first", async () => {
		if (!limiter) throw new Error("no limiter");
		cfg.askMaxConcurrent = 1;
		const slot = await limiter.acquireAskTurn();
		const turn = service.runAskTurn({ message: "hello there", actor: fixture.ASK_ACTOR });
		await waitFor(() => stats().waiting === 1, "the turn to queue");
		expect(rows("ask_messages")).toBe(0);
		slot.release();
		const result = await turn;
		expect(result.assistantMessage.content).toBe("ANSWER");
		expect(stats().running).toBe(0);
	});
});

describeSqliteOnly("the web routes under the limiter", () => {
	test("POST /ai/ask with every place taken answers 503 busy with Retry-After 5", async () => {
		await saturate();
		const res = await post(ROUTES[0], message());
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe("5");
		expect(await res.json()).toEqual({ error: "busy" });
		expect(rows("ask_messages")).toBe(0);
	});

	test("POST /ai/ask/stream with every place taken sends one error frame with a fixed message", async () => {
		await saturate();
		const res = await post(ROUTES[1], message());
		expect(res.status).toBe(200);
		const text = await res.text();
		const frames = text
			.split("\n\n")
			.filter((f) => f.startsWith("data: "))
			.map((f) => JSON.parse(f.slice(6)));
		expect(frames).toEqual([{ kind: "error", message: BUSY_MESSAGE, assistantMessage: null }]);
		expect(rows("ask_messages")).toBe(0);
	});

	test("a stream client that goes away while still queued is removed from the queue", async () => {
		if (!limiter) throw new Error("no limiter");
		held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
		const res = await post(ROUTES[1], message());
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read(); // the stream-open comment
		await waitFor(() => stats().waiting === 1, "the stream to queue");

		await reader.cancel();

		await waitFor(() => stats().waiting === 0, "the waiter to leave");
		expect(stats()).toMatchObject({ running: 2, aborted: 1 });
		expect(rows("ask_messages")).toBe(0);
	});

	test("a stream client that goes away mid-turn keeps the slot until the work settles, then the turn stops and the slot is freed", async () => {
		const release = llm.holdLlmCalls();
		const res = await post(ROUTES[1], message());
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await waitFor(() => llm.llmCalls.length > 0, "the turn to reach the LLM");
		expect(stats().running).toBe(1);

		await reader.cancel();
		await Bun.sleep(30);
		expect(stats().running).toBe(1); // the socket closing does not free the slot

		release();
		await waitFor(() => stats().running === 0, "the slot to be released");
	});

	test("a sync request that disconnects after its turn started still runs to completion, saves the answer and frees the slot", async () => {
		const server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
		try {
			const release = llm.holdLlmCalls();
			const controller = new AbortController();
			const request = fetch(`http://127.0.0.1:${server.port}${ROUTES[0]}`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: message(),
				signal: controller.signal,
			}).catch(() => null);
			await waitFor(() => stats().running === 1 && llm.llmCalls.length > 0, "the turn to start");

			controller.abort();
			await request;
			await Bun.sleep(30);
			expect(stats().running).toBe(1);

			release();
			await waitFor(() => stats().running === 0, "the turn to settle");
			expect(
				(
					getSqlite()
						.prepare("SELECT COUNT(*) AS n FROM ask_messages WHERE role = 'assistant'")
						.get() as { n: number }
				).n,
			).toBe(1);
		} finally {
			server.stop(true);
		}
	}, 15_000);

	test("a real client that disconnects while queued frees its place", async () => {
		if (!limiter) throw new Error("no limiter");
		held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
		const server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
		try {
			const controller = new AbortController();
			const request = fetch(`http://127.0.0.1:${server.port}${ROUTES[0]}`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: message(),
				signal: controller.signal,
			}).catch(() => null);
			await waitFor(() => stats().waiting === 1, "the request to queue");

			controller.abort();
			await request;

			await waitFor(() => stats().waiting === 0, "the place to be freed");
			expect(stats().aborted).toBe(1);
		} finally {
			server.stop(true);
		}
	}, 15_000);
});

describeSqliteOnly("Telegram turns share the limit", () => {
	async function enrolChat(chatId: string) {
		const { createPendingChannel, completeEnrollment } = await import(
			"../services/channels/channels-service.js"
		);
		const credentials = await import("../services/channels/telegram-credentials.js");
		getSqlite().exec("DELETE FROM notification_channels");
		const { channel } = await createPendingChannel({ kind: "telegram", label: "limit test" });
		await completeEnrollment({ channelId: channel.id, chatId });
		await credentials.clearTelegramCredentials();
		(config as Record<string, unknown>).telegramBotToken = "test-token";
		await credentials.refreshTelegramCredentials();
		return credentials;
	}

	async function withTelegramFetch<T>(run: (sent: string[]) => Promise<T>): Promise<T> {
		const sent: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			if (String(url).endsWith("/sendMessage")) {
				sent.push((JSON.parse(String(init?.body ?? "{}")) as { text: string }).text);
			}
			return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
		}) as typeof fetch;
		try {
			return await run(sent);
		} finally {
			globalThis.fetch = realFetch;
		}
	}

	const update = (text: string) =>
		({ update_id: 1, message: { message_id: 1, chat: { id: 4242 }, text } }) as never;

	test("a Telegram turn takes a slot like any other, so scans and LLM calls are bounded for every caller", async () => {
		const credentials = await enrolChat("4242");
		const { handleTelegramUpdate } = await import("./channels.js");
		try {
			await withTelegramFetch(async (sent) => {
				const release = llm.holdLlmCalls();
				const handled = handleTelegramUpdate(update("hello there"));
				await waitFor(() => llm.llmCalls.length > 0, "the Telegram turn to reach the LLM");
				expect(stats().running).toBe(1);
				release();
				await handled;
				expect(stats().running).toBe(0);
				expect(sent).toEqual(["ANSWER"]);
			});
		} finally {
			(config as Record<string, unknown>).telegramBotToken = "";
			await credentials.refreshTelegramCredentials();
		}
	});

	test("with every slot taken and the queue full for 30 s the chat gets the fixed busy reply and no turn runs", async () => {
		if (!limiter) throw new Error("no limiter");
		const credentials = await enrolChat("4242");
		const { handleTelegramUpdate } = await import("./channels.js");
		const { ASK_BUSY_REPLY } = await import("../services/channels/telegram-replies.js");
		const clock = createFakeClock();
		limiter.__setAskLimiterClockForTests({
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		held.push(await limiter.acquireAskTurn(), await limiter.acquireAskTurn());
		try {
			await withTelegramFetch(async (sent) => {
				const handled = handleTelegramUpdate(update("hello there"));
				await waitFor(() => stats().waiting === 1, "the Telegram turn to queue");
				clock.advance(30_000);
				await handled;
				expect(sent).toEqual([ASK_BUSY_REPLY]);
				expect(rows("ask_messages")).toBe(0);
				expect(llm.llmCalls.length).toBe(0);
				expect(fixture.embedCalls.length).toBe(0);
				expect(stats().waiting).toBe(0);
			});
		} finally {
			(config as Record<string, unknown>).telegramBotToken = "";
			await credentials.refreshTelegramCredentials();
		}
	});
});

describeSqliteOnly("the Ask POST routes refuse an over-long body before parsing it", () => {
	for (const route of ROUTES) {
		describe(route, () => {
			test("a Content-Length over 256 KiB answers 413 and the body is never read", async () => {
				const counter = { pulls: 0 };
				const res = await post(route, chunkedStream(300 * 1024, 16 * 1024, counter), {
					"content-length": String(300 * 1024),
				});
				expect(res.status).toBe(413);
				expect(await res.json()).toEqual({ error: "payload_too_large" });
				expect(counter.pulls).toBe(0);
				expect(rows("ask_messages")).toBe(0);
			});

			test("a chunked body over 256 KiB answers 413 after reading at most the cap plus one chunk", async () => {
				const counter = { pulls: 0 };
				const res = await post(route, chunkedStream(300 * 1024, 16 * 1024, counter));
				expect(res.status).toBe(413);
				expect(counter.pulls).toBeLessThanOrEqual(BODY_LIMIT / (16 * 1024) + 2);
				expect(rows("ask_messages")).toBe(0);
			});

			test("exactly 262,144 bytes is accepted and 262,145 is refused, by Content-Length and chunked alike", async () => {
				const sized = (bytes: number) => ({ body: bodyOfSize(bytes), length: String(bytes) });
				const ok = sized(BODY_LIMIT);
				const okRes = await post(route, ok.body, { "content-length": ok.length });
				expect(okRes.status).toBe(200);
				await okRes.text();

				const over = sized(BODY_LIMIT + 1);
				expect((await post(route, over.body, { "content-length": over.length })).status).toBe(413);

				const chunkedOk = await post(route, chunkedStream(BODY_LIMIT, 16 * 1024, { pulls: 0 }));
				expect(chunkedOk.status).toBe(200);
				await chunkedOk.text();
				const chunkedOver = await post(
					route,
					chunkedStream(BODY_LIMIT + 1, 16 * 1024, { pulls: 0 }),
				);
				expect(chunkedOver.status).toBe(413);
			});

			test("malformed JSON is a 400; an overrun is a 413 and is not swallowed into a 400", async () => {
				const bad = await post(route, "{not json");
				expect(bad.status).toBe(400);
				const overrun = await post(route, chunkedStream(BODY_LIMIT + 2, 16 * 1024, { pulls: 0 }));
				expect(overrun.status).toBe(413);
			});
		});
	}

	test("a lying Content-Length never gets a 200: Bun frames the body by the header, so the 10 bytes it reads are bad JSON and the rest is not a request", async () => {
		const server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
		try {
			const head = [
				`POST ${ROUTES[0]} HTTP/1.1`,
				"Host: localhost",
				`Authorization: Bearer ${key}`,
				"Content-Type: application/json",
				"Content-Length: 10",
				"Connection: close",
				"",
				"",
			].join("\r\n");
			let received = "";
			const done = Promise.withResolvers<void>();
			const socket = await Bun.connect({
				hostname: "127.0.0.1",
				port: server.port as number,
				socket: {
					data(_s, data) {
						received += Buffer.from(data).toString("utf8");
					},
					close() {
						done.resolve();
					},
					error() {
						done.resolve();
					},
				},
			});
			socket.write(head + "x".repeat(300 * 1024));
			await Promise.race([done.promise, Bun.sleep(3_000)]);
			socket.end();
			const status = Number(received.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
			expect(status).toBeGreaterThanOrEqual(400);
			expect(status).toBeLessThan(500);
		} finally {
			server.stop(true);
		}
	}, 15_000);

	test("bodyLimit is registered ahead of both Ask POST handlers", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./ask.ts", import.meta.url), "utf8");
		expect(source).toMatch(/askRouter\.post\("\/ai\/ask", askBodyLimit,/);
		expect(source).toMatch(/askRouter\.post\("\/ai\/ask\/stream", askBodyLimit,/);
		expect(source).toMatch(/bodyLimit\(\{[\s\S]*maxSize:/);
	});
});
