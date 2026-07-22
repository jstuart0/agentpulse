/**
 * Tests for src/mcp/client.ts — createHttpClient (AGEN-12 Phase 2, D3 seam 1).
 *
 * All tests use a stub fetchImpl — no real network. Test contract
 * assertions 1-7 plus the URL-canonicalization and no-retry contracts
 * called out in D5/M11/M8.
 */
import { describe, expect, test } from "bun:test";
import type { DashboardStats } from "../shared/types.js";
import type { AuthMeResponse } from "./client.js";
import {
	ApiError,
	NetworkError,
	TimeoutError,
	canonicalizeBaseUrl,
	createHttpClient,
} from "./client.js";

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new Response(text, {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

describe("canonicalizeBaseUrl", () => {
	test("plain origin gets /api/v1 appended", () => {
		expect(canonicalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000/api/v1");
	});

	test("already-canonical /api/v1 base is a no-op", () => {
		expect(canonicalizeBaseUrl("http://localhost:3000/api/v1")).toBe(
			"http://localhost:3000/api/v1",
		);
	});

	test("trailing slash is normalized away", () => {
		expect(canonicalizeBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000/api/v1");
		expect(canonicalizeBaseUrl("http://localhost:3000/api/v1/")).toBe(
			"http://localhost:3000/api/v1",
		);
	});

	test("/app-api/v1 (browser alias) is rewritten to /api/v1", () => {
		expect(canonicalizeBaseUrl("https://agentpulse.example.com/app-api/v1")).toBe(
			"https://agentpulse.example.com/api/v1",
		);
	});

	test("/app-api base without /v1 is rewritten to /api/v1", () => {
		expect(canonicalizeBaseUrl("https://agentpulse.example.com/app-api")).toBe(
			"https://agentpulse.example.com/api/v1",
		);
	});

	test("preserves a non-default port and https scheme", () => {
		expect(canonicalizeBaseUrl("https://agentpulse.example.com:8443")).toBe(
			"https://agentpulse.example.com:8443/api/v1",
		);
	});
});

describe("createHttpClient", () => {
	test("sets Authorization: Bearer <apiKey> on every request", async () => {
		let recordedInit: RequestInit | undefined;
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			recordedInit = init;
			return fakeResponse(200, {
				activeSessions: 1,
				totalSessionsToday: 2,
				totalToolUsesToday: 3,
				byAgentType: {},
			});
		}) as unknown as typeof fetch;

		const client = createHttpClient({
			baseUrl: "http://localhost:3000",
			apiKey: "ap_test123",
			fetchImpl,
		});
		await client.getStats();

		const headers = new Headers(recordedInit?.headers);
		expect(headers.get("Authorization")).toBe("Bearer ap_test123");
	});

	test("passes an AbortSignal composed via AbortSignal.timeout on every call", async () => {
		let recordedInit: RequestInit | undefined;
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			recordedInit = init;
			return fakeResponse(200, {
				activeSessions: 0,
				totalSessionsToday: 0,
				totalToolUsesToday: 0,
				byAgentType: {},
			});
		}) as unknown as typeof fetch;

		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });
		await client.getStats();

		expect(recordedInit?.signal).toBeInstanceOf(AbortSignal);
	});

	test("a custom timeoutMs actually aborts the request within a short real-time bound", async () => {
		const neverResolvingFetch = ((_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(init.signal?.reason);
				});
			})) as unknown as typeof fetch;

		const client = createHttpClient({
			baseUrl: "http://localhost:3000",
			apiKey: "k",
			timeoutMs: 5,
			fetchImpl: neverResolvingFetch,
		});

		const start = Date.now();
		await expect(client.getStats()).rejects.toBeInstanceOf(TimeoutError);
		expect(Date.now() - start).toBeLessThan(500);
	});

	test("non-2xx JSON response throws ApiError with {status, body}", async () => {
		const fetchImpl = (async () =>
			fakeResponse(404, { error: "not_found" })) as unknown as typeof fetch;
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		let caught: unknown;
		try {
			await client.getStats();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ApiError);
		const err = caught as ApiError;
		expect(err.status).toBe(404);
		expect(err.body).toEqual({ error: "not_found" });
	});

	test("a malformed/truncated 2xx JSON body surfaces as a handled Error, not an unwrapped raw SyntaxError (tessa Med, mid-build hardening)", async () => {
		const fetchImpl = (async () =>
			new Response('{"activeSessions": 1, "totalSessionsTod', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		let caught: unknown;
		try {
			await client.getStats();
		} catch (err) {
			caught = err;
		}
		// Handled: a plain Error the errors.ts generic fallback can map to
		// {isError:true} — never a bare SyntaxError propagating unmapped.
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(SyntaxError);
		expect((caught as Error).message).toContain("malformed JSON");
	});

	test("non-2xx non-JSON response degrades to raw text without throwing a second error", async () => {
		const fetchImpl = (async () =>
			new Response("<html>502 Bad Gateway</html>", {
				status: 502,
				headers: { "Content-Type": "text/html" },
			})) as unknown as typeof fetch;
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		let caught: unknown;
		try {
			await client.getStats();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ApiError);
		const err = caught as ApiError;
		expect(err.status).toBe(502);
		// Body degrades gracefully — implementer's choice of shape, but it
		// must contain the raw text somewhere and must not itself throw.
		expect(JSON.stringify(err.body)).toContain("502 Bad Gateway");
	});

	test("a network-level fetch rejection surfaces as a distinguishable NetworkError, not a generic throw", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await expect(client.getStats()).rejects.toBeInstanceOf(NetworkError);
	});

	test("default fetchImpl is global fetch when omitted", async () => {
		const originalFetch = globalThis.fetch;
		let called = false;
		// @ts-expect-error monkey-patch for the assertion
		globalThis.fetch = async (..._args: unknown[]) => {
			called = true;
			return fakeResponse(200, {
				activeSessions: 0,
				totalSessionsToday: 0,
				totalToolUsesToday: 0,
				byAgentType: {},
			});
		};
		try {
			const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k" });
			await client.getStats();
			expect(called).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not retry on any request — exactly one fetchImpl call per client call, even on failure", async () => {
		let callCount = 0;
		const fetchImpl = (async () => {
			callCount++;
			return fakeResponse(500, { error: "internal" });
		}) as unknown as typeof fetch;
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await expect(client.getStats()).rejects.toBeInstanceOf(ApiError);
		expect(callCount).toBe(1);
	});

	test("getStats() resolves to the DashboardStats payload on 2xx", async () => {
		const stats: DashboardStats = {
			activeSessions: 4,
			totalSessionsToday: 9,
			totalToolUsesToday: 120,
			byAgentType: { claude_code: 3, codex_cli: 0 },
		};
		const fetchImpl = (async () => fakeResponse(200, stats)) as unknown as typeof fetch;
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await expect(client.getStats()).resolves.toEqual(stats);
	});

	test("getAuthMe() round-trips the /auth/me shape used for scope discovery", async () => {
		const meResponse: AuthMeResponse = {
			authenticated: true,
			user: { source: "api_key", name: "t", id: "1", role: null, scopes: ["observe"] },
			signOutUrl: null,
			disableAuth: false,
			allowSignup: false,
		};
		let recordedUrl: string | undefined;
		const fetchImpl = (async (url: string) => {
			recordedUrl = url;
			return fakeResponse(200, meResponse);
		}) as unknown as typeof fetch;
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		const result = await client.getAuthMe();
		expect(result).toEqual(meResponse);
		expect(recordedUrl).toBe("http://localhost:3000/api/v1/auth/me");
	});

	test("client.baseUrl exposes the canonicalized URL for callers (e.g. error messages)", () => {
		const client = createHttpClient({ baseUrl: "http://localhost:3000/app-api", apiKey: "k" });
		expect(client.baseUrl).toBe("http://localhost:3000/api/v1");
	});
});
