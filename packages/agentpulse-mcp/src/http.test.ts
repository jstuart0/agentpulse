/**
 * Tests for http.ts — serveHttp()/createMcpHttpServer() (Phase 1 of
 * 2026-07-23-deliver-agentpulse-mcp-integration).
 *
 * Non-negotiable structural rule (test contract): at least one test in this
 * file exercises the REAL, unmocked `StreamableHTTPServerTransport`, bound
 * to a real `node:http` server listening on an ephemeral port
 * (`server.listen(0)`), driven by real `fetch()` calls from this process —
 * in practice, every test below except the fail-fast/stdout-hygiene ones
 * does exactly that. Only the injected `AgentPulseClient` (an
 * out-of-process dependency) is faked, via test-support.ts's `fakeClient()`
 * — the same convention every other test file in this package uses. The
 * bearer-check middleware itself is never faked or bypassed.
 *
 * `StreamableHTTPServerTransport.prototype.handleRequest` is spied on (via
 * bun's `spyOn`, which calls through to the real implementation by default
 * unless `.mockImplementation` is added — verified against this package's
 * own conventions before relying on it) purely to prove call counts around
 * the bearer gate; the transport's real behavior always runs underneath.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpHttpServer, serveHttp } from "./http.js";
import { fakeClient } from "./test-support.js";

const REAL_TOKEN = "s3cr3t-test-bearer-0123456789-abcdef";

class ProcessExitCalled extends Error {
	constructor(public code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

type BuiltServer = ReturnType<typeof createMcpHttpServer>;

function listenEphemeral(built: BuiltServer): Promise<string> {
	return new Promise((resolve) => {
		built.server.listen(0, "127.0.0.1", () => {
			const addr = built.server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${addr.port}`);
		});
	});
}

function closeServer(built: BuiltServer): Promise<void> {
	return new Promise((resolve, reject) => {
		built.server.close((err) => (err ? reject(err) : resolve()));
	});
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("waitUntil: timed out waiting for predicate to become true");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Starts a server (fast scope-discovery retry interval so failure tests don't stall) and waits for readiness. */
async function startReady(overrides: Parameters<typeof fakeClient>[0] = {}): Promise<{
	built: BuiltServer;
	baseUrl: string;
}> {
	const built = createMcpHttpServer({
		client: fakeClient(overrides),
		bearerToken: REAL_TOKEN,
		scopeRetryIntervalMs: 20,
	});
	const baseUrl = await listenEphemeral(built);
	await waitUntil(built.isReady);
	return { built, baseUrl };
}

interface PostMcpOptions {
	token?: string;
	extraHeaders?: Record<string, string>;
}

async function postMcp(
	baseUrl: string,
	body: unknown,
	options: PostMcpOptions = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		// The transport's handlePostRequest 406s unless BOTH content types are
		// accepted -- this is the real wire contract, not a test convenience.
		Accept: "application/json, text/event-stream",
		...options.extraHeaders,
	};
	if (options.token !== undefined) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	return fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function deleteMcp(baseUrl: string, options: PostMcpOptions = {}): Promise<Response> {
	const headers: Record<string, string> = { ...options.extraHeaders };
	if (options.token !== undefined) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	return fetch(`${baseUrl}/mcp`, { method: "DELETE", headers });
}

function initializeBody(id: number) {
	return {
		jsonrpc: "2.0",
		id,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "agentpulse-mcp-http-test", version: "0.0.0" },
		},
	};
}

function initializedNotification() {
	return { jsonrpc: "2.0", method: "notifications/initialized" };
}

function toolsListBody(id: number) {
	return { jsonrpc: "2.0", id, method: "tools/list" };
}

function toolsCallBody(id: number, name: string, args: Record<string, unknown>) {
	return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("bearer auth — constant-time, order-of-operations (assertions 1-7)", () => {
	let built: BuiltServer;
	let baseUrl: string;
	let handleRequestSpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		const started = await startReady();
		built = started.built;
		baseUrl = started.baseUrl;
		handleRequestSpy = spyOn(StreamableHTTPServerTransport.prototype, "handleRequest");
	});

	afterEach(async () => {
		handleRequestSpy.mockRestore();
		await closeServer(built);
	});

	test("1: correct bearer reaches transport.handleRequest and returns a well-formed JSON-RPC response", async () => {
		const res = await postMcp(baseUrl, initializeBody(1), { token: REAL_TOKEN });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			jsonrpc: string;
			id: number;
			result?: { protocolVersion?: string };
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(1);
		expect(body.result?.protocolVersion).toBeDefined();
		expect(handleRequestSpy).toHaveBeenCalledTimes(1);
	});

	test("2: a wrong bearer of the SAME length as the real token returns 401 and never calls handleRequest", async () => {
		const wrongSameLength = "x".repeat(REAL_TOKEN.length);
		expect(wrongSameLength.length).toBe(REAL_TOKEN.length);

		const res = await postMcp(baseUrl, initializeBody(1), { token: wrongSameLength });

		expect(res.status).toBe(401);
		expect(handleRequestSpy).not.toHaveBeenCalled();
	});

	test("3: a bearer longer than, and one shorter than, the real token both return a clean 401 (never a 500)", async () => {
		const longer = await postMcp(baseUrl, initializeBody(1), { token: `${REAL_TOKEN}extra` });
		expect(longer.status).toBe(401);

		const shorter = await postMcp(baseUrl, initializeBody(2), { token: REAL_TOKEN.slice(0, 5) });
		expect(shorter.status).toBe(401);

		expect(handleRequestSpy).not.toHaveBeenCalled();
	});

	test("4: no Authorization header at all returns 401 without throwing (guards an undefined-comparison crash)", async () => {
		const res = await postMcp(baseUrl, initializeBody(1));

		expect(res.status).toBe(401);
		expect(handleRequestSpy).not.toHaveBeenCalled();
	});

	test("5: 'Authorization: Bearer ' (empty token after the prefix) returns 401", async () => {
		const res = await postMcp(baseUrl, initializeBody(1), { token: "" });

		expect(res.status).toBe(401);
		expect(handleRequestSpy).not.toHaveBeenCalled();
	});

	test("6: the right token under the wrong scheme, or with no 'Bearer ' prefix at all, returns 401", async () => {
		const basicScheme = await postMcp(baseUrl, initializeBody(1), {
			extraHeaders: { Authorization: `Basic ${REAL_TOKEN}` },
		});
		expect(basicScheme.status).toBe(401);

		const noScheme = await postMcp(baseUrl, initializeBody(2), {
			extraHeaders: { Authorization: REAL_TOKEN },
		});
		expect(noScheme.status).toBe(401);

		expect(handleRequestSpy).not.toHaveBeenCalled();
	});

	test("7 (code-inspection): the length early-out compares buffer LENGTH, never token content, before timingSafeEqual", () => {
		// A unit test cannot mechanically prove the absence of a timing side
		// channel -- this asserts the structural shape a reviewer should also
		// read the diff for: the length guard runs first (textually) and is a
		// length-only comparison, never a direct content-level equality check
		// on the buffers/strings themselves (which is exactly what constant-time
		// comparison exists to avoid).
		const src = readFileSync(join(import.meta.dir, "http.ts"), "utf8");
		const fn = src.match(/function constantTimeEqual[\s\S]*?\n}/)?.[0];
		expect(fn).toBeDefined();
		const body = fn ?? "";

		const lengthCheckIndex = body.search(/\.length\s*!==\s*.*\.length/);
		const timingSafeEqualIndex = body.indexOf("timingSafeEqual(");
		expect(lengthCheckIndex).toBeGreaterThan(-1);
		expect(timingSafeEqualIndex).toBeGreaterThan(lengthCheckIndex);

		expect(body).not.toMatch(/presented(Buf)?\s*===\s*expected(Buf)?/);
		expect(body).not.toMatch(/presented(Buf)?\s*!==\s*expected(Buf)?/);
		expect(body).not.toMatch(/\.equals\(/);
	});
});

describe("MCP handshake sequence over real HTTP (assertions 8-11)", () => {
	let built: BuiltServer;
	let baseUrl: string;

	beforeEach(async () => {
		const started = await startReady();
		built = started.built;
		baseUrl = started.baseUrl;
	});

	afterEach(async () => {
		await closeServer(built);
	});

	test("8: initialize -> notifications/initialized -> tools/list, all authorized, yields a non-empty tool array containing get_stats", async () => {
		const initRes = await postMcp(baseUrl, initializeBody(1), { token: REAL_TOKEN });
		expect(initRes.status).toBe(200);
		const initBody = (await initRes.json()) as { result?: { protocolVersion?: string } };
		expect(initBody.result?.protocolVersion).toBeDefined();

		const notifRes = await postMcp(baseUrl, initializedNotification(), { token: REAL_TOKEN });
		expect(notifRes.status).toBe(202);

		const listRes = await postMcp(baseUrl, toolsListBody(2), { token: REAL_TOKEN });
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as { result?: { tools?: Array<{ name: string }> } };
		const tools = listBody.result?.tools ?? [];
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.some((t) => t.name === "get_stats")).toBe(true);
	});

	test("9: tools/list without the auth header returns 401 and never reaches MCP session logic", async () => {
		const handleRequestSpy = spyOn(StreamableHTTPServerTransport.prototype, "handleRequest");
		try {
			const res = await postMcp(baseUrl, toolsListBody(1));
			expect(res.status).toBe(401);
			expect(handleRequestSpy).not.toHaveBeenCalled();
		} finally {
			handleRequestSpy.mockRestore();
		}
	});

	test("10: DELETE /mcp returns a clean non-5xx response (200 or 405), never a 500 or an unhandled rejection", async () => {
		const res = await deleteMcp(baseUrl, { token: REAL_TOKEN });
		expect([200, 405]).toContain(res.status);
	});

	test("11: concurrency isolation -- two concurrent tool calls each get back their own result, uncontaminated", async () => {
		// Resolves Phase 0's flagged uncertainty: the SDK's own canonical
		// stateless example (and the installed package's source) construct a
		// FRESH McpServer + transport per request, and a shared/reused
		// stateless transport actively THROWS on its second call
		// ("Stateless transport cannot be reused across requests") -- so this
		// implementation does the same. This test proves that choice doesn't
		// let two concurrent callers see each other's in-flight state: the
		// "slow" query is stubbed to resolve after the "fast" one (fired
		// second), and each response's own JSON-RPC id/result must correlate
		// to ITS OWN request -- the fast reply arriving first would silently
		// satisfy a naive test that didn't check content, so this checks the
		// actual returned values, not just response ordering.
		const started = await startReady({
			search: async (params) => {
				if (params.q === "slow-query") {
					await new Promise((resolve) => setTimeout(resolve, 40));
				}
				return { hits: [], total: params.q.length, backend: "sqlite-fts5" as const };
			},
		});
		try {
			const [slowRes, fastRes] = await Promise.all([
				postMcp(started.baseUrl, toolsCallBody(100, "search", { q: "slow-query" }), {
					token: REAL_TOKEN,
				}),
				postMcp(started.baseUrl, toolsCallBody(200, "search", { q: "fast" }), {
					token: REAL_TOKEN,
				}),
			]);
			expect(slowRes.status).toBe(200);
			expect(fastRes.status).toBe(200);

			const slowBody = (await slowRes.json()) as {
				id: number;
				result: { content: Array<{ text: string }> };
			};
			const fastBody = (await fastRes.json()) as {
				id: number;
				result: { content: Array<{ text: string }> };
			};

			expect(slowBody.id).toBe(100);
			expect(fastBody.id).toBe(200);

			const slowResult = JSON.parse(slowBody.result.content[0]?.text ?? "{}") as { total: number };
			const fastResult = JSON.parse(fastBody.result.content[0]?.text ?? "{}") as { total: number };

			expect(slowResult.total).toBe("slow-query".length);
			expect(fastResult.total).toBe("fast".length);
		} finally {
			await closeServer(started.built);
		}
	});
});

describe("probes (assertions 12-16)", () => {
	test("12: /livez returns 200 and adds zero AgentPulse calls of its own (a legitimate startup call from discoverScopes() aside)", async () => {
		let getAuthMeCalls = 0;
		let releaseAuthMe: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseAuthMe = resolve;
		});
		const built = createMcpHttpServer({
			client: fakeClient({
				getAuthMe: async () => {
					getAuthMeCalls += 1;
					await gate;
					return {
						authenticated: true,
						user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["*"] },
						signOutUrl: null,
						disableAuth: false,
						allowSignup: false,
					};
				},
			}),
			bearerToken: REAL_TOKEN,
			scopeRetryIntervalMs: 20,
		});
		const baseUrl = await listenEphemeral(built);
		try {
			// discoverScopes()'s own startup attempt has already fired (it
			// starts eagerly, independent of any HTTP request) but is gated
			// pending -- readiness is still false, and hitting /livez must add
			// no FURTHER calls beyond that one startup attempt.
			expect(built.isReady()).toBe(false);
			const callsBeforeLivez = getAuthMeCalls;

			const res = await fetch(`${baseUrl}/livez`);

			expect(res.status).toBe(200);
			expect(getAuthMeCalls).toBe(callsBeforeLivez);
		} finally {
			releaseAuthMe?.();
			await closeServer(built);
		}
	});

	test("13: /readyz reports 503 before discoverScopes() resolves and 200 once it resolves successfully", async () => {
		let releaseAuthMe: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseAuthMe = resolve;
		});
		const built = createMcpHttpServer({
			client: fakeClient({
				getAuthMe: async () => {
					await gate;
					return {
						authenticated: true,
						user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["*"] },
						signOutUrl: null,
						disableAuth: false,
						allowSignup: false,
					};
				},
			}),
			bearerToken: REAL_TOKEN,
			scopeRetryIntervalMs: 20,
		});
		const baseUrl = await listenEphemeral(built);
		try {
			const before = await fetch(`${baseUrl}/readyz`);
			expect(before.status).toBe(503);
			expect(built.isReady()).toBe(false);

			releaseAuthMe?.();
			await waitUntil(built.isReady);

			const after = await fetch(`${baseUrl}/readyz`);
			expect(after.status).toBe(200);
		} finally {
			await closeServer(built);
		}
	});

	test("14: /readyz and /livez are both reachable WITHOUT an Authorization header", async () => {
		const started = await startReady();
		try {
			const readyRes = await fetch(`${started.baseUrl}/readyz`);
			expect(readyRes.status).toBe(200);
			const liveRes = await fetch(`${started.baseUrl}/livez`);
			expect(liveRes.status).toBe(200);
		} finally {
			await closeServer(started.built);
		}
	});

	test("15: an unrecognized path returns 404, with or without auth", async () => {
		const started = await startReady();
		try {
			const withoutAuth = await fetch(`${started.baseUrl}/nonexistent`);
			expect(withoutAuth.status).toBe(404);

			const withAuth = await fetch(`${started.baseUrl}/nonexistent`, {
				headers: { Authorization: `Bearer ${REAL_TOKEN}` },
			});
			expect(withAuth.status).toBe(404);
		} finally {
			await closeServer(started.built);
		}
	});

	test("16: discoverScopes() rejecting persistently keeps /readyz at a stable 503 forever -- chosen behavior is retry, never process.exit", async () => {
		// See the module header comment: fail-fast (like stdio) would make
		// /readyz decorative, since the whole process would crash-loop on a
		// transient AgentPulse blip instead of ever serving a 503. This
		// asserts the ACTUAL chosen behavior: the process keeps running,
		// retries in the background forever, and /readyz stays 503 the whole
		// time discovery keeps failing.
		const exitSpy = spyOn(process, "exit").mockImplementation((() => {
			throw new Error(
				"process.exit must never be called from createMcpHttpServer()'s scope-discovery retry loop -- " +
					"the chosen readiness behavior is 'retry forever, stay 503', not fail-fast",
			);
		}) as never);
		try {
			const built = createMcpHttpServer({
				client: fakeClient({
					getAuthMe: async () => {
						throw new Error("simulated AgentPulse outage");
					},
				}),
				bearerToken: REAL_TOKEN,
				scopeRetryIntervalMs: 15,
			});
			const baseUrl = await listenEphemeral(built);
			try {
				// Let a couple of retry cycles elapse.
				await new Promise((resolve) => setTimeout(resolve, 80));

				expect(built.isReady()).toBe(false);
				const res = await fetch(`${baseUrl}/readyz`);
				expect(res.status).toBe(503);
				expect(exitSpy).not.toHaveBeenCalled();
			} finally {
				await closeServer(built);
			}
		} finally {
			exitSpy.mockRestore();
		}
	});
});

describe("serveHttp() fail-fast startup checks (assertion 17)", () => {
	const originalEnv = { ...process.env };
	let exitSpy: ReturnType<typeof spyOn>;
	let stderrSpy: ReturnType<typeof spyOn>;
	let stdoutSpy: ReturnType<typeof spyOn>;
	let fetchSpy: ReturnType<typeof spyOn> | undefined;

	beforeEach(() => {
		exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitCalled(code);
		}) as never);
		stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		exitSpy.mockRestore();
		stderrSpy.mockRestore();
		stdoutSpy.mockRestore();
		fetchSpy?.mockRestore();
		fetchSpy = undefined;
		process.env = { ...originalEnv };
	});

	function stderrText(): string {
		return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
	}

	test("missing AGENTPULSE_API_KEY exits 1 before any network call", async () => {
		process.env.AGENTPULSE_API_KEY = undefined;
		process.env.MCP_HTTP_BEARER_TOKEN = "some-token";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw new Error("fetch should not be called when the API key is missing");
		}) as unknown as typeof fetch);

		await expect(serveHttp()).rejects.toBeInstanceOf(ProcessExitCalled);

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(stderrText()).toContain("AGENTPULSE_API_KEY");
	});

	test("missing MCP_HTTP_BEARER_TOKEN (API key present) exits 1 before any network call — a distinct check from the API-key one", async () => {
		process.env.AGENTPULSE_API_KEY = "ap_test_key";
		process.env.MCP_HTTP_BEARER_TOKEN = undefined;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw new Error("fetch should not be called when the bearer token is missing");
		}) as unknown as typeof fetch);

		await expect(serveHttp()).rejects.toBeInstanceOf(ProcessExitCalled);

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(stderrText()).toContain("MCP_HTTP_BEARER_TOKEN");
	});
});

describe("stdout hygiene (assertion 20)", () => {
	test("http.ts's source contains zero console.* calls of any kind (broader than the repo guard, which only catches log/debug)", () => {
		const src = readFileSync(join(import.meta.dir, "http.ts"), "utf8");
		expect(src).not.toMatch(/console\.\w+\s*\(/);
	});

	test("a full request lifecycle (a bearer-reject, then a real handshake) never writes to process.stdout", async () => {
		const started = await startReady();
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await postMcp(started.baseUrl, initializeBody(1), { token: "wrong-token" });
			await postMcp(started.baseUrl, initializeBody(2), { token: REAL_TOKEN });
			await postMcp(started.baseUrl, initializedNotification(), { token: REAL_TOKEN });
			await postMcp(started.baseUrl, toolsListBody(3), { token: REAL_TOKEN });
			await fetch(`${started.baseUrl}/livez`);
			await fetch(`${started.baseUrl}/readyz`);

			expect(stdoutSpy).not.toHaveBeenCalled();
		} finally {
			stdoutSpy.mockRestore();
			await closeServer(started.built);
		}
	});
});
