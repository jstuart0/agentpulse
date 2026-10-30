import { describe, expect, test } from "bun:test";
import { NOTIFY_WHY_MAX_CHARS, cleanWhy, parseNotifyAnswer } from "./output.js";

const IDS = new Map<string, unknown>([
	["E1", {}],
	["E2", {}],
	["E3", {}],
	["E4", {}],
]);
const NONCE = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const answer = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		verdict: "finished",
		why: "The agent finished the change.",
		evidence: ["E1"],
		...over,
	});

describe("parseNotifyAnswer", () => {
	test("a valid answer parses, with its verdict, note and cited ids", () => {
		expect(parseNotifyAnswer(answer({ evidence: ["E1", "E2"] }), NONCE, IDS)).toEqual({
			ok: true,
			verdict: "finished",
			why: "The agent finished the change.",
			evidence: ["E1", "E2"],
		});
	});

	test("a code fence, a think block and prose around the object are tolerated", () => {
		const fenced = `\`\`\`json\n${answer()}\n\`\`\``;
		const thought = `<think>hmm</think>\n${answer({ verdict: "stuck" })}`;
		const chatty = `Sure! ${answer({ verdict: "needs_you" })} Hope that helps.`;
		expect(parseNotifyAnswer(fenced, NONCE, IDS).ok).toBe(true);
		expect(parseNotifyAnswer(thought, NONCE, IDS)).toMatchObject({ ok: true, verdict: "stuck" });
		expect(parseNotifyAnswer(chatty, NONCE, IDS)).toMatchObject({ ok: true, verdict: "needs_you" });
	});

	test("the fence nonce is scrubbed before anything is read", () => {
		const raw = answer({ why: `Done ${NONCE} and dusted.` });
		expect(parseNotifyAnswer(raw, NONCE, IDS)).toMatchObject({
			ok: true,
			why: "Done  and dusted.",
		});
	});

	test("an unknown verdict, a missing field and non-JSON are parse failures", () => {
		for (const raw of [
			answer({ verdict: "done" }),
			answer({ verdict: undefined }),
			answer({ why: undefined }),
			answer({ evidence: undefined }),
			"not json at all",
			"",
			"[]",
			"null",
		]) {
			expect(parseNotifyAnswer(raw, NONCE, IDS), raw).toEqual({ ok: false, code: "parse" });
		}
	});

	test("zero or more than three evidence ids is a parse failure; a malformed id too", () => {
		expect(parseNotifyAnswer(answer({ evidence: [] }), NONCE, IDS)).toEqual({
			ok: false,
			code: "parse",
		});
		expect(parseNotifyAnswer(answer({ evidence: ["E1", "E2", "E3", "E4"] }), NONCE, IDS)).toEqual({
			ok: false,
			code: "parse",
		});
		expect(parseNotifyAnswer(answer({ evidence: ["e1"] }), NONCE, IDS)).toEqual({
			ok: false,
			code: "parse",
		});
		expect(parseNotifyAnswer(answer({ evidence: ["E1; rm -rf /"] }), NONCE, IDS)).toEqual({
			ok: false,
			code: "parse",
		});
	});

	test("an id the ledger never printed is a citation failure, even when others are real", () => {
		expect(parseNotifyAnswer(answer({ evidence: ["E1", "E99"] }), NONCE, IDS)).toEqual({
			ok: false,
			code: "citation",
		});
	});

	test("a repeated id is cited once", () => {
		expect(parseNotifyAnswer(answer({ evidence: ["E1", "E1"] }), NONCE, IDS)).toMatchObject({
			ok: true,
			evidence: ["E1"],
		});
	});

	test("a Set of ids works as well as a Map", () => {
		expect(parseNotifyAnswer(answer(), NONCE, new Set(["E1"])).ok).toBe(true);
		expect(parseNotifyAnswer(answer(), NONCE, new Set(["E2"]))).toEqual({
			ok: false,
			code: "citation",
		});
	});

	test("a note over the limit or over two lines is refused, never cut", () => {
		expect(
			parseNotifyAnswer(answer({ why: "x".repeat(NOTIFY_WHY_MAX_CHARS + 1) }), NONCE, IDS),
		).toEqual({
			ok: false,
			code: "parse",
		});
		expect(parseNotifyAnswer(answer({ why: "one\ntwo\nthree" }), NONCE, IDS)).toEqual({
			ok: false,
			code: "parse",
		});
		expect(
			parseNotifyAnswer(answer({ why: "x".repeat(NOTIFY_WHY_MAX_CHARS) }), NONCE, IDS).ok,
		).toBe(true);
		expect(parseNotifyAnswer(answer({ why: "one\ntwo" }), NONCE, IDS)).toMatchObject({
			ok: true,
			why: "one\ntwo",
		});
	});
});

describe("cleanWhy", () => {
	test("bidi, zero-width and control characters are removed; lines are trimmed; blank lines dropped", () => {
		const rlo = String.fromCodePoint(0x202e);
		const zwsp = String.fromCodePoint(0x200b);
		const esc = String.fromCodePoint(0x1b);
		expect(cleanWhy(`  a${rlo}b${zwsp}c${esc}  \n\n  d  `)).toBe("abc\nd");
	});

	test("an empty note is refused", () => {
		expect(cleanWhy("")).toBeNull();
		expect(cleanWhy(" \n \t ")).toBeNull();
		expect(cleanWhy(String.fromCodePoint(0x200b))).toBeNull();
	});

	test("a line separator is a line break, so it counts toward the two-line limit", () => {
		const ls = String.fromCodePoint(0x2028);
		expect(cleanWhy(`a${ls}b${ls}c`)).toBeNull();
	});
});
