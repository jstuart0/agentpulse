/**
 * Tests for output.ts — output-cap helpers (AGEN-12 Phase 2, D5).
 *
 * Pure functions, no mocking. Test contract assertions 17-23.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAR_BUDGET, capList, capText, capToolResult } from "./output.js";

describe("capList", () => {
	test("list under budget returns unchanged, no truncation marker", () => {
		const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
		const result = capList(items);
		expect(result.items).toEqual(items);
		expect(result.hint).toBeUndefined();
	});

	test("list exceeding budget drops tail and appends a correct offset marker", () => {
		// Each item serializes to ~22 chars (`{"id":0,"pad":"xxxx"}`). Budget
		// of 100 chars should keep roughly 4 items and drop the rest.
		const items = Array.from({ length: 20 }, (_, i) => ({ id: i, pad: "xxxx" }));
		const result = capList(items, { budget: 100 });
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items.length).toBeLessThan(items.length);
		expect(result.hint).toBeDefined();
		const droppedCount = items.length - result.items.length;
		expect(result.hint).toContain(`…${droppedCount} more`);
		expect(result.hint).toContain(`offset=${result.items.length}`);
		// Pin the numbers, not just the marker's presence.
		expect(result.items).toEqual(items.slice(0, result.items.length));
	});

	test("empty list returns empty, no marker, no crash", () => {
		const result = capList([]);
		expect(result.items).toEqual([]);
		expect(result.hint).toBeUndefined();
	});

	test("single oversized element does not infinite-loop or drop to zero items", () => {
		const hugeItem = { blob: "x".repeat(DEFAULT_CHAR_BUDGET * 2) };
		const result = capList([hugeItem], { budget: 100 });
		expect(result.items.length).toBe(1);
		expect(result.items[0]).toEqual(hugeItem);
		expect(result.hint).toBeDefined();
	});

	test("first oversized element among several still yields a continuation hint for the rest", () => {
		const hugeItem = { blob: "x".repeat(500) };
		const items = [hugeItem, { id: 1 }, { id: 2 }, { id: 3 }];
		const result = capList(items, { budget: 100 });
		expect(result.items.length).toBe(1);
		expect(result.items[0]).toEqual(hugeItem);
		expect(result.hint).toContain("…3 more");
		expect(result.hint).toContain("offset=1");
	});

	test("respects a supplied offset when computing the continuation hint", () => {
		const items = Array.from({ length: 20 }, (_, i) => ({ id: i, pad: "xxxx" }));
		const result = capList(items, { budget: 100, offset: 40 });
		const droppedCount = items.length - result.items.length;
		expect(result.hint).toContain(`…${droppedCount} more`);
		expect(result.hint).toContain(`offset=${40 + result.items.length}`);
	});
});

describe("capText", () => {
	test("string under the cap is unchanged", () => {
		const text = "hello world";
		expect(capText(text, 100)).toBe(text);
	});

	test("string over the cap is truncated with a marker", () => {
		const text = "x".repeat(1000);
		const result = capText(text, 100);
		expect(result.length).toBeLessThan(text.length);
		expect(result.length).toBeLessThanOrEqual(101);
		expect(result.endsWith("…")).toBe(true);
	});

	test("truncation is UTF-8-safe across a multi-byte boundary (emoji)", () => {
		// Each emoji here is a surrogate pair (2 UTF-16 code units). Force the
		// cap to land exactly between a high/low surrogate pair and confirm
		// the result never contains an unpaired surrogate.
		const text = `${"a".repeat(49)}😀${"b".repeat(50)}`; // surrogate pair straddles index 49/50
		const result = capText(text, 50);
		for (let i = 0; i < result.length; i++) {
			const code = result.charCodeAt(i);
			const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
			if (isHighSurrogate) {
				const next = result.charCodeAt(i + 1);
				expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
			}
		}
		// Round-trip through JSON to prove it's not a broken/lone surrogate.
		expect(() => JSON.stringify(result)).not.toThrow();
	});

	test("CJK text truncates cleanly without throwing", () => {
		const text = "文".repeat(200);
		expect(() => capText(text, 50)).not.toThrow();
		const result = capText(text, 50);
		expect(result.length).toBeLessThanOrEqual(51);
	});

	test("secret-shaped content passes through verbatim when under the cap (no redaction)", () => {
		const text =
			'Bearer ap_fakeTokenForTestingOnly123 and a stray "Bearer xyz" in tool_input preview';
		expect(capText(text, 500)).toBe(text);
	});
});

describe("capToolResult", () => {
	test("under-budget result passes through unchanged", () => {
		const result = { activeSessions: 1 };
		expect(capToolResult(result, DEFAULT_CHAR_BUDGET)).toBe(result);
	});

	test("oversized top-level array is capped via capList", () => {
		const items = Array.from({ length: 500 }, (_, i) => ({ id: i, pad: "x".repeat(50) }));
		const capped = capToolResult(items, 2000) as { items: unknown[]; _truncated: string };
		expect(capped.items.length).toBeLessThan(items.length);
		expect(capped._truncated).toContain("more");
	});

	test("oversized object with an array-valued field caps that field, preserves other keys", () => {
		const payload = {
			total: 500,
			sessions: Array.from({ length: 500 }, (_, i) => ({ id: i, pad: "x".repeat(50) })),
		};
		const capped = capToolResult(payload, 2000) as {
			total: number;
			sessions: unknown[];
			_truncated?: string;
		};
		expect(capped.total).toBe(500);
		expect(capped.sessions.length).toBeLessThan(payload.sessions.length);
		expect(capped._truncated).toBeDefined();
	});

	test("oversized envelope with MULTIPLE co-large array fields caps EVERY oversized array, total stays within budget (dexter High — inbox-shaped multi-array under-capping regression)", () => {
		// Mirrors the Phase 3 get_inbox shape: a discriminated-union envelope
		// with several independently-large array fields. A one-shot
		// "cap only the single largest array" strategy would leave the
		// other three untouched and could still blow the budget.
		const makeArray = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ id: i, pad: "x".repeat(60) }));
		const payload = {
			hitl: makeArray(200),
			stuck: makeArray(180),
			risky: makeArray(150),
			failed: makeArray(120),
		};
		const fullSize = JSON.stringify(payload).length;
		const budget = 4000;
		expect(fullSize).toBeGreaterThan(budget * 4); // sanity: genuinely oversized on every field

		const capped = capToolResult(payload, budget) as {
			hitl: unknown[];
			stuck: unknown[];
			risky: unknown[];
			failed: unknown[];
			_truncated?: string;
		};

		// The core regression assertion: total serialized output fits the budget.
		expect(JSON.stringify(capped).length).toBeLessThanOrEqual(budget);

		// Every array that started oversized relative to its own fair share
		// must actually have been reduced — not just the largest one.
		expect(capped.hitl.length).toBeLessThan(payload.hitl.length);
		expect(capped.stuck.length).toBeLessThan(payload.stuck.length);
		expect(capped.risky.length).toBeLessThan(payload.risky.length);
		expect(capped.failed.length).toBeLessThan(payload.failed.length);
	});

	test("a single oversized SCALAR STRING field is truncated with a marker, NOT dropped (dexter Med — real bug fixed mid-build)", () => {
		// Before this fix: capToolResult's fallback only handled ARRAY
		// fields — an object shaped like get_session_claude_md's result
		// ({content, path, checksum, updatedAt}) with an oversized `content`
		// string had no array to cap, so it fell straight to the generic
		// {truncated,note,originalSizeChars} summary — the actual content was
		// silently DROPPED, not truncated. This must now truncate instead.
		const payload = { content: "x".repeat(5000), path: "CLAUDE.md", checksum: "abc" };
		const capped = capToolResult(payload, 1000) as {
			content: string;
			path: string;
			checksum: string;
			truncated?: boolean;
			_truncated?: string;
		};
		expect(capped.truncated).toBeUndefined();
		expect(capped.content).toBeDefined();
		expect(capped.content.length).toBeGreaterThan(0);
		expect(capped.content.length).toBeLessThan(payload.content.length);
		expect(capped.path).toBe("CLAUDE.md");
		expect(capped._truncated).toContain("content");
	});

	test("oversized envelope with a genuinely non-cappable field (nested object, not array/string) falls back to a truncated summary, never silently drops without explanation", () => {
		const payload = { blob: { nested: "x".repeat(5000) } };
		const capped = capToolResult(payload, 100) as { truncated: boolean; originalSizeChars: number };
		expect(capped.truncated).toBe(true);
		expect(capped.originalSizeChars).toBeGreaterThan(100);
	});
});
