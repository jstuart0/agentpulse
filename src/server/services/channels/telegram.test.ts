/**
 * Slice CLEANUP-1 (M-3) — telegram-helper dedup.
 *
 * Asserts the canonical `sendTelegramMessage(botToken, chatId, text, opts?)`
 * helper:
 *   1. POSTs to https://api.telegram.org/bot<token>/sendMessage with the
 *      expected JSON body shape (chat_id + text).
 *   2. Falls through silently when the bot token is empty.
 *   3. Splits oversize text into ≤3800-char chunks when chunkSplit=true,
 *      issuing one POST per chunk. (Telegram caps sendMessage.text at 4096.)
 *   4. Sends the full text as a single POST when chunkSplit is omitted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sendTelegramMessage } from "./telegram.js";

interface CapturedCall {
	url: string;
	method: string;
	body: { chat_id: string | number; text: string };
}

const originalFetch = globalThis.fetch;
let calls: CapturedCall[] = [];

beforeEach(() => {
	calls = [];
	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({
			url,
			method: init?.method ?? "GET",
			body: JSON.parse(String(init?.body ?? "{}")),
		});
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
				headers: { "Content-Type": "application/json" },
			}),
		);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("sendTelegramMessage", () => {
	test("POSTs to api.telegram.org with chat_id + text", async () => {
		await sendTelegramMessage("test-token-123", "456", "hello world");
		expect(calls.length).toBe(1);
		expect(calls[0].url).toBe("https://api.telegram.org/bottest-token-123/sendMessage");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body.chat_id).toBe("456");
		expect(calls[0].body.text).toBe("hello world");
	});

	test("accepts numeric chat_id", async () => {
		await sendTelegramMessage("test-token", 12345, "hi");
		expect(calls[0].body.chat_id).toBe(12345);
	});

	test("no-ops when botToken is empty", async () => {
		await sendTelegramMessage("", "456", "hello world");
		expect(calls.length).toBe(0);
	});

	test("sends one chunk for short text even with chunkSplit=true", async () => {
		await sendTelegramMessage("tok", "1", "short message", { chunkSplit: true });
		expect(calls.length).toBe(1);
		expect(calls[0].body.text).toBe("short message");
	});

	test("splits oversize text into multiple chunks when chunkSplit=true", async () => {
		// 8000-char string with newlines so the splitter has natural break points.
		const block = "abcdefghij".repeat(100); // 1000 chars
		const text = `${block}\n${block}\n${block}\n${block}\n${block}\n${block}\n${block}\n${block}`;
		expect(text.length).toBeGreaterThan(7900);

		await sendTelegramMessage("tok", "1", text, { chunkSplit: true });

		expect(calls.length).toBeGreaterThanOrEqual(2);
		// Every chunk should fit Telegram's 4096-char cap.
		for (const c of calls) {
			expect(c.body.text.length).toBeLessThanOrEqual(4096);
		}
		// Reassembled chunks should cover the full original text length
		// (whitespace at the cut point may be normalised, so >= original - chunks).
		const total = calls.reduce((n, c) => n + c.body.text.length, 0);
		expect(total).toBeGreaterThan(text.length - calls.length);
	});

	test("does NOT split text when chunkSplit is omitted", async () => {
		const longText = "x".repeat(5000);
		await sendTelegramMessage("tok", "1", longText);
		// Single POST; the caller is responsible for any size limits.
		expect(calls.length).toBe(1);
		expect(calls[0].body.text.length).toBe(5000);
	});
});
