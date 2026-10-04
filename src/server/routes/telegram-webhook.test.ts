/**
 * The public Telegram webhook: the shared secret is checked first and in
 * constant time; only after it passes is the body read, capped at 1 MiB; and a
 * body-limit error is a 413, never swallowed into a 200.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { describeSqliteOnly, isSqliteTest } from "../test-utils/backend.js";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const { app } = await import("../app.js");
const credentials = await import("../services/channels/telegram-credentials.js");

const PATH = "/api/v1/channels/telegram/webhook";
const SECRET = "correct-horse-battery-staple-0123456789";
const MIB = 1_048_576;
const cfg = config as unknown as Record<string, string>;
const original = { token: cfg.telegramBotToken, secret: cfg.telegramWebhookSecret };

let sent: string[] = [];
let realFetch: typeof fetch;

/** An update the handler answers with exactly one sendMessage: an invalid enrolment code. */
const probe = (n = 1) =>
	JSON.stringify({
		update_id: n,
		message: { message_id: 1, chat: { id: 7 }, text: "/start NOSUCHCODE" },
	});

function post(
	body: BodyInit | null,
	headers: Record<string, string> = {},
	secret: string | null = SECRET,
) {
	return app.request(PATH, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }),
			...headers,
		},
		body,
		// biome-ignore lint/suspicious/noExplicitAny: Bun's Request accepts duplex for stream bodies
		...({ duplex: "half" } as any),
	});
}

function chunked(total: number, counter: { pulls: number }) {
	let sentBytes = 0;
	const first = new TextEncoder().encode(probe());
	const pad = new TextEncoder().encode(" ".repeat(16 * 1024));
	return new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				counter.pulls++;
				if (sentBytes === 0) {
					controller.enqueue(first);
					sentBytes += first.length;
					return;
				}
				if (sentBytes >= total) return controller.close();
				const n = Math.min(pad.length, total - sentBytes);
				controller.enqueue(pad.subarray(0, n));
				sentBytes += n;
			},
		},
		{ highWaterMark: 0 },
	);
}

beforeAll(async () => {
	if (!isSqliteTest) return;
	await initializeDatabase();
});
afterAll(async () => {
	if (!isSqliteTest) return;
	cfg.telegramBotToken = original.token as string;
	cfg.telegramWebhookSecret = original.secret as string;
	await credentials.refreshTelegramCredentials();
});
beforeEach(async () => {
	if (!isSqliteTest) return;
	await credentials.clearTelegramCredentials();
	cfg.telegramBotToken = "test-token";
	cfg.telegramWebhookSecret = SECRET;
	await credentials.refreshTelegramCredentials();
	sent = [];
	realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (String(url).endsWith("/sendMessage")) sent.push(String(init?.body ?? ""));
		return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
	}) as typeof fetch;
});
afterEach(() => {
	if (!isSqliteTest) return;
	globalThis.fetch = realFetch;
});

describeSqliteOnly("the shared secret", () => {
	test("the right secret reaches the handler", async () => {
		const res = await post(probe());
		expect(res.status).toBe(200);
		expect(sent.length).toBe(1);
	});

	test("a wrong value of the same length, a shorter, a longer, an empty and a missing secret are all 401 and the handler never runs", async () => {
		const wrongSameLength = `${SECRET.slice(0, -1)}X`;
		for (const secret of [wrongSameLength, SECRET.slice(0, 5), `${SECRET}extra`, "", null]) {
			const res = await post(probe(), {}, secret);
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "invalid secret" });
		}
		expect(sent.length).toBe(0);
	});

	test("with no bot token the route is 404, and with no secret configured it is 401", async () => {
		cfg.telegramBotToken = "";
		await credentials.refreshTelegramCredentials();
		expect((await post(probe())).status).toBe(404);
		cfg.telegramBotToken = "test-token";
		cfg.telegramWebhookSecret = "";
		await credentials.refreshTelegramCredentials();
		expect((await post(probe(), {}, "anything")).status).toBe(401);
	});

	test("the comparison is constant-time: a length guard and timingSafeEqual, no !== on the secret", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./channels.ts", import.meta.url), "utf8");
		expect(source).toContain("timingSafeEqual");
		expect(source).not.toMatch(/providedSecret\s*!==/);
	});
});

describeSqliteOnly("the body cap, applied after the secret", () => {
	test("a Content-Length over 1 MiB is 413 and the body is never read", async () => {
		const counter = { pulls: 0 };
		const res = await post(chunked(MIB + 1, counter), { "content-length": String(MIB + 1) });
		expect(res.status).toBe(413);
		expect(counter.pulls).toBe(0);
		expect(sent.length).toBe(0);
	});

	test("a chunked body over 1 MiB with no Content-Length is 413, not a swallowed 200", async () => {
		const res = await post(chunked(MIB + 1, { pulls: 0 }));
		expect(res.status).toBe(413);
		expect(sent.length).toBe(0);
	});

	test("exactly 1 MiB is accepted, by Content-Length and chunked alike", async () => {
		const padded = probe() + " ".repeat(MIB - probe().length);
		const byLength = await post(padded, { "content-length": String(MIB) });
		expect(byLength.status).toBe(200);
		expect(sent.length).toBe(1);
		const byChunks = await post(chunked(MIB, { pulls: 0 }));
		expect(byChunks.status).toBe(200);
		expect(sent.length).toBe(2);
	});

	test("an oversize body without the secret is still a 401 and is never read", async () => {
		const counter = { pulls: 0 };
		const res = await post(
			chunked(2 * MIB, counter),
			{ "content-length": String(2 * MIB) },
			"wrong",
		);
		expect(res.status).toBe(401);
		expect(counter.pulls).toBe(0);
		const noLength = await post(chunked(2 * MIB, counter), {}, null);
		expect(noLength.status).toBe(401);
		expect(counter.pulls).toBe(0);
	});

	test("a body that is not JSON is acknowledged with 200 as before, and nothing is sent", async () => {
		const res = await post("{not json");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(sent.length).toBe(0);
	});
});
