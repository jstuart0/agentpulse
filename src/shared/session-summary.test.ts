import { describe, expect, test } from "bun:test";
import {
	EVIDENCE_FACT_KINDS,
	SUMMARY_OUTCOME_LABELS,
	SUMMARY_OUTCOME_STATUSES,
	SUMMARY_SCHEMA_VERSION,
	SUMMARY_SUSPECT_REASONS,
	SUSPECT_REASON_TIER,
	type StoredEvidenceFact,
	type SummaryProvenance,
} from "./session-summary.js";

describe("shared summary vocabulary", () => {
	test("TC-4.45 outcome labels are sentence case, one per status (P4-18)", () => {
		expect(Object.keys(SUMMARY_OUTCOME_LABELS).sort()).toEqual(
			[...SUMMARY_OUTCOME_STATUSES].sort(),
		);
		expect(SUMMARY_OUTCOME_LABELS.mostly_completed).toBe("Mostly completed");
		expect(SUMMARY_OUTCOME_LABELS.partially_completed).toBe("Partially completed");
		expect(SUMMARY_OUTCOME_LABELS.in_progress).toBe("In progress");
		for (const label of Object.values(SUMMARY_OUTCOME_LABELS)) {
			expect(label).toMatch(/^[A-Z][a-z]+(?: [a-z]+)*$/);
		}
	});

	test("TC-4.46 the evidence kinds, the stored result union and the schema version are exported (P4-19, P4-20)", () => {
		expect([...EVIDENCE_FACT_KINDS]).toEqual([
			"prompt",
			"agent_message",
			"edit",
			"command",
			"validation",
			"tool",
			"event",
		]);
		expect(SUMMARY_SCHEMA_VERSION).toBe(1);
		const fact: StoredEvidenceFact = {
			kind: "validation",
			at: null,
			result: "completed",
			validationClass: "bun test",
		};
		const provenanceKeys: Array<keyof SummaryProvenance> = ["throughAt", "schemaVersion"];
		expect(fact.result).toBe("completed");
		expect(provenanceKeys).toHaveLength(2);
	});

	test("TC-4.76 the tripwire has seven codes; a risky command and a malformed address are warnings", () => {
		expect([...SUMMARY_SUSPECT_REASONS]).toEqual([
			"role_marker",
			"override_phrase",
			"pipe_to_shell",
			"unexpected_url",
			"unrecorded_command",
			"risky_command",
			"malformed_url",
		]);
		expect(SUSPECT_REASON_TIER).toEqual({
			role_marker: "warning",
			override_phrase: "warning",
			pipe_to_shell: "warning",
			unexpected_url: "note",
			unrecorded_command: "note",
			risky_command: "warning",
			malformed_url: "warning",
		});
	});
});
