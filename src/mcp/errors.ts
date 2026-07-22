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

		if (status === 401) {
			return errorResult("API key rejected by AgentPulse — check AGENTPULSE_API_KEY.");
		}
		if (status === 403 && code === "insufficient_scope") {
			const required =
				body && typeof body === "object" && "required" in body
					? String((body as { required?: unknown }).required)
					: "manage";
			return errorResult(
				`AgentPulse rejected the request: this key lacks the "${required}" scope.`,
			);
		}
		if (status === 404 && code === "ai_disabled") {
			return errorResult(
				"AI features are not enabled on this AgentPulse instance (not compiled in).",
			);
		}
		if (status === 409 && code === "ai_disabled") {
			return errorResult("AI features are disabled in Settings on this AgentPulse instance.");
		}
		if (status === 409 && code === "ai_paused") {
			return errorResult("AI is paused (kill switch active) on this AgentPulse instance.");
		}
		if (status >= 400 && status < 500) {
			return errorResult(code ?? truncate(bodyText(body)));
		}
		return errorResult(`AgentPulse returned ${status}: ${truncate(bodyText(body))}`);
	}

	return errorResult(
		`Unexpected error calling AgentPulse: ${err instanceof Error ? err.message : String(err)}`,
	);
}
