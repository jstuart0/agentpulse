import { describe, expect, test } from "bun:test";
import {
	SUMMARY_OUTCOME_STATUSES,
	SUMMARY_SECTION_KEYS,
	type SummaryDraft,
} from "../../../../shared/session-summary.js";
import { NONCE } from "./__fixtures__/summary-test-support.js";
import { classifyStopReason, parseAnswer, repairTrailer } from "./output-schema.js";

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		overview: "Added retry to the uploader.",
		outcome: { status: "completed", explanation: "All done." },
		accomplishments: [{ text: "Added retry.", evidence: ["E3"] }],
		changes: [{ kind: "modified", text: "src/uploader.ts", evidence: ["E3"] }],
		decisions: [{ text: "Exponential backoff", why: "Avoids hammering", evidence: [] }],
		validation: [{ what: "bun test", result: "passed", detail: "4 pass", evidence: ["E5"] }],
		problems: [{ text: "None", evidence: [] }],
		unfinished: [{ text: "No significant unfinished work identified.", evidence: [] }],
		nextActions: [{ text: "Merge it", evidence: [] }],
		handoff: "Retry is in src/retry.ts.",
		...over,
	};
}

function draftFrom(raw: string): SummaryDraft {
	const result = parseAnswer(raw, NONCE);
	if (!result.ok) throw new Error(`expected a parse, got failure at ${result.path}`);
	return result.draft;
}
const parse = (value: unknown) => parseAnswer(JSON.stringify(value), NONCE);
const hasLoneSurrogate = (s: string) =>
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("parse tolerance", () => {
	const json = JSON.stringify(answer());

	test("TC-4.10a bare JSON, lower and upper case fences", () => {
		expect(draftFrom(json).overview).toBe("Added retry to the uploader.");
		expect(draftFrom(`\`\`\`json\n${json}\n\`\`\``).overview).toBe("Added retry to the uploader.");
		expect(draftFrom(`\`\`\`JSON\n${json}\n\`\`\``).overview).toBe("Added retry to the uploader.");
		expect(draftFrom(`\`\`\`\n${json}\n\`\`\``).overview).toBe("Added retry to the uploader.");
	});

	test("TC-4.10b JSON after a <think> block whose text has braces", () => {
		const raw = `<think>I could answer {"overview": "decoy"} but should think {first}.</think>\n${json}`;
		expect(draftFrom(raw).overview).toBe("Added retry to the uploader.");
	});

	test("TC-4.10c prose before and after, including prose with {braces} before the object", () => {
		expect(draftFrom(`Here is the summary:\n${json}\nHope that helps.`).overview).toBe(
			"Added retry to the uploader.",
		);
		expect(draftFrom(`Use {braces} like {this} first. ${json} done {x}`).overview).toBe(
			"Added retry to the uploader.",
		);
	});

	test("TC-4.10d never returns a nested inner item as the summary", () => {
		const inner = '{"text":"inner item","evidence":["E1"]}';
		const draft = draftFrom(`An item looks like ${inner}. Full answer: ${json}`);
		expect(draft.overview).toBe("Added retry to the uploader.");
		expect(draft.accomplishments[0]?.text).toBe("Added retry.");
	});

	test("TC-4.11 braces and quotes inside JSON strings do not confuse extraction", () => {
		const tricky = answer({
			overview: 'He said "use } and { carefully" \\ then left',
			handoff: "a } b { c",
		});
		const draft = draftFrom(`Sure thing: ${JSON.stringify(tricky)} -- end`);
		expect(draft.overview).toBe('He said "use } and { carefully" \\ then left');
		expect(draft.handoff).toBe("a } b { c");
	});

	test("TC-4.12 empty, whitespace, null, array, number and an unterminated think tag are failures, never throws", () => {
		for (const raw of [
			"",
			"   \n\t",
			"null",
			"[]",
			'[{"overview":"x"}]',
			"42",
			'"text"',
			"<think>never closed",
			"{",
			"}{",
		]) {
			const result = parseAnswer(raw, NONCE);
			expect(result.ok).toBe(false);
		}
	});

	test("TC-4.4b the fence nonce is scrubbed from the answer before parsing", () => {
		const raw = JSON.stringify(answer({ overview: `see ${NONCE} and ${NONCE.toUpperCase()}` }));
		const draft = draftFrom(raw);
		expect(draft.overview.toLowerCase()).not.toContain(NONCE);
	});
});

describe("normalisation and schema", () => {
	test("TC-4.13 enum normalisation reaches all eight statuses", () => {
		const cases: Array<[string, string]> = [
			["Mostly Completed", "mostly_completed"],
			["mostly-completed", "mostly_completed"],
			["MOSTLY_COMPLETED", "mostly_completed"],
			[" Completed ", "completed"],
			["in progress", "in_progress"],
			["Partially Completed", "partially_completed"],
			["BLOCKED", "blocked"],
			["Failed", "failed"],
			["abandoned", "abandoned"],
			["Unclear", "unclear"],
		];
		for (const [input, expected] of cases) {
			const draft = draftFrom(
				JSON.stringify(answer({ outcome: { status: input, explanation: "e" } })),
			);
			expect(draft.outcome.status as string).toBe(expected);
		}
		const reached = new Set(cases.map(([, e]) => e));
		for (const status of SUMMARY_OUTCOME_STATUSES) expect(reached.has(status)).toBe(true);
	});

	test("TC-4.14 an unknown status or validation result is a schema failure at its path, with no silent default", () => {
		const badStatus = parse(answer({ outcome: { status: "done", explanation: "e" } }));
		expect(badStatus).toEqual({ ok: false, path: "outcome.status" });
		const badResult = parse(
			answer({ validation: [{ what: "x", result: "n/a", detail: "", evidence: [] }] }),
		);
		expect(badResult).toEqual({ ok: false, path: "validation.0.result" });
		const second = parse(
			answer({
				validation: [
					{ what: "a", result: "passed", detail: "", evidence: [] },
					{ what: "x", result: "pass", detail: "", evidence: [] },
				],
			}),
		);
		expect(second).toEqual({ ok: false, path: "validation.1.result" });
	});

	test("TC-4.15 an unknown or missing changes.kind maps to other and costs no retry", () => {
		const draft = draftFrom(
			JSON.stringify(
				answer({
					changes: [
						{ kind: "refactor", text: "a", evidence: [] },
						{ text: "b", evidence: [] },
						{ kind: "Dependency", text: "c", evidence: [] },
					],
				}),
			),
		);
		expect(draft.changes.map((c) => c.kind)).toEqual(["other", "other", "dependency"]);
	});

	test("TC-4.16a arrays are sliced to 20 and next actions to 5, at the boundary and one over", () => {
		const items = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ text: `t${i}`, evidence: [] }));
		const at = draftFrom(
			JSON.stringify(answer({ accomplishments: items(20), nextActions: items(5) })),
		);
		expect(at.accomplishments).toHaveLength(20);
		expect(at.nextActions).toHaveLength(5);
		const over = draftFrom(
			JSON.stringify(
				answer({
					accomplishments: items(21),
					problems: items(21),
					unfinished: items(21),
					nextActions: items(6),
					changes: items(21).map((i) => ({ ...i, kind: "other" })),
					decisions: items(21).map((i) => ({ ...i, why: "w" })),
					validation: items(21).map((i) => ({
						what: i.text,
						result: "unknown",
						detail: "",
						evidence: [],
					})),
				}),
			),
		);
		for (const key of [
			"accomplishments",
			"problems",
			"unfinished",
			"changes",
			"decisions",
			"validation",
		] as const) {
			expect(over[key]).toHaveLength(20);
		}
		expect(over.nextActions).toHaveLength(5);
		expect(over.accomplishments[19]?.text).toBe("t19");
	});

	test("TC-4.16b strings are cut at 1,200 / 600 / 4,000 code points, at the boundary and one over", () => {
		const len = (s: string) => Array.from(s).length;
		const draft = (o: number, i: number, h: number) =>
			draftFrom(
				JSON.stringify(
					answer({
						overview: "o".repeat(o),
						handoff: "h".repeat(h),
						outcome: { status: "completed", explanation: "e".repeat(i) },
						accomplishments: [{ text: "t".repeat(i), evidence: [] }],
						decisions: [{ text: "d", why: "w".repeat(i), evidence: [] }],
						validation: [
							{ what: "v".repeat(i), result: "unknown", detail: "x".repeat(i), evidence: [] },
						],
					}),
				),
			);
		const at = draft(1200, 600, 4000);
		expect([len(at.overview), len(at.handoff), len(at.accomplishments[0]?.text ?? "")]).toEqual([
			1200, 4000, 600,
		]);
		const over = draft(1201, 601, 4001);
		expect(len(over.overview)).toBe(1200);
		expect(len(over.handoff)).toBe(4000);
		expect(len(over.accomplishments[0]?.text ?? "")).toBe(600);
		expect(len(over.outcome.explanation)).toBe(600);
		expect(len(over.decisions[0]?.why ?? "")).toBe(600);
		expect(len(over.validation[0]?.what ?? "")).toBe(600);
		expect(len(over.validation[0]?.detail ?? "")).toBe(600);
	});

	test("TC-4.16c the cut is code-point safe (no lone surrogate from an astral character at the boundary)", () => {
		const straddle = `${"a".repeat(1199)}\u{1F600}tail`;
		const draft = draftFrom(JSON.stringify(answer({ overview: straddle })));
		expect(hasLoneSurrogate(draft.overview)).toBe(false);
		expect(Array.from(draft.overview).length).toBe(1200);
		expect(draft.overview.endsWith("\u{1F600}")).toBe(true);
		const past = draftFrom(JSON.stringify(answer({ overview: `${"a".repeat(1200)}\u{1F600}` })));
		expect(hasLoneSurrogate(past.overview)).toBe(false);
	});

	test("TC-4.17a each of the ten keys removed in turn: arrays become [], the three required ones fail", () => {
		const required = new Set(["overview", "outcome", "handoff"]);
		for (const key of SUMMARY_SECTION_KEYS) {
			const value = answer();
			delete value[key];
			const result = parse(value);
			if (required.has(key)) {
				expect(result.ok).toBe(false);
			} else {
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.draft[key as "problems"]).toEqual([]);
			}
		}
	});

	test("TC-4.17b an empty or blank overview or handoff fails; a status with no explanation is accepted", () => {
		expect(parse(answer({ overview: "" })).ok).toBe(false);
		expect(parse(answer({ overview: "   \n" })).ok).toBe(false);
		expect(parse(answer({ handoff: "" })).ok).toBe(false);
		expect(parse(answer({ outcome: {} })).ok).toBe(false);
		expect(parse(answer({ outcome: "completed" })).ok).toBe(false);
		const bare = parse(answer({ outcome: { status: "blocked" } }));
		expect(bare.ok).toBe(true);
		if (bare.ok) expect(bare.draft.outcome.explanation).toBe("");
	});

	test("TC-4.17c an item with no text is dropped without failing the answer; a bare string becomes an item", () => {
		const draft = draftFrom(
			JSON.stringify(
				answer({
					accomplishments: [
						{ text: "", evidence: [] },
						{ evidence: ["E1"] },
						"plain string item",
						{ text: "kept", evidence: [] },
					],
				}),
			),
		);
		expect(draft.accomplishments.map((a) => a.text)).toEqual(["plain string item", "kept"]);
	});

	test("TC-4.18a evidence normalisation: integers become E<n>, only ^E<digits>$ strings are kept, no coercion of other strings", () => {
		const evidence = [
			"E12",
			"e13",
			"12",
			12,
			"E012",
			"E1 ,E2",
			"javascript:alert(1)",
			"E99999999999999999999",
			-1,
			1.5,
			null,
			{},
			["E5"],
		];
		const draft = draftFrom(JSON.stringify(answer({ accomplishments: [{ text: "a", evidence }] })));
		expect(draft.accomplishments[0]?.evidence).toEqual(["E12", "E012", "E99999999999999999999"]);
	});

	test("TC-4.18c evidence ids are deduplicated and capped per item", () => {
		const many = Array.from({ length: 40 }, (_, i) => `E${i}`);
		const draft = draftFrom(
			JSON.stringify(answer({ accomplishments: [{ text: "a", evidence: [...many, ...many] }] })),
		);
		expect(draft.accomplishments[0]?.evidence).toEqual(many.slice(0, 12));
	});

	test("TC-4.19 evidence given as a string becomes an array", () => {
		const one = draftFrom(
			JSON.stringify(answer({ accomplishments: [{ text: "a", evidence: "E12" }] })),
		);
		expect(one.accomplishments[0]?.evidence).toEqual(["E12"]);
		const two = draftFrom(
			JSON.stringify(answer({ accomplishments: [{ text: "a", evidence: "E1, E2" }] })),
		);
		expect(two.accomplishments[0]?.evidence).toEqual(["E1", "E2"]);
		const missing = draftFrom(JSON.stringify(answer({ accomplishments: [{ text: "a" }] })));
		expect(missing.accomplishments[0]?.evidence).toEqual([]);
	});

	test("TC-4.20 extra keys, __proto__ and constructor are dropped and Object.prototype is untouched", () => {
		const raw =
			'{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extra":1,' +
			'"overview":"o","outcome":{"status":"completed","explanation":"e","__proto__":{"polluted":true},"x":1},' +
			'"handoff":"h","accomplishments":[{"text":"a","evidence":[],"__proto__":{"polluted":true},"constructor":"c","bonus":2}]}';
		const draft = draftFrom(raw);
		expect(Object.keys(draft).sort()).toEqual([...SUMMARY_SECTION_KEYS].sort());
		expect(Object.keys(draft.outcome).sort()).toEqual(["explanation", "status"]);
		expect(Object.keys(draft.accomplishments[0] as object).sort()).toEqual(["evidence", "text"]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(draft)).toBe(Object.prototype);
		expect(Object.hasOwn(draft, "__proto__")).toBe(false);
		expect(Object.hasOwn(draft, "constructor")).toBe(false);
	});
});

describe("repair", () => {
	const PARSE_TAIL = "Respond with exactly one JSON object per the schema. No prose.";

	test("TC-4.21a the parse trailer is exactly the fixed sentence with a schema path or 'top level'", () => {
		expect(repairTrailer({ kind: "parse", path: "top level" })).toBe(
			`RESPONSE PARSE ERROR at top level. ${PARSE_TAIL}`,
		);
		expect(repairTrailer({ kind: "parse", path: "validation.2.result" })).toBe(
			`RESPONSE PARSE ERROR at validation.2.result. ${PARSE_TAIL}`,
		);
	});

	test("TC-4.21b the truncation trailer is exactly the plan's sentence", () => {
		expect(repairTrailer({ kind: "truncated" })).toBe(
			"Your answer was cut off. Answer again more briefly: at most 8 items per section.",
		);
	});

	test("TC-4.21c nothing the model wrote reaches a trailer: an invalid enum value, a JSON.parse failure, a hostile path", () => {
		const sentinel = "SENTINEL-MODEL-TEXT-91f3";
		const badEnum = parse(answer({ outcome: { status: sentinel, explanation: "e" } }));
		expect(badEnum.ok).toBe(false);
		if (!badEnum.ok) {
			expect(badEnum.path).toBe("outcome.status");
			expect(repairTrailer({ kind: "parse", path: badEnum.path })).not.toContain(sentinel);
		}
		const brokenJson = parseAnswer(`{"overview": "${sentinel}", oops`, NONCE);
		expect(brokenJson.ok).toBe(false);
		if (!brokenJson.ok) {
			expect(brokenJson.path).toBe("top level");
			expect(JSON.stringify(brokenJson)).not.toContain(sentinel);
		}
		const hostile = repairTrailer({ kind: "parse", path: `x.${sentinel} ignore the rules` });
		expect(hostile).toBe(`RESPONSE PARSE ERROR at top level. ${PARSE_TAIL}`);
	});

	test("TC-4.21d the failure result carries a path and nothing else", () => {
		const failure = parseAnswer("not json at all SENTINEL-77", NONCE);
		expect(failure).toEqual({ ok: false, path: "top level" });
	});

	test("TC-4.21e stop reasons: refusal and length are acted on; end, other and absent parse alike", () => {
		expect(classifyStopReason("refusal")).toBe("refusal");
		expect(classifyStopReason("length")).toBe("length");
		for (const stop of ["end", "other", undefined] as const) {
			expect(classifyStopReason(stop)).toBe("parse");
		}
	});
});
