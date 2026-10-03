import { describe, expect, test } from "bun:test";
import {
	HOST_PARAM_MAX_LENGTH,
	UNKNOWN_HOST_PARAM,
	hostFilterEcho,
	parseHostParam,
	resolveHostScope,
} from "./machine-scope.js";
import { sanitizeReportedHost } from "./reported-host.js";

describe("parseHostParam", () => {
	test("absent, null, empty and whitespace-only mean every machine", () => {
		for (const raw of [undefined, null, "", "   "]) {
			expect(parseHostParam(raw)).toEqual({ kind: "all" });
		}
	});

	test("a name is an exact machine, trimmed", () => {
		expect(parseHostParam("alice-mbp")).toEqual({ kind: "host", host: "alice-mbp" });
		expect(parseHostParam("  build-01 ")).toEqual({ kind: "host", host: "build-01" });
		expect(parseHostParam("Alice MBP.local")).toEqual({ kind: "host", host: "Alice MBP.local" });
	});

	test("the reserved token selects sessions with no machine", () => {
		expect(parseHostParam(UNKNOWN_HOST_PARAM)).toEqual({ kind: "unknown" });
	});

	test("the reserved token can never be a machine name the sanitiser would produce", () => {
		expect(sanitizeReportedHost(UNKNOWN_HOST_PARAM)).not.toBe(UNKNOWN_HOST_PARAM);
		for (const lookalike of ["unknown", "__unknown__", "Unknown machine", "(unknown)", "none"]) {
			expect(parseHostParam(lookalike)).toEqual({ kind: "host", host: lookalike });
		}
	});

	test("control and format characters are refused, except inside the reserved token", () => {
		for (const bad of ["a\nb", "tab\there", "nul\u0000", "bidi‮name", "line sep"]) {
			expect({ bad, parsed: parseHostParam(bad) }).toEqual({ bad, parsed: null });
		}
	});

	test("a value past the cap is refused, one at the cap is accepted", () => {
		expect(HOST_PARAM_MAX_LENGTH).toBeGreaterThanOrEqual(128);
		expect(parseHostParam("a".repeat(HOST_PARAM_MAX_LENGTH))).toEqual({
			kind: "host",
			host: "a".repeat(HOST_PARAM_MAX_LENGTH),
		});
		expect(parseHostParam("a".repeat(HOST_PARAM_MAX_LENGTH + 1))).toBeNull();
	});

	test("SQL-looking and path-looking text is just a name", () => {
		expect(parseHostParam("x' OR '1'='1")).toEqual({ kind: "host", host: "x' OR '1'='1" });
		expect(parseHostParam("../etc")).toEqual({ kind: "host", host: "../etc" });
	});
});

describe("resolveHostScope and hostFilterEcho", () => {
	test("every machine resolves to no scope; the others to themselves", () => {
		expect(resolveHostScope({ kind: "all" })).toBeUndefined();
		expect(resolveHostScope({ kind: "unknown" })).toEqual({ kind: "unknown" });
		expect(resolveHostScope({ kind: "host", host: "build-01" })).toEqual({
			kind: "host",
			host: "build-01",
		});
	});

	test("the echo names what was applied", () => {
		expect(hostFilterEcho({ kind: "all" })).toEqual({ kind: "all" });
		expect(hostFilterEcho({ kind: "unknown" })).toEqual({ kind: "unknown" });
		expect(hostFilterEcho({ kind: "host", host: "build-01" })).toEqual({
			kind: "host",
			host: "build-01",
		});
	});
});
