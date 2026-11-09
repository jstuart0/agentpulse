/**
 * AGEN-141 phase 0: the neutral verdict module both canaries share. The Claude runner's own test holds its
 * re-export; this holds the module on its own, with a mutation table of its own (no Claude in sight).
 */
import { describe, expect, test } from "bun:test";
import {
	EXIT,
	type Expectation,
	type JudgedResult,
	classifyScenarioWith,
	exitCodeFor,
} from "./lib/canary-verdict.js";

const targets = (name: string) =>
	name === "drop-x" ? [{ scenario: "s", expectation: "x holds" }] : [];
const e = (name: string, kind: Expectation["kind"], ok: boolean | null): Expectation => ({
	name,
	kind,
	ok,
});
const result = (mutation: string | null, expectations: Expectation[]): JudgedResult => ({
	scenario: "s",
	mutation,
	expectations,
});

describe("classifyScenarioWith", () => {
	test("without a mutation: pass, fail, or an invalid instrument", () => {
		expect(classifyScenarioWith(result(null, [e("x holds", "claim", true)]), targets)).toBe("pass");
		expect(classifyScenarioWith(result(null, [e("x holds", "claim", false)]), targets)).toBe(
			"fail",
		);
		expect(
			classifyScenarioWith(
				result(null, [e("model called", "instrument", false), e("x holds", "claim", false)]),
				targets,
			),
		).toBe("instrumentInvalid");
		expect(classifyScenarioWith({ ...result(null, []), notRun: "budget" }, targets)).toBe("notRun");
	});

	test("under a mutation: the named expectation fails with every precondition holding is caught", () => {
		const base = [e("ready", "precondition", true), e("x holds", "claim", false)];
		expect(classifyScenarioWith(result("drop-x", base), targets)).toBe("mutationCaught");
	});

	test("under a mutation: it still passing is a survivor; a broken precondition makes it invalid", () => {
		expect(
			classifyScenarioWith(
				result("drop-x", [e("ready", "precondition", true), e("x holds", "claim", true)]),
				targets,
			),
		).toBe("mutationSurvived");
		expect(
			classifyScenarioWith(
				result("drop-x", [e("ready", "precondition", false), e("x holds", "claim", false)]),
				targets,
			),
		).toBe("mutationInvalid");
		expect(classifyScenarioWith(result("drop-x", [e("x holds", "claim", null)]), targets)).toBe(
			"mutationInvalid",
		);
		expect(classifyScenarioWith(result("unknown", [e("x holds", "claim", false)]), targets)).toBe(
			"mutationInvalid",
		);
	});
});

describe("exitCodeFor", () => {
	test("the strongest signal wins", () => {
		expect(exitCodeFor(["pass", "mutationCaught"])).toBe(EXIT.ok);
		expect(exitCodeFor(["pass", "instrumentInvalid"])).toBe(EXIT.instrumentInvalid);
		expect(exitCodeFor(["instrumentInvalid", "mutationInvalid"])).toBe(EXIT.mutationInvalid);
		expect(exitCodeFor(["mutationInvalid", "mutationSurvived"])).toBe(EXIT.mutationSurvived);
		expect(exitCodeFor(["mutationSurvived", "fail"])).toBe(EXIT.fail);
	});
});
