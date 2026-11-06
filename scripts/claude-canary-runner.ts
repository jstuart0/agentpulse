/**
 * The judging half of the Claude live canary (AGEN-117, phase 7): pure functions over result sets, so CI can
 * hold the classification with no Claude and no key. `claude-takeover-canary.ts` produces the results; this
 * file decides what they mean.
 *
 * A scenario reports an ordered list of expectations. Each has a kind:
 *  - `instrument`: the setup of the measurement (the model made the call, the API answered, Claude asked).
 *    One that fails means the run measured nothing: `instrumentInvalid`, never a pass and never a product fail.
 *  - `precondition`: a fact the claim stands on (the takeover succeeded, the child is alive).
 *  - `claim`: what the scenario exists to prove.
 *
 * Under `--mutate`, a break names ONE expectation it must fail. The rule: the named expectation fails, every
 * precondition holds, and anything after it is "not reached" (not judged). Otherwise the mutation is
 * `mutationSurvived` (the named expectation still passed: the product has a layer the mutation did not
 * disable, or the check is empty) or `mutationInvalid` (a precondition broke too, so the failure can't be
 * attributed to the break).
 */

export type ExpectationKind = "instrument" | "precondition" | "claim";

export interface Expectation {
	name: string;
	kind: ExpectationKind;
	/** `null` is "not reached": an earlier expectation stopped the scenario. */
	ok: boolean | null;
	detail?: unknown;
}

export type Login = "key" | "helper";

export interface ScenarioResult {
	scenario: string;
	login: Login;
	mutation: string | null;
	expectations: Expectation[];
	/** Dollars spent by this scenario (the ledger's own figure, not the model's claim). */
	spendUsd: number;
	/** Set when the scenario was not run at all (budget, a missing prerequisite). */
	notRun?: string;
}

export type Verdict =
	| "pass"
	| "fail"
	| "instrumentInvalid"
	| "notRun"
	| "mutationCaught"
	| "mutationSurvived"
	| "mutationInvalid";

export interface Mutation {
	scenario: string;
	/** What it breaks, every layer, for the report. */
	layers: string[];
	/** The one expectation that must fail. */
	expectation: string;
	/** The login the break only means anything under (a helper login is what `guess-restricted` misjudges). */
	login?: Login;
	/** The same break applied to another scenario, with that scenario's own named expectation. */
	also?: Array<{ scenario: string; expectation: string; login?: Login }>;
}

export interface MutationTarget {
	scenario: string;
	expectation: string;
	login?: Login;
}

/** Every scenario a mutation applies to, with the one expectation it must fail there. */
export function mutationTargets(name: string): MutationTarget[] {
	const m = MUTATIONS[name];
	if (!m) return [];
	return [
		{ scenario: m.scenario, expectation: m.expectation, ...(m.login ? { login: m.login } : {}) },
		...(m.also ?? []),
	];
}

/**
 * The plan's table: each mutation lists every layer it disables and the one expectation it must fail.
 * The scenario's own expectation names are what `expectation` is matched against.
 */
export const MUTATIONS: Record<string, Mutation> = {
	"drop-fork+skip-own-id+skip-source-check": {
		scenario: "takeover",
		layers: [
			"drop-fork: --fork-session and --session-id are removed from the argv",
			"skip-own-id: agents --json is made to report N",
			"skip-source-check: the before/after stat of S's transcript is not taken (found live: it is a third layer the plan did not list)",
		],
		expectation: "S's transcript hashes are unchanged",
	},
	"skip-assert+skip-own-id": {
		scenario: "n-equals-s",
		layers: [
			"skip-assert: the builder's N !== S refusal is bypassed",
			"skip-own-id: agents --json is made to report the id asked for",
		],
		expectation: "S's transcript hashes are unchanged",
	},
	"allow-all": {
		scenario: "decline-write",
		layers: ["allow-all: the tracker's answer is always allow, whatever the person decided"],
		expectation: "the declined file is absent",
	},
	"rewrite-input": {
		scenario: "approve-bash",
		layers: ["rewrite-input: the wire wrapper changes the command in the allow answer"],
		expectation: "the command's output equals what the card showed",
	},
	"run-anyway": {
		scenario: "crash-pending",
		layers: [
			"run-anyway: the pending request is answered accept just before the supervisor is killed, so the tool runs (the residual in T10)",
		],
		expectation: "the tool file is absent",
	},
	"guess-restricted": {
		scenario: "login",
		layers: ["guess-restricted: the login probe's mode selection returns restricted for any login"],
		expectation: "a helper login gets ask",
		login: "helper",
	},
	"add-input": {
		scenario: "rows",
		layers: ["add-input: the wire wrapper puts the tool input into a stored row"],
		expectation: "the sentinel is in no stored row",
	},
	"sigkill-first": {
		scenario: "stop-stream",
		layers: [
			"sigkill-first: the ladder's first signal is SIGKILL (the Bash descendant is left behind)",
		],
		expectation: "the Bash descendant is gone",
	},
	"drop-ask": {
		scenario: "webfetch",
		layers: [
			"drop-ask: the inline --settings object (permissions.ask) is removed from the argv, so the user's WebFetch(*) allow decides",
		],
		expectation: "a card appeared for the WebFetch",
		login: "helper",
		also: [{ scenario: "user-rule", expectation: "Write asked", login: "helper" }],
	},
	"drop-setting-sources+drop-ask": {
		scenario: "project-hook",
		layers: [
			"drop-setting-sources: --setting-sources user is removed, so the project's settings (an allow rule and an allow hook) load",
			"drop-ask: the inline --settings object (permissions.ask) is removed too: found live, with --setting-sources alone the inline ask still beats the project's allow (a second layer the plan did not list)",
		],
		expectation: "card appeared",
		login: "helper",
	},
	"drop-restricted": {
		scenario: "user-rule",
		layers: [
			"drop-restricted: --restricted is removed from the argv, so the user's Bash(*) allow and allow hook decide",
		],
		expectation: "touch asked",
		login: "key",
	},
	"skip-account-check": {
		scenario: "login",
		layers: [
			"skip-account-check: both login probes are made to report a working helper login (the mode selection no longer refuses)",
			"skip-account-check: the fork's own initialize answer is rewritten to a working login (the runtime's agreement check passes)",
		],
		expectation: "no row N",
		login: "key",
	},
	"drop-tools": {
		scenario: "tools",
		layers: ["drop-tools: --tools and --disallowedTools are removed from the argv"],
		expectation: "Agent, SendMessage and ScheduleWakeup are unavailable",
	},
	"drop-flag": {
		scenario: "slash",
		layers: [
			"drop-flag: --disable-slash-commands is removed from the argv (the fatal id rule is the next layer and is left on)",
		],
		expectation: "the session id is unchanged",
	},
	"no-peer-rule": {
		scenario: "peer-inject",
		layers: ["no-peer-rule: the runtime's peer_turn protocol violation is made a no-op"],
		expectation: "N is degraded after a peer message",
		login: "helper",
	},
	"no-memory-rule": {
		scenario: "memory",
		layers: [
			"no-memory-rule: agent_memory is stripped from the host's approval report before it leaves the gate",
		],
		expectation: "the memory write's card is decline-only (ask)",
		login: "helper",
	},
	"no-fence+no-host-fence": {
		scenario: "stop-fence",
		layers: [
			"no-host-fence: the tracker's fence (called before the runtime lookup on Stop) is a no-op",
			"no-fence: the held host sync is released and drained before Stop, so there is nothing for the server's fence to close (the server function itself is not patched: ES exports are immutable)",
		],
		expectation: "the sentinel file is absent",
	},
	"no-renew": {
		scenario: "turn-guard",
		layers: [
			"no-renew: the host believes the server lacks claude_turn_control, so it never renews the lock",
		],
		expectation: "second prompt busy",
	},
	"drop-agents-check": {
		scenario: "second-writer",
		layers: ["drop-agents-check: the takeover preflight's agents --json listing is made empty"],
		expectation: "a process listed for S refuses the takeover",
	},
	"drop-prompt-check": {
		scenario: "continue-landing",
		layers: [
			"drop-prompt-check: the runtime's per-prompt agents --json listing hides the second process",
		],
		expectation: "the next prompt is refused",
	},
	"in-place-first": {
		scenario: "recover-never-prompted",
		layers: [
			"in-place-first: a recovery start is rewritten to --resume N (in place) even though N was never prompted",
		],
		expectation: "resumed",
	},
};

export function classifyScenario(result: ScenarioResult): Verdict {
	if (result.notRun) return "notRun";
	const { expectations } = result;
	const failed = (e: Expectation) => e.ok === false;
	if (expectations.some((e) => e.kind === "instrument" && failed(e))) return "instrumentInvalid";
	if (result.mutation === null) {
		return expectations.some(failed) ? "fail" : "pass";
	}
	const target = mutationTargets(result.mutation).find((t) => t.scenario === result.scenario);
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

/** The total spend ledger: a hard cap, checked before each scenario starts, written to a file by the caller. */
export class SpendLedger {
	private entries: Array<{ scenario: string; usd: number }> = [];
	constructor(readonly capUsd: number) {}
	add(scenario: string, usd: number): void {
		if (Number.isFinite(usd) && usd > 0) this.entries.push({ scenario, usd });
	}
	get totalUsd(): number {
		return this.entries.reduce((sum, e) => sum + e.usd, 0);
	}
	/** Room left after reserving `reserveUsd` for the next scenario's worst case. */
	canAfford(reserveUsd: number): boolean {
		return this.totalUsd + reserveUsd <= this.capUsd;
	}
	snapshot() {
		return {
			capUsd: this.capUsd,
			totalUsd: Number(this.totalUsd.toFixed(5)),
			entries: this.entries,
		};
	}
}

/** Sums the dollars Claude reported in `result` lines. The ledger trusts nothing else. */
export function costOfLines(lines: ReadonlyArray<Record<string, unknown>>): number {
	let total = 0;
	for (const line of lines) {
		if (line.type !== "result") continue;
		const usage = line.model_usage_since_last_result;
		if (usage && typeof usage === "object") {
			for (const entry of Object.values(usage as Record<string, unknown>)) {
				const cost = (entry as { costUSD?: unknown })?.costUSD;
				if (typeof cost === "number") total += cost;
			}
		} else if (typeof line.total_cost_usd === "number") {
			total += line.total_cost_usd;
		}
	}
	return total;
}

/** Whether a result line says the API (not the product) failed: 429, 5xx, an overload or a refusal. */
export function apiFailureOf(line: Record<string, unknown>): string | null {
	if (line.type !== "result") return null;
	const status = line.api_error_status;
	if (typeof status === "number" && (status === 429 || status >= 500)) return `api ${status}`;
	if (line.is_error === true && typeof line.subtype === "string" && line.subtype !== "success") {
		return String(line.subtype);
	}
	if (line.stop_reason === "refusal") return "refusal";
	return null;
}
