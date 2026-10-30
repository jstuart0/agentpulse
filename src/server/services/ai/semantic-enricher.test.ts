import { beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config.js";
import { type LlmAdapter, LlmError, type LlmRequest, type LlmResponse } from "./llm/types.js";
import {
	EXPANDER_COOLDOWN_MS,
	LlmQueryExpander,
	__resetQueryExpanderForTests,
	parseExpansion,
} from "./semantic-enricher.js";

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

describe("LlmQueryExpander (AGEN-79)", () => {
	let nowMs = 1_000_000;
	let requests: LlmRequest[] = [];
	let script: Array<string | Error> = [];

	const adapter: LlmAdapter = {
		kind: "openai_compatible",
		complete: async (request: LlmRequest): Promise<LlmResponse> => {
			requests.push(request);
			const next = script.shift() ?? "";
			if (next instanceof Error) throw next;
			return {
				text: next,
				usage: { inputTokens: 1, outputTokens: 1, estimated: true },
				rawResponse: null,
			};
		},
	};

	beforeEach(() => {
		nowMs = 1_000_000;
		requests = [];
		script = [];
		__resetQueryExpanderForTests(() => nowMs);
	});

	const expander = () => new LlmQueryExpander(adapter, "m");

	test("asks with reasoning off, a small token budget and the configured helper timeout", async () => {
		script = ["coupled, coupling"];
		const out = await expander().enrich("tightly coupled code");
		expect(out.extraTerms).toEqual(["coupled", "coupling"]);
		expect(requests[0]?.disableReasoning).toBe(true);
		expect(requests[0]?.maxTokens).toBe(120);
		expect(requests[0]?.timeoutMs).toBe(config.aiHelperTimeoutSeconds * 1000);
	});

	test("a failed expansion returns nothing and the next turns skip the call until the cooldown ends", async () => {
		script = [
			new LlmError("transient_timeout", "timed out", undefined, undefined, true),
			"auth, login",
		];
		expect((await expander().enrich("q1")).extraTerms).toEqual([]);
		expect(requests).toHaveLength(1);

		nowMs += EXPANDER_COOLDOWN_MS - 1;
		expect((await expander().enrich("q2")).extraTerms).toEqual([]);
		expect(requests).toHaveLength(1); // skipped: no second call, no wait

		nowMs += 1;
		expect((await expander().enrich("q3")).extraTerms).toEqual(["auth", "login"]);
		expect(requests).toHaveLength(2); // recovered by itself
	});

	test("an empty reply from a thinking model counts as a failure, and its reasoning never becomes search terms", async () => {
		script = [new LlmError("empty_output", "no answer text"), "later, terms"];
		expect((await expander().enrich("q1")).extraTerms).toEqual([]);
		nowMs += 10;
		expect((await expander().enrich("q2")).extraTerms).toEqual([]);
		expect(requests).toHaveLength(1);
	});

	test("an answer that parses to no terms is not a failure", async () => {
		script = ["", "one, two"];
		expect((await expander().enrich("q1")).extraTerms).toEqual([]);
		expect((await expander().enrich("q2")).extraTerms).toEqual(["one", "two"]);
		expect(requests).toHaveLength(2);
	});
});
