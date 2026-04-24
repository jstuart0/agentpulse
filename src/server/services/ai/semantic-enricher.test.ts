import { describe, expect, test } from "bun:test";
import { parseExpansion } from "./semantic-enricher.js";

describe("parseExpansion", () => {
	test("parses a clean comma-separated list", () => {
		const out = parseExpansion("coupled, coupling, decouple, refactor, modular");
		expect(out).toEqual(["coupled", "coupling", "decouple", "refactor", "modular"]);
	});

	test("strips preamble before the first colon", () => {
		const out = parseExpansion("Sure! Here are the terms: auth, oauth, sso, login");
		expect(out).toEqual(["auth", "oauth", "sso", "login"]);
	});

	test("strips numbered / bulleted prefixes", () => {
		const out = parseExpansion("1. coupled\n2) coupling\n- decouple\n* refactor");
		expect(out).toEqual(["coupled", "coupling", "decouple", "refactor"]);
	});

	test("drops length 0/1 and excessive terms, dedupes", () => {
		const out = parseExpansion("x, ok, ok, a, b, test, test, ship, ship");
		// 'x', 'a', 'b' are length 1 → dropped; duplicates collapse.
		expect(out).toEqual(["ok", "test", "ship"]);
	});

	test("strips quotes and parentheticals inside terms", () => {
		const out = parseExpansion('"auth flow", sign-in (aka login), session token');
		expect(out).toEqual(["auth flow", "sign-in", "session token"]);
	});

	test("caps at 15 terms", () => {
		const many = Array.from({ length: 30 }, (_, i) => `term${i}`).join(", ");
		const out = parseExpansion(many);
		expect(out.length).toBe(15);
	});

	test("filters boilerplate connector words", () => {
		const out = parseExpansion("coupled, and, or, the, refactor");
		expect(out).toEqual(["coupled", "refactor"]);
	});

	test("strips qwen <think>…</think> blocks before parsing", () => {
		const out = parseExpansion(
			"<think>Hmm, the user wants synonyms for coupling.</think>\ncoupled, coupling, decouple, refactor",
		);
		expect(out).toEqual(["coupled", "coupling", "decouple", "refactor"]);
	});

	test("handles unclosed <think> at EOF (truncated reasoning)", () => {
		const out = parseExpansion("auth, oauth, login<think>wait let me reconsider");
		expect(out).toEqual(["auth", "oauth", "login"]);
	});
});
