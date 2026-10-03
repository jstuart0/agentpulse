import { describe, expect, test } from "bun:test";
import {
	HOST_PARAM_MAX_LENGTH,
	UNKNOWN_HOST_PARAM,
	hostEchoMatchesRequest,
	hostFilterEcho,
	machineMatchesHost,
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

describe("machineMatchesHost: the client's copy of the server's machine rule", () => {
	test("every machine matches everything, including a session with none", () => {
		for (const machine of ["build-01", "", "  ", null, undefined]) {
			expect(machineMatchesHost({ kind: "all" }, machine)).toBe(true);
		}
	});

	test("a machine matches only its exact name, padding aside", () => {
		const scope = { kind: "host", host: "build-01" } as const;
		expect(machineMatchesHost(scope, "build-01")).toBe(true);
		expect(machineMatchesHost(scope, "  build-01 ")).toBe(true);
		expect(machineMatchesHost(scope, "Build-01")).toBe(false);
		expect(machineMatchesHost(scope, "build-0")).toBe(false);
		expect(machineMatchesHost(scope, "build-011")).toBe(false);
		expect(machineMatchesHost(scope, null)).toBe(false);
		expect(machineMatchesHost(scope, "")).toBe(false);
	});

	test("unknown matches only a session with no machine, blank included", () => {
		const scope = { kind: "unknown" } as const;
		expect(machineMatchesHost(scope, null)).toBe(true);
		expect(machineMatchesHost(scope, "")).toBe(true);
		expect(machineMatchesHost(scope, "   ")).toBe(true);
		expect(machineMatchesHost(scope, "unknown")).toBe(false);
		expect(machineMatchesHost(scope, "build-01")).toBe(false);
	});
});

describe("hostEchoMatchesRequest", () => {
	const build = { kind: "host", host: "build-01" } as const;

	test("an echo equal to the request matches, whatever its key order", () => {
		expect(hostEchoMatchesRequest({ kind: "all" }, { kind: "all" })).toBe(true);
		expect(hostEchoMatchesRequest({ kind: "unknown" }, { kind: "unknown" })).toBe(true);
		expect(hostEchoMatchesRequest(build, { host: "build-01", kind: "host" })).toBe(true);
	});

	test("an echo for another machine, another kind or another spelling does not match", () => {
		expect(hostEchoMatchesRequest(build, { kind: "host", host: "build-02" })).toBe(false);
		expect(hostEchoMatchesRequest(build, { kind: "host", host: "Build-01" })).toBe(false);
		expect(hostEchoMatchesRequest(build, { kind: "all" })).toBe(false);
		expect(hostEchoMatchesRequest(build, { kind: "unknown" })).toBe(false);
		expect(hostEchoMatchesRequest({ kind: "unknown" }, { kind: "host", host: "unknown" })).toBe(
			false,
		);
		expect(hostEchoMatchesRequest({ kind: "all" }, build)).toBe(false);
	});

	test("a filter that was asked for needs an echo: a server that doesn't know the parameter says nothing", () => {
		expect(hostEchoMatchesRequest(build, undefined)).toBe(false);
		expect(hostEchoMatchesRequest({ kind: "unknown" }, undefined)).toBe(false);
		expect(hostEchoMatchesRequest(build, null)).toBe(false);
		expect(hostEchoMatchesRequest(build, "build-01")).toBe(false);
		expect(hostEchoMatchesRequest(build, {})).toBe(false);
	});

	test("with no filter asked for, an older server's silence is fine, but a filtered echo is not", () => {
		expect(hostEchoMatchesRequest({ kind: "all" }, undefined)).toBe(true);
		expect(hostEchoMatchesRequest({ kind: "all" }, {})).toBe(false);
	});
});
