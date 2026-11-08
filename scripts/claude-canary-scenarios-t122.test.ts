/** AGEN-122: the canary's mutation table names the scenario's own expectations, and each break changes what it says it does. */
import { describe, expect, test } from "bun:test";
import { mutationTargets } from "./claude-canary-runner.js";
import {
	T122_EVENT_MUTATIONS,
	T122_EXPECTATIONS,
	T122_MUTATIONS,
} from "./claude-canary-scenarios/t122-mutations.js";

const callRow = (toolOutcome: string, extra: Record<string, unknown> = {}) => ({
	eventType: "HeadlessStatus",
	rawPayload: { kind: "call", claudeStreamRuntime: true, toolOutcome, is_error: false, ...extra },
});

describe("the T122 canary mutations", () => {
	test("each targets the tool-outcomes scenario and the expectation text it asserts", () => {
		const names = Object.keys(T122_MUTATIONS).sort();
		expect(names).toEqual(["drop-outcome", "fabricate-zero"]);
		expect(Object.keys(T122_EVENT_MUTATIONS).sort()).toEqual(names);
		expect(mutationTargets("drop-outcome")[0]).toMatchObject({
			scenario: "tool-outcomes",
			expectation: T122_EXPECTATIONS.failed,
		});
		expect(mutationTargets("fabricate-zero")[0]).toMatchObject({
			scenario: "tool-outcomes",
			expectation: T122_EXPECTATIONS.approved,
		});
	});

	test("drop-outcome removes toolOutcome from a call row and touches nothing else", () => {
		const mutated = T122_EVENT_MUTATIONS["drop-outcome"]?.(callRow("failed", { exit_code: 3 }));
		expect(mutated?.rawPayload).toEqual({
			kind: "call",
			claudeStreamRuntime: true,
			is_error: false,
			exit_code: 3,
		});
		const turnEnd = { eventType: "HeadlessPromptCompleted", rawPayload: { status: "completed" } };
		expect(T122_EVENT_MUTATIONS["drop-outcome"]?.(turnEnd)).toBe(turnEnd);
	});

	test("fabricate-zero adds exit_code 0 to an approved call only", () => {
		const fab = T122_EVENT_MUTATIONS["fabricate-zero"];
		expect((fab?.(callRow("approved")).rawPayload as Record<string, unknown>).exit_code).toBe(0);
		const failed = callRow("failed", { exit_code: 3 });
		expect(fab?.(failed)).toBe(failed);
	});
});
