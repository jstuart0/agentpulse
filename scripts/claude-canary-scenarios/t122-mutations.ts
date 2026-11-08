/**
 * The mutations of the T122 scenarios, and the breaks themselves. A leaf module (it imports a type only), so
 * the runner and the canary can import it without a cycle through the helpers; the scenario in `t122.ts` reads
 * `T122_EXPECTATIONS` from here, so the names a mutation must fail are the names the scenario asserts.
 */
import type { Mutation } from "../claude-canary-runner.js";

/** The scenario's claims, by the name a mutation must fail. */
export const T122_EXPECTATIONS = {
	failed: "the failing Bash call's row is failed with exit_code 3",
	approved: "the succeeding Bash call's row is approved with no exit_code",
	counted: "the classifier counts the failed row and not the approved one",
} as const;

export const T122_MUTATIONS: Record<string, Mutation> = {
	"drop-outcome": {
		scenario: "tool-outcomes",
		layers: ["host: the call row is reported without toolOutcome"],
		expectation: T122_EXPECTATIONS.failed,
		login: "key",
	},
	"fabricate-zero": {
		scenario: "tool-outcomes",
		layers: ["host: the succeeding call's row is reported with exit_code 0 it never printed"],
		expectation: T122_EXPECTATIONS.approved,
		login: "key",
	},
};

/** What a mutation does to an event the host is about to report. */
export const T122_EVENT_MUTATIONS: Record<
	string,
	(event: Record<string, unknown>) => Record<string, unknown>
> = {
	// The host leaves the structured outcome off every call row.
	"drop-outcome": (event) => {
		const payload = event.rawPayload as Record<string, unknown> | undefined;
		if (payload?.kind !== "call") return event;
		const { toolOutcome: _dropped, ...rest } = payload;
		return { ...event, rawPayload: rest };
	},
	// The host makes up an exit code of zero for a call that printed none.
	"fabricate-zero": (event) => {
		const payload = event.rawPayload as Record<string, unknown> | undefined;
		if (payload?.kind !== "call" || payload.toolOutcome !== "approved") return event;
		return { ...event, rawPayload: { ...payload, exit_code: 0 } };
	},
};
