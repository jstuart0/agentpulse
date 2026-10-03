import { describe, expect, test } from "bun:test";
import {
	REPORTED_HOST_MAX_LENGTH,
	encodeReportedHostHeader,
	parseReportedHostHeader,
	sanitizeReportedHost,
} from "./reported-host.js";

describe("sanitizeReportedHost", () => {
	test("keeps an ordinary machine name as is", () => {
		expect(sanitizeReportedHost("alice-mbp.local")).toBe("alice-mbp.local");
	});

	test("trims surrounding whitespace", () => {
		expect(sanitizeReportedHost("  build box \t")).toBe("build box");
	});

	test("strips control characters (newline, tab, escape, NUL, DEL)", () => {
		expect(sanitizeReportedHost("a\nb\tc\u001b[31md\u0000e\u007ff")).toBe("abc[31mdef");
	});

	test("strips format characters (zero-width, bidi overrides and isolates, BOM)", () => {
		expect(sanitizeReportedHost("a​b‮c⁦d﻿e")).toBe("abcde");
	});

	test("strips line and paragraph separators", () => {
		expect(sanitizeReportedHost("a b c")).toBe("abc");
	});

	test("collapses runs of interior whitespace, NBSP and other space separators to one space", () => {
		expect(sanitizeReportedHost("a   b")).toBe("a b");
		expect(sanitizeReportedHost("a\u00a0\u00a0b")).toBe("a b");
		expect(sanitizeReportedHost("a\u2003\u3000 \u202fb")).toBe("a b");
		expect(sanitizeReportedHost("my  \u00a0 box  name")).toBe("my box name");
	});

	test("strips lone surrogates", () => {
		expect(sanitizeReportedHost("bad\ud800name")).toBe("badname");
	});

	test("rejects a value that is empty once cleaned", () => {
		expect(sanitizeReportedHost("")).toBeNull();
		expect(sanitizeReportedHost("   ")).toBeNull();
		expect(sanitizeReportedHost("\n\t​")).toBeNull();
	});

	test("rejects anything that is not a string", () => {
		expect(sanitizeReportedHost(undefined)).toBeNull();
		expect(sanitizeReportedHost(null)).toBeNull();
		expect(sanitizeReportedHost(42)).toBeNull();
		expect(sanitizeReportedHost({ toString: () => "x" })).toBeNull();
	});

	test("caps at 128 characters", () => {
		expect(REPORTED_HOST_MAX_LENGTH).toBe(128);
		expect(sanitizeReportedHost("h".repeat(500))).toBe("h".repeat(128));
	});

	test("the cap counts characters, so it never cuts an emoji in half", () => {
		const out = sanitizeReportedHost("😀".repeat(200)) ?? "";
		expect(Array.from(out)).toHaveLength(128);
		expect(out).toBe("😀".repeat(128));
	});

	test("the cap is applied after trimming and stripping", () => {
		const out = sanitizeReportedHost(`${"​".repeat(300)}  ${"h".repeat(10)}`);
		expect(out).toBe("h".repeat(10));
	});

	test("markup is kept as literal text (React escapes it; nothing is rewritten here)", () => {
		expect(sanitizeReportedHost("<img src=x onerror=alert(1)>")).toBe(
			"<img src=x onerror=alert(1)>",
		);
	});

	test("keeps a non-ASCII name such as a typographic apostrophe", () => {
		expect(sanitizeReportedHost("Alex’s MacBook Pro")).toBe("Alex’s MacBook Pro");
	});
});

describe("parseReportedHostHeader", () => {
	test("a missing header is no host", () => {
		expect(parseReportedHostHeader(undefined)).toBeNull();
		expect(parseReportedHostHeader(null)).toBeNull();
		expect(parseReportedHostHeader("")).toBeNull();
	});

	test("a plain ASCII value is used as is", () => {
		expect(parseReportedHostHeader("alice-mbp")).toBe("alice-mbp");
	});

	test("a percent-encoded value is decoded", () => {
		expect(parseReportedHostHeader("Alex%E2%80%99s%20MacBook")).toBe("Alex’s MacBook");
	});

	test("a decoded value is sanitised too", () => {
		expect(parseReportedHostHeader("ok%0A%1B%5B31m%E2%80%AEevil")).toBe("ok[31mevil");
	});

	test("a malformed escape is rejected, not passed through", () => {
		expect(parseReportedHostHeader("bad%E2%80")).toBeNull();
		expect(parseReportedHostHeader("100%")).toBeNull();
	});

	test("an oversized header is rejected before it is decoded", () => {
		expect(parseReportedHostHeader("a".repeat(5000))).toBeNull();
	});

	test("the longest value a sender can produce still gets through", () => {
		const name = "😀".repeat(REPORTED_HOST_MAX_LENGTH);
		expect(parseReportedHostHeader(encodeReportedHostHeader(name))).toBe(name);
	});
});

describe("encodeReportedHostHeader (what the senders put on the wire)", () => {
	test("is always a valid header value, even for a name with characters outside Latin-1", () => {
		const encoded = encodeReportedHostHeader("Alex’s \u{1F4BB} é");
		expect(() => new Headers({ "X-AgentPulse-Host": encoded })).not.toThrow();
		expect(encoded).toMatch(/^[\x21-\x7e]*$/);
	});

	test("round-trips through the parser", () => {
		const name = "Alex’s MacBook Pro (2)";
		expect(parseReportedHostHeader(encodeReportedHostHeader(name))).toBe(name);
	});

	test("cuts a very long name to the cap before encoding", () => {
		const encoded = encodeReportedHostHeader("x".repeat(1000));
		expect(parseReportedHostHeader(encoded)).toBe("x".repeat(128));
	});
});
