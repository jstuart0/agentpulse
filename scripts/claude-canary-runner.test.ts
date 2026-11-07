/**
 * The classification the live Claude canary relies on, held over synthetic result sets with no Claude and no
 * key (AGEN-117, phase 7). A mutation that "passes" for the wrong reason is the failure this exists to stop.
 */
import { describe, expect, test } from "bun:test";
import {
	EXIT,
	type Expectation,
	MUTATIONS,
	type ScenarioResult,
	SpendLedger,
	apiFailureOf,
	classifyScenario,
	costOfLines,
	exitCodeFor,
	mutationTargets,
} from "./claude-canary-runner.js";

const e = (name: string, kind: Expectation["kind"], ok: boolean | null): Expectation => ({
	name,
	kind,
	ok,
});

function result(
	mutation: string | null,
	expectations: Expectation[],
	extra: Partial<ScenarioResult> = {},
): ScenarioResult {
	const scenario = mutation ? (MUTATIONS[mutation]?.scenario ?? "x") : "x";
	return { scenario, login: "key", mutation, expectations, spendUsd: 0, ...extra };
}

const MUT = "allow-all";
const NAMED = MUTATIONS[MUT]?.expectation ?? "";

describe("classifyScenario without a mutation", () => {
	test("all expectations holding is a pass", () => {
		expect(
			classifyScenario(result(null, [e("a", "precondition", true), e("b", "claim", true)])),
		).toBe("pass");
	});
	test("a failed claim or precondition is a product failure", () => {
		expect(classifyScenario(result(null, [e("a", "claim", false)]))).toBe("fail");
		expect(
			classifyScenario(result(null, [e("a", "precondition", false), e("b", "claim", null)])),
		).toBe("fail");
	});
	test("a failed instrument is instrumentInvalid, never a pass and never a product failure", () => {
		expect(
			classifyScenario(
				result(null, [e("Claude asked", "instrument", false), e("b", "claim", false)]),
			),
		).toBe("instrumentInvalid");
	});
	test("a scenario that was not run is notRun, whatever else it carries", () => {
		expect(classifyScenario(result(null, [], { notRun: "budget" }))).toBe("notRun");
	});
});

describe("classifyScenario under a mutation", () => {
	test("the named expectation failing alone, with every precondition holding, is mutationCaught", () => {
		expect(
			classifyScenario(
				result(MUT, [
					e("Claude asked", "instrument", true),
					e("the takeover succeeded", "precondition", true),
					e(NAMED, "claim", false),
					e("a later claim", "claim", null),
				]),
			),
		).toBe("mutationCaught");
	});
	test("the named expectation failing and a precondition failing too is mutationInvalid", () => {
		expect(
			classifyScenario(
				result(MUT, [e("the takeover succeeded", "precondition", false), e(NAMED, "claim", false)]),
			),
		).toBe("mutationInvalid");
	});
	test("the named expectation passing is mutationSurvived (a surviving mutant is a finding)", () => {
		expect(
			classifyScenario(
				result(MUT, [e("the takeover succeeded", "precondition", true), e(NAMED, "claim", true)]),
			),
		).toBe("mutationSurvived");
	});
	test("a named expectation never reached, or absent, is mutationInvalid", () => {
		expect(classifyScenario(result(MUT, [e(NAMED, "claim", null)]))).toBe("mutationInvalid");
		expect(classifyScenario(result(MUT, [e("other", "claim", false)]))).toBe("mutationInvalid");
	});
	test("a failed instrument under a mutation is instrumentInvalid, so the run can retry it", () => {
		expect(
			classifyScenario(
				result(MUT, [e("Claude asked", "instrument", false), e(NAMED, "claim", false)]),
			),
		).toBe("instrumentInvalid");
	});
	test("a mutation the table doesn't know is mutationInvalid, not a pass", () => {
		expect(classifyScenario(result("no-such-mutation", [e("a", "claim", false)]))).toBe(
			"mutationInvalid",
		);
	});
	test("every mutation names a scenario and one expectation", () => {
		for (const [name, mutation] of Object.entries(MUTATIONS)) {
			expect(mutation.scenario, name).toBeTruthy();
			expect(mutation.expectation, name).toBeTruthy();
			expect(mutation.layers.length, name).toBeGreaterThan(0);
		}
	});
});

describe("a mutation that applies to two scenarios", () => {
	test("drop-ask names a different expectation in each scenario, and each is judged by its own", () => {
		const targets = mutationTargets("drop-ask");
		expect(targets.map((t) => t.scenario).sort()).toEqual(["user-rule", "webfetch"]);
		const forUserRule = targets.find((t) => t.scenario === "user-rule");
		expect(forUserRule?.expectation).toBe("Write asked");
		const caught: ScenarioResult = {
			scenario: "user-rule",
			login: "helper",
			mutation: "drop-ask",
			expectations: [e("S was made", "precondition", true), e("Write asked", "claim", false)],
			spendUsd: 0,
		};
		expect(classifyScenario(caught)).toBe("mutationCaught");
		// The webfetch expectation name is not user-rule's: it is absent there, so the run is invalid, not caught.
		const wrongName: ScenarioResult = {
			...caught,
			expectations: [e("a card appeared for the WebFetch", "claim", false)],
		};
		expect(classifyScenario(wrongName)).toBe("mutationInvalid");
	});
	test("a scenario the mutation does not apply to is mutationInvalid", () => {
		expect(
			classifyScenario({
				scenario: "tools",
				login: "key",
				mutation: "drop-ask",
				expectations: [e("x", "claim", false)],
				spendUsd: 0,
			}),
		).toBe("mutationInvalid");
	});
});

describe("exitCodeFor", () => {
	test("all good is 0", () => {
		expect(exitCodeFor(["pass", "mutationCaught", "notRun"])).toBe(EXIT.ok);
	});
	test("each kind has its own code, strongest first", () => {
		expect(exitCodeFor(["pass", "fail", "mutationSurvived", "instrumentInvalid"])).toBe(EXIT.fail);
		expect(exitCodeFor(["mutationSurvived", "mutationInvalid", "instrumentInvalid"])).toBe(
			EXIT.mutationSurvived,
		);
		expect(exitCodeFor(["mutationInvalid", "instrumentInvalid"])).toBe(EXIT.mutationInvalid);
		expect(exitCodeFor(["instrumentInvalid", "pass"])).toBe(EXIT.instrumentInvalid);
		const codes = new Set(Object.values(EXIT));
		expect(codes.size).toBe(Object.values(EXIT).length);
	});
});

describe("the spend ledger", () => {
	test("totals what was added and refuses a scenario that would pass the cap", () => {
		const ledger = new SpendLedger(1);
		ledger.add("a", 0.4);
		ledger.add("b", 0.5);
		ledger.add("c", Number.NaN);
		ledger.add("d", -3);
		expect(ledger.totalUsd).toBeCloseTo(0.9);
		expect(ledger.canAfford(0.1)).toBe(true);
		expect(ledger.canAfford(0.11)).toBe(false);
	});
	test("costOfLines sums result lines by model usage, falling back to the total", () => {
		expect(
			costOfLines([
				{ type: "assistant" },
				{
					type: "result",
					model_usage_since_last_result: { m: { costUSD: 0.25 }, n: { costUSD: 0.5 } },
				},
				{ type: "result", total_cost_usd: 0.125 },
			]),
		).toBeCloseTo(0.875);
	});
});

describe("apiFailureOf: an API problem is the instrument's, not the product's", () => {
	test("429, 5xx, an error subtype and a refusal are named; a clean result is not", () => {
		expect(apiFailureOf({ type: "result", api_error_status: 429 })).toBe("api 429");
		expect(apiFailureOf({ type: "result", api_error_status: 529 })).toBe("api 529");
		expect(apiFailureOf({ type: "result", is_error: true, subtype: "error_max_budget_usd" })).toBe(
			"error_max_budget_usd",
		);
		expect(apiFailureOf({ type: "result", stop_reason: "refusal" })).toBe("refusal");
		expect(apiFailureOf({ type: "result", is_error: false, subtype: "success" })).toBeNull();
		expect(apiFailureOf({ type: "assistant", api_error_status: 500 })).toBeNull();
	});
});
