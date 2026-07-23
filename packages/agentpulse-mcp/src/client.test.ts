/**
 * Tests for client.ts — createHttpClient (AGEN-12 Phase 2, D3 seam 1).
 *
 * All tests use a stub fetchImpl — no real network. Test contract
 * assertions 1-7 plus the URL-canonicalization and no-retry contracts
 * called out in D5/M11/M8.
 */
import { describe, expect, test } from "bun:test";
import type { AuthMeResponse } from "./client.js";
import {
	ApiError,
	NetworkError,
	TimeoutError,
	canonicalizeBaseUrl,
	createHttpClient,
} from "./client.js";
import type { DashboardStats } from "./types.js";

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

/**
 * Phase 3 mid-build (tessa H-3): request-construction coverage for the
 * Phase 3 methods client.test.ts never exercised past Phase 2's
 * getStats/getAuthMe. Pins the EXACT query string each REST route
 * requires — including snake/camel-case param-name mismatches (getSessions
 * sends `agent_type` snake but `projectId` camel; listTemplates sends
 * `agent_type` snake; getInbox sends `sessionId` camel) — so a future
 * rename of a toQuery() call site can't silently break a query.
 */
describe("createHttpClient — Phase 3 request construction (tessa H-3)", () => {
	function recordingFetch(body: unknown) {
		let recordedUrl: string | undefined;
		const fetchImpl = (async (url: string) => {
			recordedUrl = url;
			return fakeResponse(200, body);
		}) as unknown as typeof fetch;
		return { fetchImpl, getUrl: () => recordedUrl };
	}

	test("getSessions() sends agent_type (snake) + projectId (camel) + status/limit/offset", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ sessions: [], total: 0 });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.getSessions({
			status: "active",
			agentType: "claude_code",
			projectId: "proj-1",
			limit: 10,
			offset: 5,
		});

		const url = new URL(getUrl() ?? "");
		expect(url.pathname).toBe("/api/v1/sessions");
		expect(url.searchParams.get("status")).toBe("active");
		expect(url.searchParams.get("agent_type")).toBe("claude_code");
		expect(url.searchParams.get("projectId")).toBe("proj-1");
		expect(url.searchParams.has("agentType")).toBe(false);
		expect(url.searchParams.has("project_id")).toBe(false);
		expect(url.searchParams.get("limit")).toBe("10");
		expect(url.searchParams.get("offset")).toBe("5");
	});

	test("getSessions() with no params omits every query key entirely", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ sessions: [], total: 0 });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.getSessions();

		expect(getUrl()).toBe("http://localhost:3000/api/v1/sessions");
	});

	test("search() sends q/kinds(comma-joined)/limit/offset", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ hits: [], total: 0, backend: "sqlite-fts5" });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.search({ q: "hello world", kinds: ["session", "event"], limit: 20, offset: 0 });

		const url = new URL(getUrl() ?? "");
		expect(url.pathname).toBe("/api/v1/search");
		expect(url.searchParams.get("q")).toBe("hello world");
		expect(url.searchParams.get("kinds")).toBe("session,event");
		expect(url.searchParams.get("limit")).toBe("20");
		expect(url.searchParams.get("offset")).toBe("0");
	});

	test("listTemplates() sends agent_type (snake)", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ templates: [], total: 0 });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.listTemplates({ agentType: "codex_cli" });

		const url = new URL(getUrl() ?? "");
		expect(url.pathname).toBe("/api/v1/templates");
		expect(url.searchParams.get("agent_type")).toBe("codex_cli");
		expect(url.searchParams.has("agentType")).toBe(false);
	});

	test("listTemplates() with no filter omits the query entirely", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ templates: [], total: 0 });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.listTemplates();

		expect(getUrl()).toBe("http://localhost:3000/api/v1/templates");
	});

	test("getInbox() sends sessionId (camel) + kinds(comma-joined) + severity + limit", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ items: [], total: 0, byKind: {} });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.getInbox({
			kinds: ["hitl", "stuck"],
			sessionId: "s1",
			severity: "high",
			limit: 50,
		});

		const url = new URL(getUrl() ?? "");
		expect(url.pathname).toBe("/api/v1/ai/inbox");
		expect(url.searchParams.get("sessionId")).toBe("s1");
		expect(url.searchParams.has("session_id")).toBe(false);
		expect(url.searchParams.get("kinds")).toBe("hitl,stuck");
		expect(url.searchParams.get("severity")).toBe("high");
		expect(url.searchParams.get("limit")).toBe("50");
	});

	test("getSession()/getTemplate()/getLaunch() URL-encode the path segment", async () => {
		const { fetchImpl, getUrl } = recordingFetch({
			session: {},
			events: [],
			controlActions: undefined,
		});
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.getSession("s 1/weird");

		expect(getUrl()).toBe("http://localhost:3000/api/v1/sessions/s%201%2Fweird");
	});

	test("getSessionTimeline()/getEventContext() route params correctly", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ events: [], target: { id: 1 } });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.getEventContext("s1", 42, 15);

		const url = new URL(getUrl() ?? "");
		expect(url.pathname).toBe("/api/v1/sessions/s1/events/42/context");
		expect(url.searchParams.get("around")).toBe("15");
	});

	test("listLaunches() happy path resolves the launches/total shape", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ launches: [], total: 0 });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		const result = await client.listLaunches();

		expect(getUrl()).toBe("http://localhost:3000/api/v1/launches");
		expect(result).toEqual({ launches: [], total: 0 });
	});

	test("getLaunch() resolves and hits the correct path", async () => {
		const { fetchImpl, getUrl } = recordingFetch({ launchRequest: { id: "l1" }, session: null });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		const result = await client.getLaunch("l1");

		expect(getUrl()).toBe("http://localhost:3000/api/v1/launches/l1");
		expect(result.launchRequest.id).toBe("l1");
		expect(result.session).toBeNull();
	});
});

/**
 * Phase 4 request-construction coverage (H-3's remediation pattern applied
 * fresh to the highest field-name-fidelity-risk new methods — not all 13,
 * since most are near-identity JSON.stringify passthroughs; these are the
 * ones with a literal-field-value contract (renameSession's `source`) or a
 * server-field-name that could plausibly be renamed to something else by a
 * future refactor without a test catching it).
 */
describe("createHttpClient — Phase 4 request construction", () => {
	function recordingFetch(body: unknown) {
		let recordedUrl: string | undefined;
		let recordedInit: RequestInit | undefined;
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			recordedUrl = url;
			recordedInit = init;
			return fakeResponse(200, body);
		}) as unknown as typeof fetch;
		return {
			fetchImpl,
			getUrl: () => recordedUrl,
			getMethod: () => recordedInit?.method,
			getBody: () => (recordedInit?.body ? JSON.parse(String(recordedInit.body)) : undefined),
		};
	}

	test("createLaunch() POSTs /launches with templateId+template+launchSpec intact (the H1 body launch_agent depends on)", async () => {
		const { fetchImpl, getUrl, getMethod, getBody } = recordingFetch({
			launchRequest: { id: "lr1" },
			supervisor: { id: "sup1" },
		});
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.createLaunch({
			templateId: "t1",
			template: { name: "n", agentType: "codex_cli", cwd: "/repo" },
			launchSpec: { launchCorrelationId: "corr-1" } as never,
			desiredDisplayName: "my session",
		});

		expect(getUrl()).toBe("http://localhost:3000/api/v1/launches");
		expect(getMethod()).toBe("POST");
		const body = getBody();
		expect(body.templateId).toBe("t1");
		expect(body.template).toEqual({ name: "n", agentType: "codex_cli", cwd: "/repo" });
		expect(body.launchSpec).toEqual({ launchCorrelationId: "corr-1" });
		expect(body.desiredDisplayName).toBe("my session");
	});

	test("renameSession() PUTs the literal {name, source} body (repo's documented rename-precedence contract)", async () => {
		const { getUrl, getMethod, getBody, fetchImpl } = recordingFetch({ ok: true });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.renameSession("s1", "New Name", "user");

		expect(getUrl()).toBe("http://localhost:3000/api/v1/sessions/s1/rename");
		expect(getMethod()).toBe("PUT");
		expect(getBody()).toEqual({ name: "New Name", source: "user" });
	});

	test("promptSession() POSTs {prompt} matching sessions.ts:162's shape", async () => {
		const { getUrl, getMethod, getBody, fetchImpl } = recordingFetch({ action: {} });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.promptSession("s1", "keep going");

		expect(getUrl()).toBe("http://localhost:3000/api/v1/sessions/s1/prompt");
		expect(getMethod()).toBe("POST");
		expect(getBody()).toEqual({ prompt: "keep going" });
	});

	test("decideHitl() POSTs {action, customPrompt} to the hitl decide path", async () => {
		const { getUrl, getMethod, getBody, fetchImpl } = recordingFetch({ hitl: null });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.decideHitl("h1", "custom", "do X instead");

		expect(getUrl()).toBe("http://localhost:3000/api/v1/ai/inbox/hitl/h1/decide");
		expect(getMethod()).toBe("POST");
		expect(getBody()).toEqual({ action: "custom", customPrompt: "do X instead" });
	});

	test("decideHitl() with no customPrompt omits the key entirely rather than sending null", async () => {
		const { getBody, fetchImpl } = recordingFetch({ hitl: null });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.decideHitl("h1", "approve");

		expect(getBody()).toEqual({ action: "approve" });
		expect(Object.keys(getBody())).not.toContain("customPrompt");
	});

	test("decideActionRequest() POSTs {decision} to the action-requests decide path", async () => {
		const { getUrl, getMethod, getBody, fetchImpl } = recordingFetch({ actionRequest: null });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.decideActionRequest("ar1", "declined");

		expect(getUrl()).toBe("http://localhost:3000/api/v1/ai/action-requests/ar1/decide");
		expect(getMethod()).toBe("POST");
		expect(getBody()).toEqual({ decision: "declined" });
	});

	test("listHosts() hits the admin supervisors path with GET", async () => {
		const { getUrl, getMethod, fetchImpl } = recordingFetch({ supervisors: [], total: 0 });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.listHosts();

		expect(getUrl()).toBe("http://localhost:3000/api/v1/admin/supervisors");
		expect(getMethod()).toBeUndefined();
	});

	// AGEN-12 Phase 5: createApiKey backs install.ts's mintKey.
	test("createApiKey() POSTs the exact {name, scopes} body to /api-keys", async () => {
		const { getUrl, getMethod, getBody, fetchImpl } = recordingFetch({
			id: "k1",
			key: "ap_test",
			name: "mcp",
			scopes: ["observe"],
			message: "Save this key -- it will not be shown again.",
		});
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.createApiKey("mcp", ["observe"]);

		expect(getUrl()).toBe("http://localhost:3000/api/v1/api-keys");
		expect(getMethod()).toBe("POST");
		expect(getBody()).toEqual({ name: "mcp", scopes: ["observe"] });
	});

	test("deleteTemplate() DELETEs the template path with no body", async () => {
		const { getUrl, getMethod, fetchImpl } = recordingFetch({ ok: true });
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });

		await client.deleteTemplate("t1");

		expect(getUrl()).toBe("http://localhost:3000/api/v1/templates/t1");
		expect(getMethod()).toBe("DELETE");
	});
});
