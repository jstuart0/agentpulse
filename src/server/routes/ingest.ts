import { Hono } from "hono";
import type { HookEventPayload, SemanticStatusUpdate } from "../../shared/types.js";
import { requireApiKey } from "../auth/middleware.js";
import { hookRateLimit } from "../middleware/hook-rate-limit.js";
import { normalizeHookEvent } from "../services/event-normalizer.js";
import {
	detectAgentType,
	processHookEvent,
	processStatusUpdate,
} from "../services/event-processor.js";
import { notifyChannel, notifySessionCreated, notifySessionUpdated } from "../services/notifier.js";
import { getSession } from "../services/session-tracker.js";
import {
	decrementInFlightCount,
	getBgErrorCount,
	getInFlightCount,
	getRateLimitedDropped,
	incrementBgErrorCount,
	incrementInFlightCount,
} from "./ingest-counters.js";

// Re-export counter getters for health.ts and tests.
export { getBgErrorCount, getInFlightCount, getRateLimitedDropped };

/**
 * Strip control characters (C0 block + DEL) and truncate to `maxLen` so that
 * user-controlled strings cannot inject newlines or ANSI escape sequences into
 * structured log streams.
 *
 * Uses charCodeAt filtering rather than a regex literal to avoid Biome's
 * noControlCharactersInRegex rule, which rejects /[\x00-\x1f\x7f]/.
 */
function sanitizeLogField(value: unknown, maxLen = 64): string {
	return String(value ?? "")
		.slice(0, maxLen)
		.split("")
		.filter((ch) => {
			const code = ch.charCodeAt(0);
			// Keep printable ASCII and above; drop C0 controls (0-31) and DEL (127).
			return code >= 32 && code !== 127;
		})
		.join("");
}

const ingest = new Hono();

// POST /api/v1/hooks - Receive hook events from Claude Code and Codex CLI
//
// Always-200 contract (post-auth):
//  - Body parse error → 200 + structured log (no downstream work).
//  - Rate-limit hit (handled by hookRateLimit middleware) → 200 silent drop.
//  - Processing exception (async) → 200 already sent; bgErrorCount++.
// Pre-auth failures (no/invalid API key) → 401/403 from requireApiKey().
ingest.post("/hooks", requireApiKey(), hookRateLimit(), async (c) => {
	// Parse body; if malformed, return 200 with structured error log.
	// This complies with the always-200 post-auth contract.
	let parsed: HookEventPayload;
	try {
		parsed = (await c.req.json()) as HookEventPayload;
	} catch (parseErr) {
		console.error(
			JSON.stringify({
				kind: "ingest_parse_error",
				level: "error",
				error: parseErr instanceof Error ? parseErr.message : String(parseErr),
			}),
		);
		return c.json({ ok: true });
	}

	if (!parsed.session_id || !parsed.hook_event_name) {
		console.warn(
			JSON.stringify({
				kind: "ingest_missing_fields",
				level: "warn",
				session_id: parsed.session_id,
				hook_event_name: parsed.hook_event_name,
			}),
		);
		return c.json({ ok: true });
	}

	const agentTypeHeader = c.req.header("X-Agent-Type");
	const agentType = detectAgentType(agentTypeHeader, parsed);

	// Return 200 IMMEDIATELY before any DB work (A-H1: <50ms budget).
	// Processing continues asynchronously in the IIFE below.
	const response = c.json({ ok: true });

	// Fire-and-forget: process the event after the response is queued.
	// Errors are counted + logged but never surface to the agent.
	incrementInFlightCount();
	void (async () => {
		try {
			const { sessionId, isNew, session } = await processHookEvent(parsed, agentType);

			// Broadcast to WebSocket subscribers using the returned session row —
			// no second DB read needed (eliminates the N+1 getSession() call).
			if (isNew) {
				notifySessionCreated(session);
			} else {
				notifySessionUpdated(session);
			}

			for (const event of normalizeHookEvent(parsed, agentType)) {
				notifyChannel("new_event", {
					id: 0,
					sessionId,
					eventType: event.eventType,
					category: event.category,
					source: event.source,
					content: event.content,
					isNoise: event.isNoise,
					providerEventType: event.providerEventType,
					toolName: event.toolName,
					toolInput: event.toolInput,
					toolResponse: event.toolResponse,
					rawPayload: event.rawPayload,
					createdAt: new Date().toISOString(),
				});
			}
		} catch (err) {
			incrementBgErrorCount();
			console.error(
				JSON.stringify({
					kind: "ingest_bg_error",
					level: "error",
					// Sanitize user-controlled fields to prevent log injection.
					session_id: sanitizeLogField(parsed.session_id),
					event_type: sanitizeLogField(parsed.hook_event_name),
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				}),
			);
		} finally {
			decrementInFlightCount();
		}
	})();

	return response;
});

// POST /api/v1/hooks/status - Receive semantic status updates
//
// Same always-200 post-auth contract as /hooks.
ingest.post("/hooks/status", requireApiKey(), hookRateLimit(), async (c) => {
	let update: SemanticStatusUpdate;
	try {
		update = (await c.req.json()) as SemanticStatusUpdate;
	} catch (parseErr) {
		console.error(
			JSON.stringify({
				kind: "ingest_status_parse_error",
				level: "error",
				error: parseErr instanceof Error ? parseErr.message : String(parseErr),
			}),
		);
		return c.json({ ok: true });
	}

	if (!update.session_id) {
		console.warn(
			JSON.stringify({
				kind: "ingest_status_missing_session_id",
				level: "warn",
			}),
		);
		return c.json({ ok: true });
	}

	// Return 200 immediately; process async.
	const response = c.json({ ok: true });

	incrementInFlightCount();
	void (async () => {
		try {
			const success = await processStatusUpdate(update);

			if (success) {
				const session = await getSession(update.session_id);
				if (session) {
					notifySessionUpdated(session);
				}
			}
		} catch (err) {
			incrementBgErrorCount();
			console.error(
				JSON.stringify({
					kind: "ingest_status_bg_error",
					level: "error",
					// Sanitize user-controlled session_id to prevent log injection.
					session_id: sanitizeLogField(update.session_id),
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				}),
			);
		} finally {
			decrementInFlightCount();
		}
	})();

	return response;
});

export { ingest };
