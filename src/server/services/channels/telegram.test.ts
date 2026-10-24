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
import { createHash } from "node:crypto";
import { escapeMd, formatHitlMessage, sendTelegramMessage } from "./telegram.js";
import type { SendChannelMessageInput } from "./types.js";

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

// ── HITL message formatting ───────────────────────────────────────────────────

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const RLO = String.fromCodePoint(0x202e);
const TICKS = "```";

function message(over: Partial<SendChannelMessageInput> = {}): SendChannelMessageInput {
	const prompt = over.prompt ?? "Run the failing test and fix it";
	return {
		hitlId: "h1",
		proposalId: "p1",
		sessionId: "session-12345678",
		sessionDisplayName: "my session",
		decision: "continue",
		prompt,
		why: null,
		deliverable: true,
		approvable: true,
		promptSha256: sha(prompt),
		detail: "full",
		sessionCwd: null,
		...over,
	};
}

describe("formatHitlMessage", () => {
	test("full detail shows the prompt in a fence with the backtick and backslash escaped, so it can't close the fence", () => {
		const prompt = `Replace ${TICKS} and a back\\slash`;
		const out = formatHitlMessage(message({ prompt, promptSha256: sha(prompt) }));
		const fenceBody = out.text.split("\n").slice(-2)[0] ?? "";
		expect(fenceBody).toBe("Replace \\`\\`\\` and a back\\\\slash");
		expect(out.text.match(/```/g)).toHaveLength(2); // only the real fence
	});

	test("escapeMd escapes the backslash as well as the MarkdownV2 set", () => {
		expect(escapeMd("a\\b")).toBe("a\\\\b");
		expect(escapeMd("a_b*c")).toBe("a\\_b\\*c");
	});

	test("a label with a bidi override has it stripped", () => {
		const out = formatHitlMessage(message({ sessionDisplayName: `ops${RLO}evil` }));
		expect(out.text).not.toContain(RLO);
		expect(out.text).toContain("opsevil");
	});

	test("a planted path and token are redacted, and because the display changed there is no Approve", () => {
		const prompt =
			"Fix /Users/x/secret/notes.txt using token sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
		const out = formatHitlMessage(message({ prompt, promptSha256: sha(prompt) }));
		expect(out.text).toContain("~/secret/notes.txt");
		expect(out.text).not.toContain("/Users/x");
		expect(out.text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
		expect(out.approvable).toBe(false);
	});

	test("the working directory is shown as <repo>", () => {
		const prompt = "Open /srv/work/app/src/index.ts";
		const out = formatHitlMessage(
			message({ prompt, promptSha256: sha(prompt), sessionCwd: "/srv/work/app" }),
		);
		expect(out.text).toContain("<repo>/src/index.ts");
	});

	test("an unaltered 1,500-character prompt shows Approve; a 3,001-character one does not", () => {
		const short = `Run ${"a".repeat(1_496)}`;
		expect(short).toHaveLength(1_500);
		expect(formatHitlMessage(message({ prompt: short, promptSha256: sha(short) })).approvable).toBe(
			true,
		);
		const long = `Run ${"a".repeat(2_997)}`;
		expect(long).toHaveLength(3_001);
		const out = formatHitlMessage(message({ prompt: long, promptSha256: sha(long) }));
		expect(out.approvable).toBe(false);
		expect(out.text.length).toBeLessThan(4_096);
	});

	test("minimal detail carries no prompt text and no Approve", () => {
		const out = formatHitlMessage(message({ detail: "minimal" }));
		expect(out.text).not.toContain("failing test");
		expect(out.text).toContain("dashboard");
		expect(out.approvable).toBe(false);
	});

	test("not deliverable, not approvable, or a hash that no longer matches each remove Approve", () => {
		expect(formatHitlMessage(message({ deliverable: false })).approvable).toBe(false);
		expect(formatHitlMessage(message({ approvable: false })).approvable).toBe(false);
		expect(formatHitlMessage(message({ promptSha256: sha("something else") })).approvable).toBe(
			false,
		);
		expect(formatHitlMessage(message()).approvable).toBe(true);
	});

	test("the session label and why are redacted too", () => {
		const out = formatHitlMessage(
			message({
				sessionDisplayName: "deploy sk-ant-abcdefghijklmnopqrstuvwxyz0123456789",
				why: "see /home/jo/notes",
			}),
		);
		expect(out.text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
		expect(out.text).not.toContain("/home/jo");
	});
});
