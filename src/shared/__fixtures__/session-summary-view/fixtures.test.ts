import { describe, expect, test } from "bun:test";
import {
	SUMMARY_ATTEMPT_STATUSES,
	SUMMARY_ERROR_CODES,
	SUMMARY_REFUSAL_CODES,
} from "../../session-summary-view.js";
import {
	FAILED_VIEW_FIXTURES,
	REFUSAL_BODY_FIXTURES,
	SUMMARY_VIEW_FIXTURES,
	failedWith,
	shapeOf,
} from "./index.js";

describe("shapeOf", () => {
	test("TC-6.5a leaves become tags, and keys are sorted at every depth", () => {
		const shape = shapeOf({
			z: 1,
			a: { y: "x", b: [true, null, 2.5, "2026-10-04T09:00:00.000Z"] },
		});
		expect(shape).toEqual({
			a: { b: ["bool", "null", "number", "iso"], y: "string" },
			z: "int",
		});
		expect(JSON.stringify(shape)).toBe(
			'{"a":{"b":["bool","null","number","iso"],"y":"string"},"z":"int"}',
		);
	});

	test("TC-6.5b null and absent differ, and an extra key shows", () => {
		expect(shapeOf({ a: null })).not.toEqual(shapeOf({}));
		expect(shapeOf({ a: 1, ownerUserId: "u1" })).not.toEqual(shapeOf({ a: 1 }));
		expect(shapeOf({ a: undefined })).toEqual(shapeOf({}));
	});

	test("TC-6.5c an ISO instant is not just a string, an int is not a fractional number, a date-like string stays a string", () => {
		expect(shapeOf("2026-10-04T09:00:00.000Z")).toBe("iso");
		expect(shapeOf("2026-10-04 09:00:00")).toBe("string");
		expect(shapeOf("2026-10-04T09:00:00+02:00")).toBe("string");
		expect(shapeOf(3)).toBe("int");
		expect(shapeOf(0.5)).toBe("number");
		expect(shapeOf([])).toEqual([]);
		expect(() => shapeOf(() => 1)).toThrow();
	});

	test("TC-6.5d a JSON round trip changes no fixture's shape, so a fixture holds no undefined or non-JSON value", () => {
		for (const [name, view] of Object.entries(SUMMARY_VIEW_FIXTURES)) {
			expect(shapeOf(JSON.parse(JSON.stringify(view))), name).toEqual(shapeOf(view));
		}
		for (const [code, view] of Object.entries(FAILED_VIEW_FIXTURES)) {
			expect(shapeOf(JSON.parse(JSON.stringify(view))), code).toEqual(shapeOf(view));
		}
	});
});

describe("the fixtures", () => {
	test("TC-6.5e a failed view exists for every error code, built by failedWith", () => {
		expect(Object.keys(FAILED_VIEW_FIXTURES).sort()).toEqual([...SUMMARY_ERROR_CODES].sort());
		for (const code of SUMMARY_ERROR_CODES) {
			const view = FAILED_VIEW_FIXTURES[code];
			expect(view.attempt.status, code).toBe("failed");
			expect(view.attempt.errorCode, code).toBe(code);
			expect(view, code).toEqual(failedWith(code));
		}
		expect(SUMMARY_VIEW_FIXTURES.failed).toEqual(FAILED_VIEW_FIXTURES.parse_failed);
		expect(SUMMARY_VIEW_FIXTURES.interrupted).toEqual(FAILED_VIEW_FIXTURES.interrupted);
		expect(SUMMARY_VIEW_FIXTURES.failed_ai_inactive.stored).not.toBeNull();
	});

	test("TC-6.5f a refusal body exists for every refusal code, each naming its own code", () => {
		expect(Object.keys(REFUSAL_BODY_FIXTURES).sort()).toEqual([...SUMMARY_REFUSAL_CODES].sort());
		for (const code of SUMMARY_REFUSAL_CODES) {
			const { status, body } = REFUSAL_BODY_FIXTURES[code];
			expect(body.error, code).toBe(code);
			expect([404, 409, 429, 503], code).toContain(status);
		}
	});

	test("TC-6.5g the refusals that carry numbers carry them, and only those", () => {
		for (const code of [
			"summary_rate_limited",
			"shutting_down",
			"busy",
			"summary_cooldown",
		] as const) {
			const body = REFUSAL_BODY_FIXTURES[code].body;
			expect(Number.isInteger(body.retryAfterSeconds), code).toBe(true);
			expect(body.spentCents, code).toBeUndefined();
		}
		const cap = REFUSAL_BODY_FIXTURES.spend_cap_reached.body;
		expect(typeof cap.spentCents).toBe("number");
		expect(typeof cap.capCents).toBe("number");
		expect(typeof cap.maxCostCents).toBe("number");
		expect(cap.retryAfterSeconds).toBeUndefined();
		for (const code of ["ai_paused", "no_provider", "too_little_activity"] as const) {
			expect(Object.keys(REFUSAL_BODY_FIXTURES[code].body), code).toEqual(["error"]);
		}
	});

	test("TC-6.5h the states the reviewers asked for are present with the values that make them distinct", () => {
		const F = SUMMARY_VIEW_FIXTURES;
		expect(F.partial.stored?.provenance.coverage.status).toBe("partial");
		expect(F.partial.stored?.provenance.coverage.cutoffAt).not.toBeNull();
		expect(F.adjusted.stored?.provenance.adjustments.map((a) => a.code)).toEqual([
			"outcome_clamped",
			"validation_adjusted",
			"note_completed_with_failed_validation",
		]);
		expect(F.free_cost.spend.maxCostCents).toBe(0);
		expect(F.free_cost.stored?.provenance.costCents).toBe(0);
		expect(F.stale_one.staleEvents).toBe(1);
		expect(F.suspect_note.stored?.provenance.suspectReasons).toEqual([
			"unexpected_url",
			"unrecorded_command",
		]);
		expect(F.suspect_warning.stored?.provenance.suspectReasons).toContain("role_marker");
		for (const name of ["suspect", "suspect_note", "suspect_warning"] as const) {
			expect(F[name].stored?.provenance.suspect, name).toBe(true);
		}
		expect(F.ready.stored?.provenance.suspectReasons).toEqual([]);
		for (const view of Object.values(F)) {
			expect(SUMMARY_ATTEMPT_STATUSES).toContain(view.attempt.status);
		}
	});
});
