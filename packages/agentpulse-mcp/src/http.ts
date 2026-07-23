/**
 * Streamable-HTTP transport for the MCP server (2026-07-23-deliver-agentpulse-
 * mcp-integration, Phase 1). stdio (index.ts) is untouched byte-for-byte --
 * this is a wholly additive sibling entry point wired from cli.ts's
 * `serve-http` branch.
 *
 * ## Stateless, per-request construction (not a stylistic choice)
 *
 * Confirmed against the SDK's own canonical example
 * (github.com/modelcontextprotocol/typescript-sdk, tag v1.29.0,
 * src/examples/server/simpleStatelessStreamableHttp.ts) AND the installed
 * package's source (dist/esm/server/webStandardStreamableHttp.js): in
 * stateless mode (`sessionIdGenerator: undefined`), reusing one
 * `StreamableHTTPServerTransport` across requests is not merely
 * discouraged, it is actively rejected --
 * `handleRequest()` throws "Stateless transport cannot be reused across
 * requests. Create a new transport per request." on the SECOND call to any
 * given instance. A fresh `McpServer` (via `buildMcpServer`, cheap and pure)
 * + a fresh transport are therefore constructed for every `/mcp` request and
 * closed in `finally` once the response is sent.
 *
 * `enableJsonResponse: true` is paired with statelessness so every response
 * is a synchronous JSON body (Content-Type: application/json) rather than
 * an SSE stream -- this is also what makes `DELETE /mcp` a clean 200 instead
 * of needing any stream bookkeeping (stateless mode skips session
 * validation entirely, so DELETE just closes the fresh, never-shared
 * transport and returns).
 *
 * ## Bearer auth is the ONLY access control, not defence-in-depth
 *
 * The cluster's CNI is flannel -- NetworkPolicy is inert there, so any pod
 * in the cluster can reach this server on the wire. The bearer check below
 * is therefore the single security boundary, not a second layer behind
 * something else:
 *   - applied to every verb on /mcp, before any MCP protocol logic runs
 *     (never behind a raw `transport.handleRequest` call);
 *   - a length check runs BEFORE `crypto.timingSafeEqual` (which throws
 *     RangeError on a length mismatch) -- comparing *lengths* is safe
 *     because a token's length is not itself a secret; comparing *content*
 *     before the constant-time step would defeat the point of using one;
 *   - read from `MCP_HTTP_BEARER_TOKEN`; `serveHttp()` fails fast at
 *     startup if it is unset -- this server never serves unauthenticated.
 *
 * ## Readiness vs. fail-fast
 *
 * stdio's `serveStdio()` fails fast (`process.exit(1)`) if the startup
 * `discoverScopes()` call fails. For HTTP that would make `/readyz` purely
 * decorative -- it could only ever observe the brief pre-exit window, since
 * the whole process would then crash-loop on a transient AgentPulse blip.
 * Chosen behaviour here instead: the listener binds immediately; scope
 * discovery runs in the background and retries indefinitely on failure
 * (`scopeRetryIntervalMs`, default 5s); `/readyz` reports 503 for as long as
 * discovery keeps failing (this can be forever -- there is no attempt
 * ceiling) and flips to 200 the moment it first succeeds. The process never
 * exits once the listener is up. `/livez` never depends on any of this --
 * it is a pure "the listener is bound" check with zero outbound calls, so a
 * liveness probe wired to it can never turn a transient AgentPulse outage
 * into a pod restart loop.
 *
 * Every diagnostic in this module goes through stderrLog() -- the
 * transport's response bodies are the only thing this process ever writes
 * to stdout-adjacent channels, and stdout itself is never touched (enforced
 * by scripts/check-no-console-log-mcp.ts, plus a direct grep test in
 * http.test.ts for console.* generally, matching stdio's own discipline).
 */
import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentPulseClient } from "./client.js";
import { createHttpClient } from "./client.js";
import { stderrLog } from "./log.js";
import { discoverScopes } from "./scopes.js";
import { buildMcpServer } from "./server.js";

const DEFAULT_URL = "http://localhost:3000";
const DEFAULT_PORT = 8000;
const DEFAULT_SCOPE_RETRY_INTERVAL_MS = 5_000;
const BEARER_PREFIX = "Bearer ";

interface ReadinessState {
	ready: boolean;
	scopes: string[];
}

/**
 * Extracts the bearer token from a raw `Authorization` header value.
 * Returns `undefined` (never throws, never compares) for anything that
 * isn't exactly the `Bearer <token>` shape -- a missing header, the right
 * token under the wrong scheme (`Basic ...`), or the raw token with no
 * scheme prefix at all.
 */
function extractBearerToken(header: string | undefined): string | undefined {
	if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
		return undefined;
	}
	return header.slice(BEARER_PREFIX.length);
}

/**
 * Constant-time bearer comparison. The length check MUST run before
 * `timingSafeEqual` (Node throws a RangeError on a length mismatch) and
 * MUST be a length-only comparison -- never a content-level `===`/`.equals()`
 * on the buffers/strings themselves, which is exactly the timing side
 * channel this function exists to avoid. A token's length is not secret, so
 * branching on it is safe.
 */
function constantTimeEqual(presented: string, expected: string): boolean {
	const presentedBuf = Buffer.from(presented, "utf8");
	const expectedBuf = Buffer.from(expected, "utf8");
	if (presentedBuf.length !== expectedBuf.length) {
		return false;
	}
	return timingSafeEqual(presentedBuf, expectedBuf);
}

function isAuthorized(req: IncomingMessage, bearerToken: string): boolean {
	const presented = extractBearerToken(req.headers.authorization);
	if (presented === undefined) {
		return false;
	}
	return constantTimeEqual(presented, bearerToken);
}

function writeJsonRpcError(
	res: ServerResponse,
	status: number,
	code: number,
	message: string,
): void {
	res
		.writeHead(status, { "Content-Type": "application/json" })
		.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Handles one `/mcp` request. A fresh `McpServer` + transport pair is built
 * for every call -- see the module header comment for why this is required,
 * not optional, in stateless mode. Both are closed in `finally` regardless
 * of outcome so a long-running process never leaks per-request state.
 */
async function handleMcpRequest(
	req: IncomingMessage,
	res: ServerResponse,
	client: AgentPulseClient,
	scopes: string[],
): Promise<void> {
	const { server: mcpServer } = buildMcpServer({ client, scopes });
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});

	try {
		await mcpServer.connect(transport);
		await transport.handleRequest(req, res);
	} catch (err) {
		stderrLog(`/mcp request handling failed: ${err instanceof Error ? err.message : String(err)}`);
		if (!res.headersSent) {
			writeJsonRpcError(res, 500, -32603, "Internal server error");
		}
	} finally {
		await transport.close().catch(() => undefined);
		await mcpServer.close().catch(() => undefined);
	}
}

function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	client: AgentPulseClient,
	bearerToken: string,
	state: ReadinessState,
): void {
	const url = new URL(req.url ?? "/", "http://internal");

	// Liveness: the listener is bound and dispatching requests. Deliberately
	// dependency-free (no outbound call to AgentPulse, no reference to
	// `state`) -- a liveness probe that depends on an external service turns
	// a transient AgentPulse blip into a pod restart loop. Contentless in
	// every state (codex r2 Low) -- the status code alone is the signal;
	// no diagnostic text is ever worth exposing on an unauthenticated probe.
	if (url.pathname === "/livez") {
		res.writeHead(200).end();
		return;
	}

	// Readiness: 200 only once the startup discoverScopes() attempt (or a
	// later retry) has succeeded; 503 for as long as it keeps failing. See
	// the module header comment for why this, and not fail-fast, was chosen.
	// Contentless in every state (codex r2 Low) -- no "not ready"/"ready"
	// body, no discoverScopes() detail, no internal state; the status code
	// is the entire signal.
	if (url.pathname === "/readyz") {
		res.writeHead(state.ready ? 200 : 503).end();
		return;
	}

	if (url.pathname !== "/mcp") {
		res.writeHead(404).end();
		return;
	}

	// The bearer check is the ONLY access control this server enforces (see
	// the module header comment) -- it runs before ANY MCP protocol logic,
	// on every verb.
	if (!isAuthorized(req, bearerToken)) {
		writeJsonRpcError(res, 401, -32001, "Unauthorized");
		return;
	}

	void handleMcpRequest(req, res, client, state.scopes);
}

/**
 * Runs (and, on failure, indefinitely retries) the startup scope-discovery
 * call. Never throws -- a failure is logged and scheduled for retry;
 * success flips `state.ready`. Cancelled via the returned `stop()` when the
 * owning HTTP server closes, so a closed test/process server doesn't keep a
 * background timer (and its stderr logging) alive.
 */
function startScopeDiscovery(
	client: AgentPulseClient,
	state: ReadinessState,
	retryIntervalMs: number,
): () => void {
	let stopped = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	async function attempt(): Promise<void> {
		try {
			const scopes = await discoverScopes(client);
			state.scopes = scopes;
			state.ready = true;
		} catch (err) {
			state.ready = false;
			stderrLog(
				`AgentPulse scope discovery failed (retrying in ${retryIntervalMs}ms): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			if (stopped) {
				return;
			}
			retryTimer = setTimeout(() => {
				void attempt();
			}, retryIntervalMs);
			retryTimer.unref?.();
		}
	}

	void attempt();

	return () => {
		stopped = true;
		if (retryTimer) {
			clearTimeout(retryTimer);
		}
	};
}

export interface CreateMcpHttpServerOptions {
	client: AgentPulseClient;
	bearerToken: string;
	/**
	 * Interval between scope-discovery retries after a failed attempt.
	 * Defaults to 5000ms; test-injectable so tests don't have to wait on a
	 * real 5-second timer to observe a retry cycle.
	 */
	scopeRetryIntervalMs?: number;
}

export interface McpHttpServer {
	server: Server;
	/** True once `discoverScopes()` has resolved successfully at least once. */
	isReady(): boolean;
}

/**
 * Builds the `node:http` server: routing, the bearer gate, and the
 * background scope-discovery/readiness lifecycle. Does not call `.listen()`
 * -- callers (serveHttp() for the CLI path; tests, for an ephemeral port)
 * own that.
 */
export function createMcpHttpServer(options: CreateMcpHttpServerOptions): McpHttpServer {
	const { client, bearerToken } = options;
	const retryIntervalMs = options.scopeRetryIntervalMs ?? DEFAULT_SCOPE_RETRY_INTERVAL_MS;
	const state: ReadinessState = { ready: false, scopes: [] };

	const stopScopeDiscovery = startScopeDiscovery(client, state, retryIntervalMs);

	const server = createServer((req, res) => {
		handleRequest(req, res, client, bearerToken, state);
	});
	server.on("close", stopScopeDiscovery);

	return {
		server,
		isReady: () => state.ready,
	};
}

/**
 * CLI entry point for `agentpulse-mcp serve-http` (cli.ts's `serve-http`
 * branch). Reads all configuration from the environment; fails fast
 * (`process.exit(1)`, matching serveStdio()'s convention) on missing
 * `AGENTPULSE_API_KEY` or `MCP_HTTP_BEARER_TOKEN` -- both checks run
 * synchronously, before the client is constructed or any network call is
 * made.
 */
export async function serveHttp(): Promise<void> {
	const baseUrl = process.env.AGENTPULSE_URL || DEFAULT_URL;
	const apiKey = process.env.AGENTPULSE_API_KEY;
	const bearerToken = process.env.MCP_HTTP_BEARER_TOKEN;
	const port = Number(process.env.MCP_HTTP_PORT ?? DEFAULT_PORT);

	if (!apiKey) {
		stderrLog(
			"AGENTPULSE_API_KEY is required. Mint a key in Settings > API Keys, or run `agentpulse-mcp install`.",
		);
		process.exit(1);
	}
	if (!bearerToken) {
		stderrLog(
			"MCP_HTTP_BEARER_TOKEN is required for the streamable-HTTP transport. It is the ONLY access " +
				"control this server enforces (NetworkPolicy is inert on this cluster's CNI) -- set it to a " +
				"long random secret shared with the MCP consumer.",
		);
		process.exit(1);
	}

	const client = createHttpClient({ baseUrl, apiKey });
	const { server } = createMcpHttpServer({ client, bearerToken });

	server.listen(port, () => {
		stderrLog(
			`AgentPulse MCP server (streamable-HTTP) listening on :${port}/mcp -- /readyz will report 200 once AgentPulse scope discovery completes.`,
		);
	});
}
