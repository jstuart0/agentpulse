import { describe, expect, test } from "bun:test";
import { APPROVAL_ANSWER_REFUSALS } from "../../shared/codex-approvals.js";
import { ApiError } from "./api.js";
import { approvalErrorCopy, describeApprovalError, refusalMeansStale } from "./approval-errors.js";

const ctx = { host: "studio", owner: null, declinesAt: null, reason: null } as const;

describe("approval answer refusals", () => {
	test("every code the server can answer with has words (population floor: the whole list)", () => {
		expect(APPROVAL_ANSWER_REFUSALS.length).toBeGreaterThanOrEqual(13);
		for (const code of APPROVAL_ANSWER_REFUSALS) {
			expect(approvalErrorCopy(code, ctx), code).not.toBeNull();
		}
		expect(approvalErrorCopy("not_a_code", ctx)).toBeNull();
	});

	test("turn_interrupted says the request was declined and nothing ran, and makes the card read fresh", () => {
		expect(approvalErrorCopy("turn_interrupted", ctx)).toBe(
			"The turn was stopped, so this was declined. Nothing ran.",
		);
		expect(refusalMeansStale("turn_interrupted")).toBe(true);
		// Positive control: a refusal that leaves the row as it is is not stale.
		expect(refusalMeansStale("not_owner")).toBe(false);
		const view = describeApprovalError(
			new ApiError(409, "refused", { error: "turn_interrupted" }),
			ctx,
		);
		expect(view).toMatchObject({ unconfirmed: false, stale: true });
		expect(view.text).toContain("Nothing ran");
	});
});
