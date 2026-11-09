/**
 * The neutral judging half every live canary shares (AGEN-141, phase 0; extracted from `claude-canary-runner.ts`,
 * which re-exports it unchanged): what a scenario's expectations mean, and the exit code a set of verdicts earns.
 * Pure functions over result sets, so CI can hold the classification with no agent binary.
 *
 * A scenario reports an ordered list of expectations. Each has a kind:
 *  - `instrument`: the setup of the measurement. One that fails means the run measured nothing:
 *    `instrumentInvalid`, never a pass and never a product fail.
 *  - `precondition`: a fact the claim stands on.
 *  - `claim`: what the scenario exists to prove.
 *
 * Under `--mutate`, a break names ONE expectation it must fail (per scenario, through `targetsOf`). The named
 * expectation fails and every precondition holds: `mutationCaught`. Otherwise `mutationSurvived` (it still
 * passed) or `mutationInvalid` (a precondition broke too, so the failure can't be attributed to the break).
 */

export type ExpectationKind = "instrument" | "precondition" | "claim";

export interface Expectation {
	name: string;
	kind: ExpectationKind;
	/** `null` is "not reached": an earlier expectation stopped the scenario. */
	ok: boolean | null;
	detail?: unknown;
}

export type Verdict =
	| "pass"
	| "fail"
	| "instrumentInvalid"
	| "notRun"
	| "mutationCaught"
	| "mutationSurvived"
	| "mutationInvalid";

export interface MutationTarget {
	scenario: string;
	expectation: string;
}

/** The part of a scenario result the verdict reads. */
export interface JudgedResult {
	scenario: string;
	mutation: string | null;
	expectations: Expectation[];
	/** Set when the scenario was not run at all (budget, a missing prerequisite). */
	notRun?: string;
}

export function classifyScenarioWith(
	result: JudgedResult,
	targetsOf: (mutation: string) => readonly MutationTarget[],
): Verdict {
	if (result.notRun) return "notRun";
	const { expectations } = result;
	const failed = (e: Expectation) => e.ok === false;
	if (expectations.some((e) => e.kind === "instrument" && failed(e))) return "instrumentInvalid";
	if (result.mutation === null) {
		return expectations.some(failed) ? "fail" : "pass";
	}
	const target = targetsOf(result.mutation).find((t) => t.scenario === result.scenario);
	if (!target) return "mutationInvalid";
	const named = expectations.find((e) => e.name === target.expectation);
	if (!named || named.ok === null) return "mutationInvalid";
	if (named.ok === true) return "mutationSurvived";
	// The named expectation failed. Every precondition must hold, or the failure can't be attributed.
	const brokenPrecondition = expectations.some(
		(e) => e.kind === "precondition" && e !== named && failed(e),
	);
	return brokenPrecondition ? "mutationInvalid" : "mutationCaught";
}

/** Exit codes: 0 all good; 1 a real failure; 2 usage (the caller exits before anything runs); 3 and up are of their own kind. */
export const EXIT = {
	ok: 0,
	fail: 1,
	usage: 2,
	instrumentInvalid: 3,
	mutationSurvived: 4,
	mutationInvalid: 5,
} as const;

/** The strongest signal wins: a product failure over a mutation that survived over an invalid instrument. */
export function exitCodeFor(verdicts: readonly Verdict[]): number {
	if (verdicts.includes("fail")) return EXIT.fail;
	if (verdicts.includes("mutationSurvived")) return EXIT.mutationSurvived;
	if (verdicts.includes("mutationInvalid")) return EXIT.mutationInvalid;
	if (verdicts.includes("instrumentInvalid")) return EXIT.instrumentInvalid;
	return EXIT.ok;
}
