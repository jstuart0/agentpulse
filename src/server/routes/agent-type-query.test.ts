// AGEN-44 — shared query-string agent-type parsing. An absent/empty value
// means "no filter" (unchanged). A non-empty value outside AGENT_TYPES must
// throw InvalidAgentTypeQueryError (carrying the bad value) instead of
// silently being cast through, which is what let an unknown agent_type
// produce a zero-result response instead of a 400.
import { describe, expect, test } from "bun:test";
import { AGENT_TYPES } from "../../shared/constants.js";
import { InvalidAgentTypeQueryError, parseAgentTypeQuery } from "./agent-type-query.js";

describe("parseAgentTypeQuery", () => {
	test("undefined input returns undefined (no filter)", () => {
		expect(parseAgentTypeQuery(undefined)).toBeUndefined();
	});

	test("empty string input returns undefined (no filter)", () => {
		expect(parseAgentTypeQuery("")).toBeUndefined();
	});

	for (const value of AGENT_TYPES) {
		test(`known value "${value}" round-trips`, () => {
			expect(parseAgentTypeQuery(value)).toBe(value);
		});
	}

	test("unknown value throws InvalidAgentTypeQueryError carrying the bad value", () => {
		// Not "copilot_cli" — AGENT_TYPES gained that value on this branch
		// (agent-cli-parity), so it now round-trips via the loop above instead
		// of throwing. Use a value that's genuinely outside AGENT_TYPES.
		expect(() => parseAgentTypeQuery("totally_bogus")).toThrow(InvalidAgentTypeQueryError);
		try {
			parseAgentTypeQuery("totally_bogus");
			throw new Error("expected parseAgentTypeQuery to throw");
		} catch (err) {
			expect(err instanceof InvalidAgentTypeQueryError).toBe(true);
			expect((err as InvalidAgentTypeQueryError).value).toBe("totally_bogus");
		}
	});
});
