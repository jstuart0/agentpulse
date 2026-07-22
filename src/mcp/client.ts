/**
 * AgentPulse REST HTTP client for the MCP server (AGEN-12 Phase 2, D3 seam 1).
 *
 * Modeled on scripts/relay.ts's Bearer-header + AbortSignal.timeout pattern
 * (relay.ts:89-93, 103-108, 19). Response shapes are imported from
 * src/shared/types.ts wherever an existing type covers them (D3/M3) — only
 * genuinely MCP-only shapes (like AuthMeResponse, which has no shared-type
 * counterpart — even src/web/lib/api.ts hand-declares it inline) are
 * declared here.
 *
 * No-retry contract (D3/M8): this client never auto-retries. A mutating
 * call that times out server-side must not be silently re-sent — the caller
 * (errors.ts's mapper) is told to verify state before retrying.
 */
import type { DashboardStats } from "../shared/types.js";

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown) {
		super(`AgentPulse API error: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

export class NetworkError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "NetworkError";
	}
}

export class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

/**
 * /auth/me response shape. No shared-type counterpart exists — even the
 * frontend client (src/web/lib/api.ts:457-471) hand-declares this inline —
 * so this is a genuinely MCP-only declaration, not a parallel hierarchy of
 * an existing type (D3/M3). Adds `scopes` (AGEN-12 Phase 1, additive) which
 * the frontend's inline copy doesn't yet reference.
 */
export interface AuthMeResponse {
	authenticated: boolean;
	user: {
		name: string;
		source: "forwardauth" | "api_key" | "local";
		provider?: string | null;
		id?: string | null;
		role?: "user" | "admin" | null;
		/** api_key callers only. forwardauth/local callers omit this field entirely. */
		scopes?: string[];
	} | null;
	signOutUrl?: string | null;
	disableAuth?: boolean;
	allowSignup?: boolean;
}

/**
 * Typed methods per AgentPulse REST endpoint the MCP server needs. Phase 2
 * ships the minimum spine (getStats, getAuthMe for scope discovery); later
 * phases add one method per tool as they're built.
 */
export interface AgentPulseClient {
	/** The canonicalized base URL (`<origin>/api/v1`) — surfaced for error messages. */
	readonly baseUrl: string;
	getStats(): Promise<DashboardStats>;
	getAuthMe(): Promise<AuthMeResponse>;
}

export interface CreateHttpClientOptions {
	baseUrl: string;
	apiKey: string;
	/** Default 8000ms, matching relay.ts's RELAY_FETCH_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Injectable for tests. Defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;

// Matches a trailing /api, /api/v1, or /api/v1/ (post app-api→api rewrite)
// so re-appending "/api/v1" below never doubles up on either form.
const API_SUFFIX_RE = /\/api(\/v1)?\/?$/;
const TRAILING_SLASH_RE = /\/+$/;

/**
 * Normalize a caller-supplied base URL to `<origin>/api/v1`. Rewrites the
 * browser-only `/app-api` alias to `/api` — the remote SSO Bearer
 * edge-bypass (deploy/k8s/07-ingressroute.yaml: PathPrefix(`/api/`) &&
 * HeaderRegexp(Authorization, Bearer ap_.*)) only matches `/api/`, not
 * `/app-api/`; a browser-copied `/app-api` base would hit forwardauth
 * instead of the Bearer bypass on a remote SSO deployment (D5/M11).
 * Idempotent: re-canonicalizing an already-canonical URL is a no-op.
 */
export function canonicalizeBaseUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	let pathname = url.pathname;
	if (pathname.startsWith("/app-api")) {
		pathname = `/api${pathname.slice("/app-api".length)}`;
	}
	pathname = pathname.replace(API_SUFFIX_RE, "");
	pathname = pathname.replace(TRAILING_SLASH_RE, "");
	return `${url.origin}${pathname}/api/v1`;
}

function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export function createHttpClient(options: CreateHttpClientOptions): AgentPulseClient {
	const baseUrl = canonicalizeBaseUrl(options.baseUrl);
	const apiKey = options.apiKey;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${apiKey}`);
		if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

		let response: Response;
		try {
			response = await fetchImpl(`${baseUrl}${path}`, {
				...init,
				headers,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			if (isTimeoutError(err)) {
				throw new TimeoutError(`Request to ${baseUrl}${path} timed out after ${timeoutMs}ms`);
			}
			throw new NetworkError(
				`Request to ${baseUrl}${path} failed: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err },
			);
		}

		if (!response.ok) {
			const raw = await response.text();
			let body: unknown;
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				body = { parseError: true, raw };
			}
			throw new ApiError(response.status, body);
		}

		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	return {
		baseUrl,
		getStats: () => request<DashboardStats>("/sessions/stats"),
		getAuthMe: () => request<AuthMeResponse>("/auth/me"),
	};
}
