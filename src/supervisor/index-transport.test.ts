/**
 * The supervisor's one transport function, `request()` in index.ts. main() performs real network calls
 * and can't be imported here, so (like index-heartbeat.test.ts) the wiring is checked on the real
 * source. What matters, and is held here:
 *  - a caller may add exactly two headers, the delivery id and the replay marker; the credential and
 *    content headers are the transport's own and can't be replaced by a caller's;
 *  - a fetch rejection (unreachable, reset, timeout) becomes a SupervisorNetworkError, distinct from an
 *    HTTP error, so callers can tell "no answer" from "answered no";
 *  - an HTTP error carries the server's Retry-After.
 * The behaviour of the pieces it uses is tested where they live (report-resilience.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DELIVERY_ID_HEADER, REPLAY_HEADER } from "../shared/hook-headers.js";

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
const START = SOURCE.indexOf("async function request(path: string, options?: RequestInit) {");
const BODY = SOURCE.slice(START, SOURCE.indexOf("\nasync function main()", START));

describe("request(): which caller headers pass", () => {
	test("the allowlist is exactly the delivery id and the replay marker", () => {
		expect(SOURCE).toMatch(/const CALLER_HEADERS = \[DELIVERY_ID_HEADER, REPLAY_HEADER\];/);
		expect(DELIVERY_ID_HEADER).toBe("X-AgentPulse-Delivery-Id");
		expect(REPLAY_HEADER).toBe("X-AgentPulse-Replay");
	});

	test("only those names are copied from the caller's headers, onto the transport's own", () => {
		expect(BODY).toContain("new Headers(options?.headers)");
		expect(BODY).toMatch(/for \(const name of CALLER_HEADERS\) \{[\s\S]*?headers\[name\] = value;/);
		// the request is sent with the merged object, never with the caller's headers as given
		expect(BODY).toMatch(/\.\.\.options,\s*headers,/);
		expect(BODY).not.toMatch(/\.\.\.options\?\.headers/);
		expect(BODY).not.toMatch(/Object\.assign\(headers/);
	});

	test("the credential headers are set before the caller's and a caller name cannot be one of them", () => {
		const credential = BODY.indexOf("X-AgentPulse-Supervisor-Token");
		const merge = BODY.indexOf("for (const name of CALLER_HEADERS)");
		expect(credential).toBeGreaterThan(-1);
		expect(credential).toBeLessThan(merge);
		expect(BODY.indexOf("headers.Authorization")).toBeLessThan(merge);
	});
});

describe("request(): failures", () => {
	test("exactly one fetch, inside a try whose catch throws SupervisorNetworkError", () => {
		expect(BODY.match(/\bfetch\(/g)?.length).toBe(1);
		const tryAt = BODY.indexOf("try {");
		const fetchAt = BODY.indexOf("fetch(");
		const catchAt = BODY.indexOf("} catch (cause) {");
		expect(tryAt).toBeGreaterThan(-1);
		expect(tryAt).toBeLessThan(fetchAt);
		expect(fetchAt).toBeLessThan(catchAt);
		expect(BODY.slice(catchAt, catchAt + 400)).toContain("throw new SupervisorNetworkError(cause)");
	});

	test("the timeout stays: a stalled server is a network failure too", () => {
		expect(BODY).toContain("signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)");
	});

	test("an HTTP error passes the response's Retry-After on", () => {
		expect(BODY).toContain('parseRetryAfterMs(res.headers.get("retry-after")');
		expect(BODY).toMatch(/new SupervisorRequestError\(\s*res\.status,/);
	});

	test("a registration retry still sees only HTTP errors: a network error is not a SupervisorRequestError", async () => {
		const { SupervisorNetworkError, SupervisorRequestError } = await import(
			"./services/report-resilience.js"
		);
		expect(new SupervisorNetworkError()).not.toBeInstanceOf(SupervisorRequestError);
	});
});
