import { describe, expect, test } from "bun:test";
import {
	HOST_ALL,
	HOST_UNKNOWN,
	assertHostEchoMatches,
	echoMatchesHost,
	hostStorageKey,
	hostVerdict,
	normalizedHost,
	parsedHost,
} from "./host-scope.js";
import { requestKey } from "./live-request.js";
import { ScopeMismatchError, scopeQuery } from "./owner-scope.js";

describe("the scope's machine in a request", () => {
	test("every machine adds nothing; a machine and unknown add the host", () => {
		expect(scopeQuery({ owner: "all", excludeScratch: false })).toEqual({});
		expect(scopeQuery({ owner: "all", excludeScratch: false, host: HOST_ALL })).toEqual({});
		expect(scopeQuery({ owner: "me", excludeScratch: true, host: "build-01" })).toEqual({
			owner: "me",
			excludeScratch: true,
			host: "build-01",
		});
		expect(scopeQuery({ owner: "all", excludeScratch: false, host: HOST_UNKNOWN })).toEqual({
			host: HOST_UNKNOWN,
		});
	});

	test("two scopes that differ only in machine are different questions", () => {
		const a = requestKey({ owner: "all", excludeScratch: true, host: "build-01" }, "tab");
		const b = requestKey({ owner: "all", excludeScratch: true, host: "edge-02" }, "tab");
		const none = requestKey({ owner: "all", excludeScratch: true }, "tab");
		expect(new Set([a, b, none]).size).toBe(3);
		expect(requestKey({ owner: "all", excludeScratch: true, host: "" }, "tab")).toBe(none);
	});

	test("a machine named like a filter keyword or like another field can't collide with a different scope", () => {
		const a = requestKey({ owner: "all", excludeScratch: true, host: "x|tab" });
		const b = requestKey({ owner: "all", excludeScratch: true, host: "x" }, "tab");
		expect(a).not.toBe(b);
	});
});

describe("normalizedHost and parsedHost", () => {
	test("a name is trimmed, empty is every machine, the token is unknown", () => {
		expect(normalizedHost("  build-01 ")).toBe("build-01");
		expect(normalizedHost("")).toBe(HOST_ALL);
		expect(normalizedHost(null)).toBe(HOST_ALL);
		expect(normalizedHost(HOST_UNKNOWN)).toBe(HOST_UNKNOWN);
	});

	test("a stored value outside the grammar can't hide the list: it reads as every machine", () => {
		expect(normalizedHost("a\nb")).toBe(HOST_ALL);
		expect(normalizedHost("x".repeat(500))).toBe(HOST_ALL);
		expect(parsedHost("a\nb")).toEqual({ kind: "all" });
		expect(parsedHost(undefined)).toEqual({ kind: "all" });
	});
});

describe("echo checks", () => {
	test("the matching echo passes and any other throws the scope mismatch", () => {
		expect(() =>
			assertHostEchoMatches("build-01", { kind: "host", host: "build-01" }),
		).not.toThrow();
		expect(() => assertHostEchoMatches(HOST_UNKNOWN, { kind: "unknown" })).not.toThrow();
		expect(() => assertHostEchoMatches("build-01", { kind: "host", host: "edge-02" })).toThrow(
			ScopeMismatchError,
		);
		expect(() => assertHostEchoMatches("build-01", undefined)).toThrow(ScopeMismatchError);
		expect(echoMatchesHost(undefined, undefined)).toBe(true);
		expect(echoMatchesHost(HOST_ALL, { kind: "host", host: "build-01" })).toBe(false);
	});
});

describe("hostVerdict: whether a live row belongs in the view", () => {
	test("every machine keeps every row, whatever it says about its machine", () => {
		for (const row of [{}, { machine: null }, { machine: "build-01" }]) {
			expect(hostVerdict(row, HOST_ALL)).toBe("in");
		}
	});

	test("a machine keeps its own rows and sends the others out", () => {
		expect(hostVerdict({ machine: "build-01" }, "build-01")).toBe("in");
		expect(hostVerdict({ machine: "edge-02" }, "build-01")).toBe("out");
		expect(hostVerdict({ machine: null }, "build-01")).toBe("out");
		expect(hostVerdict({ machine: "Build-01" }, "build-01")).toBe("out");
	});

	test("unknown keeps a row with no machine and sends a row with one out", () => {
		expect(hostVerdict({ machine: null }, HOST_UNKNOWN)).toBe("in");
		expect(hostVerdict({ machine: "build-01" }, HOST_UNKNOWN)).toBe("out");
	});

	test("a row that doesn't say can't be judged, under a filter, so is neither kept nor dropped on a guess", () => {
		expect(hostVerdict({}, "build-01")).toBe("unknown");
		expect(hostVerdict({}, HOST_UNKNOWN)).toBe("unknown");
	});
});

describe("storage", () => {
	test("kept per person, with a key of its own", () => {
		expect(hostStorageKey("u-1")).not.toBe(hostStorageKey("u-2"));
		expect(hostStorageKey(null)).toBe(hostStorageKey(null));
		expect(hostStorageKey("u-1")).not.toContain("groupBy");
	});
});
