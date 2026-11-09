/** AGEN-141: how the OpenCode canary judges its results (verdicts and exit codes) over synthetic results, with no OpenCode binary. */
import { describe, expect, test } from "bun:test";
import {
	EXIT,
	type Expectation,
	type JudgedResult,
	classifyScenarioWith,
	exitCodeFor,
} from "./lib/canary-verdict.ts";
import { MUTATION_TARGETS } from "./lib/opencode-canary-mutations.ts";
import { PRODUCT_SCENARIOS, toolDurationsMs } from "./opencode-canary-scenarios/product.ts";

const ok = (name: string, kind: Expectation["kind"] = "claim"): Expectation => ({
	name,
	kind,
	ok: true,
});
const bad = (name: string, kind: Expectation["kind"] = "claim"): Expectation => ({
	name,
	kind,
	ok: false,
});
const targets = (m: string) => MUTATION_TARGETS[m] ?? [];
const result = (
	scenario: string,
	mutation: string | null,
	expectations: Expectation[],
): JudgedResult => ({
	scenario,
	mutation,
	expectations,
});
const STALL = "the tool hook does not wait for the server";

describe("verdicts", () => {
	test("pass, fail, instrumentInvalid", () => {
		expect(classifyScenarioWith(result("stall", null, [ok("a"), ok(STALL)]), targets)).toBe("pass");
		expect(classifyScenarioWith(result("stall", null, [ok("a"), bad(STALL)]), targets)).toBe(
			"fail",
		);
		expect(
			classifyScenarioWith(
				result("stall", null, [bad("exited 0", "instrument"), ok(STALL)]),
				targets,
			),
		).toBe("instrumentInvalid");
	});

	test("a break is caught only when the named expectation fails and every precondition holds", () => {
		const caught = classifyScenarioWith(
			result("stall", "await-post", [ok("pre", "precondition"), bad(STALL)]),
			targets,
		);
		expect(caught).toBe("mutationCaught");
		expect(
			classifyScenarioWith(
				result("stall", "await-post", [ok("pre", "precondition"), ok(STALL)]),
				targets,
			),
		).toBe("mutationSurvived");
		expect(
			classifyScenarioWith(
				result("stall", "await-post", [bad("pre", "precondition"), bad(STALL)]),
				targets,
			),
		).toBe("mutationInvalid");
		expect(classifyScenarioWith(result("plain", "await-post", [bad(STALL)]), targets)).toBe(
			"mutationInvalid",
		);
	});

	test("exit codes: 0, 1, 3, 4, 5, with the strongest signal winning", () => {
		expect(exitCodeFor(["pass", "mutationCaught"])).toBe(EXIT.ok);
		expect(exitCodeFor(["pass", "fail", "mutationSurvived"])).toBe(EXIT.fail);
		expect(exitCodeFor(["mutationSurvived", "mutationInvalid"])).toBe(EXIT.mutationSurvived);
		expect(exitCodeFor(["mutationInvalid", "instrumentInvalid"])).toBe(EXIT.mutationInvalid);
		expect(exitCodeFor(["instrumentInvalid", "pass"])).toBe(EXIT.instrumentInvalid);
		expect(EXIT.usage).toBe(2);
		expect(EXIT.fail).toBe(1);
	});

	test("every break targets a scenario that exists, and an expectation name the scenario writes", async () => {
		const source = await Bun.file(
			new URL("./opencode-canary-scenarios/product.ts", import.meta.url),
		).text();
		for (const list of Object.values(MUTATION_TARGETS)) {
			for (const t of list) {
				expect(PRODUCT_SCENARIOS[t.scenario], t.scenario).toBeDefined();
				expect(source.includes(`"${t.expectation}"`), t.expectation).toBe(true);
			}
		}
	});
});

describe("reading OpenCode's own tool timing", () => {
	test("tool_use lines give end minus start; other lines and malformed ones are ignored", () => {
		const out = [
			'{"type":"step_start","part":{}}',
			'{"type":"tool_use","part":{"state":{"time":{"start":100,"end":126}}}}',
			"not json",
			'{"type":"tool_use","part":{"state":{"status":"running"}}}',
		].join("\n");
		expect(toolDurationsMs(out)).toEqual([26]);
	});
});
