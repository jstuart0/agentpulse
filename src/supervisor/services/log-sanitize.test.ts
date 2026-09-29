/**
 * F49 (2026-09-29-deliver-supervisor-auth-routing, xander spot check):
 * bound and sanitize the server's status text / JSON error body before
 * either is logged.
 */
import { describe, expect, test } from "bun:test";
import {
	MAX_ERROR_BODY_BYTES,
	MAX_LOG_STRING_LENGTH,
	parseErrorBodyField,
	readBoundedText,
	sanitizeForLog,
} from "./log-sanitize.js";

describe("sanitizeForLog", () => {
	test("strips ANSI CSI escape sequences", () => {
		expect(sanitizeForLog("\u001b[31mred text\u001b[0m")).toBe("red text");
	});

	test("strips newlines and other control characters (forged log-line injection)", () => {
		expect(sanitizeForLog("line one\nFAKE LOG LINE: admin login succeeded")).toBe(
			"line oneFAKE LOG LINE: admin login succeeded",
		);
	});

	test("strips a bare ESC with no complete CSI sequence", () => {
		expect(sanitizeForLog("before\u001bafter")).toBe("beforeafter");
	});

	test("truncates to 200 characters", () => {
		const long = "a".repeat(500);
		const result = sanitizeForLog(long);
		expect(result.length).toBe(MAX_LOG_STRING_LENGTH);
		expect(result).toBe("a".repeat(200));
	});

	test("leaves an already-safe short string unchanged", () => {
		expect(sanitizeForLog("insufficient_scope")).toBe("insufficient_scope");
	});
});

describe("readBoundedText", () => {
	test("reads the whole body when it's under the cap", async () => {
		const res = new Response("hello world");
		expect(await readBoundedText(res, 1024)).toBe("hello world");
	});

	test("stops reading at the cap for an oversized body — bounded memory, not buffer-then-truncate", async () => {
		const oversized = "x".repeat(MAX_ERROR_BODY_BYTES * 4);
		const res = new Response(oversized);
		const text = await readBoundedText(res, MAX_ERROR_BODY_BYTES);
		expect(text.length).toBeLessThanOrEqual(MAX_ERROR_BODY_BYTES);
		expect(text.length).toBeGreaterThan(0);
	});

	test("an empty body reads as an empty string", async () => {
		const res = new Response(null, { status: 500 });
		expect(await readBoundedText(res)).toBe("");
	});
});

describe("parseErrorBodyField", () => {
	test("extracts and sanitizes the error field from a small JSON body", async () => {
		const res = new Response(JSON.stringify({ error: "insufficient_scope" }));
		expect(await parseErrorBodyField(res)).toBe("insufficient_scope");
	});

	test("sanitizes an ANSI/newline injection in the error field", async () => {
		const res = new Response(JSON.stringify({ error: "\u001b[31mfake\u001b[0m\nFORGED LOG LINE" }));
		expect(await parseErrorBodyField(res)).toBe("fakeFORGED LOG LINE");
	});

	test("returns undefined for a non-JSON body", async () => {
		const res = new Response("not json");
		expect(await parseErrorBodyField(res)).toBeUndefined();
	});

	test("returns undefined when error isn't a string", async () => {
		const res = new Response(JSON.stringify({ error: { nested: true } }));
		expect(await parseErrorBodyField(res)).toBeUndefined();
	});

	test("returns undefined, doesn't throw, for an oversized body that truncates into invalid JSON", async () => {
		const oversized = JSON.stringify({ error: "x".repeat(MAX_ERROR_BODY_BYTES * 4) });
		const res = new Response(oversized);
		await expect(parseErrorBodyField(res)).resolves.toBeUndefined();
	});

	test("an empty body returns undefined", async () => {
		const res = new Response(null, { status: 500 });
		expect(await parseErrorBodyField(res)).toBeUndefined();
	});
});
