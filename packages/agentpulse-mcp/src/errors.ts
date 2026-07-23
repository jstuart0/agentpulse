/**
 * Domain-failure → MCP {isError} mapping (AGEN-12 Phase 2, D5).
 *
 * AgentPulse failures NEVER surface as thrown MCP protocol errors — they're
 * always mapped to a {isError:true, content:[text]} tool result. Mapping
 * keys on the (status, error) PAIR (ai-gates.ts:12-41), not status alone:
 * ai_disabled is emitted at both 404 (not compiled in) and 409
 * (runtime-disabled) with distinct meanings, and 409 also carries the
 * unrelated ai_paused (kill switch) case. Keying off status alone would
 * collapse the two 409 cases into one message.
 *
 * `503 ai_kill_switch_active` was never shipped (ai-gates.ts:12-41) — no
 * branch exists for it; it falls through to the generic 5xx handler.
 */
import { ApiError, NetworkError, TimeoutError } from "./client.js";

export interface McpErrorResult {
	// The SDK's CallToolResult (and its Result supertype) declares a string
	// index signature for extensibility — this must be present for
	// McpErrorResult to be structurally assignable to it (server.ts's
	// wrapper return type union), even though every field we set is typed.
	[key: string]: unknown;
	isError: true;
	content: [{ type: "text"; text: string }];
}

const MAX_BODY_PREVIEW_CHARS = 1000;

function errorResult(text: string): McpErrorResult {
	return { isError: true, content: [{ type: "text", text }] };
}

function truncate(text: string, max = MAX_BODY_PREVIEW_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function bodyText(body: unknown): string {
	return typeof body === "string" ? body : JSON.stringify(body);
}

function bodyErrorCode(body: unknown): string | undefined {
	if (body && typeof body === "object" && "error" in body) {
		const value = (body as { error?: unknown }).error;
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

/**
 * Several routes (decide_action_request's 409 race_lost / 422
 * expired|failed — ai-inbox.ts:206-270) carry a human-readable `message`
 * alongside the machine `error` code. The generic 4xx fallback below prefers
 * this over the bare code so "Another approval already claimed this
 * request." reaches the caller instead of the opaque "race_lost" (tessa
 * H-5) — explicit ERROR_TABLE rows are unaffected; they already carry their
 * own message.
 */
function bodyMessage(body: unknown): string | undefined {
	if (body && typeof body === "object" && "message" in body) {
		const value = (body as { message?: unknown }).message;
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

/**
 * Declarative (status, error-code) → message table (dexter Med — was 8
 * nested `if` branches; a table iterated once scales better as Phase 3/4
 * wrap more ai-* routes, each adding another row rather than another
 * branch). `error: undefined` matches any/no error code at that status
 * (used for 401, which AgentPulse emits with varying bodies). Order
 * matters only in that the first match wins — there is currently no
 * (status, error) pair with more than one row, so this is a non-issue in
 * practice, but rows are still listed status-ascending for readability.
 * Preserves the exact message text the tests pin.
 */
const ERROR_TABLE: ReadonlyArray<{
	status: number;
	error?: string;
	message: string | ((body: unknown) => string);
}> = [
	{ status: 401, message: "API key rejected by AgentPulse — check AGENTPULSE_API_KEY." },
	{
		status: 403,
		error: "insufficient_scope",
		message: (body) => {
			const required =
				body && typeof body === "object" && "required" in body
					? String((body as { required?: unknown }).required)
					: "manage";
			return `AgentPulse rejected the request: this key lacks the "${required}" scope.`;
		},
	},
	// requireAiBuild → 404 (AI not compiled in). requireAiActive → 409
	// (compiled in but runtime-disabled) — a DIFFERENT message from both the
	// 404 case and the 409 ai_paused (kill switch) case below (ai-gates.ts:
	// 12-41; the two 409 ai_disabled/ai_paused bodies must stay distinct —
	// keying this table on the (status, error) pair, not status alone, is
	// exactly what keeps them from collapsing into one message).
	{
		status: 404,
		error: "ai_disabled",
		message: "AI features are not enabled on this AgentPulse instance (not compiled in).",
	},
	{
		status: 409,
		error: "ai_disabled",
		message: "AI features are disabled in Settings on this AgentPulse instance.",
	},
	{
		status: 409,
		error: "ai_paused",
		message: "AI is paused (kill switch active) on this AgentPulse instance.",
	},
	// Deliberately NO row for (503, "ai_kill_switch_active") — that code was
	// never shipped (ai-gates.ts:12-41). It falls through to the generic
	// 5xx handler below, which is the correct behavior for any unrecognized
	// (status, error) pair.
];

function findMapping(status: number, code: string | undefined) {
	return ERROR_TABLE.find(
		(row) => row.status === status && (row.error === undefined || row.error === code),
	);
}

/** Maps a thrown client-layer error (or anything else) to an MCP tool error result. */
export function mapError(err: unknown, baseUrl: string): McpErrorResult {
	if (err instanceof TimeoutError || err instanceof NetworkError) {
		return errorResult(
			`AgentPulse unreachable at ${baseUrl} — verify state before retrying any mutation (no automatic retries). (${err.message})`,
		);
	}

	if (err instanceof ApiError) {
		const { status, body } = err;
		const code = bodyErrorCode(body);

		const mapping = findMapping(status, code);
		if (mapping) {
			return errorResult(
				typeof mapping.message === "function" ? mapping.message(body) : mapping.message,
			);
		}
		if (status >= 400 && status < 500) {
			return errorResult(bodyMessage(body) ?? code ?? truncate(bodyText(body)));
		}
		return errorResult(`AgentPulse returned ${status}: ${truncate(bodyText(body))}`);
	}

	return errorResult(
		`Unexpected error calling AgentPulse: ${err instanceof Error ? err.message : String(err)}`,
	);
}
