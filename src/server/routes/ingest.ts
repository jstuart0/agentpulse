import type { Context } from "hono";
import { Hono } from "hono";
import { DELIVERY_ID_HEADER, ORIGIN_HEADER } from "../../shared/hook-headers.js";
import type { HookEventPayload, SemanticStatusUpdate } from "../../shared/types.js";
import type { AuthUser } from "../auth/middleware.js";
import { requireApiKey } from "../auth/middleware.js";
import { hookRateLimit } from "../middleware/hook-rate-limit.js";
import { parseDeliveryId, parseOrigin } from "../services/event-dedup.js";
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
	getOversizeDropped,
	getRateLimitedDropped,
	incrementBgErrorCount,
	incrementInFlightCount,
	incrementOversizeDropped,
} from "./ingest-counters.js";

// ── Per-session hook ordering queue ──────────────────────────────────────────
//
// Without serialization, two hooks for the same session arriving in rapid
// succession can both pass the "session doesn't exist" check before either
// INSERT lands, causing a unique-constraint race. Worse, a late-arriving
// non-SessionEnd hook can overwrite `endedAt`/`status` set by an earlier
// SessionEnd, making a closed session appear alive.
//
// Fix: chain all async work for a given session_id on a dedicated promise so
// hooks for the same session are processed strictly in arrival order. Hooks
// for distinct sessions remain fully parallel (different Map entries).
//
// Unbounded growth protection: cap the Map at MAX_SESSION_QUEUES entries.
// If the cap is hit, the oldest entry is evicted and its promise chain is
// effectively abandoned (the chain has already resolved or is detached).
const MAX_SESSION_QUEUES = 50_000;
const sessionTaskQueues = new Map<string, Promise<void>>();

/**
 * Enqueue `task` to run after any previously enqueued task for `sessionId`.
 * Returns immediately; the task is fire-and-forget from the caller's view.
 */
function enqueueSessionTask(sessionId: string, task: () => Promise<void>): void {
	const prior = sessionTaskQueues.get(sessionId) ?? Promise.resolve();
	const next = prior.then(task, task); // run task regardless of prior outcome
	sessionTaskQueues.set(sessionId, next);

	// Evict oldest entry if cap is exceeded.
	if (sessionTaskQueues.size > MAX_SESSION_QUEUES) {
		const oldest = sessionTaskQueues.keys().next().value;
		if (oldest !== undefined) {
			sessionTaskQueues.delete(oldest);
			console.warn(
				JSON.stringify({
					kind: "session_queue_eviction",
					level: "warn",
					evicted: oldest,
					size: sessionTaskQueues.size,
				}),
			);
		}
	}

	// Clean up the Map entry once this chain link resolves so we don't leak
	// entries for sessions that are done. The check prevents a later enqueue
	// from racing against this cleanup.
	next.then(() => {
		if (sessionTaskQueues.get(sessionId) === next) {
			sessionTaskQueues.delete(sessionId);
		}
	});
}

/** Reset for tests only — do not call in production code. */
export function _resetSessionQueuesForTest(): void {
	sessionTaskQueues.clear();
}

// Re-export counter getters for health.ts and tests.
export { getBgErrorCount, getInFlightCount, getRateLimitedDropped, getOversizeDropped };

// ── D16 (F116): body-size cap ────────────────────────────────────────────────
//
// c.req.json() buffers a body of any size before parsing, and the Phase 7
// `d:` body digest does a full stringify + sha256 pass over the uncapped
// payload — an attacker (or a runaway client) can post an arbitrarily large
// body and burn CPU/memory on every layer before this route even validates
// shape. The always-200 post-auth contract still applies: an oversize body
// is silently dropped (200, no parse, no processing), exactly like a
// rate-limited one, and counted via oversizeDropped (surfaced on /health,
// same shape as rateLimitedDropped).
export const MAX_HOOK_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Reads `request`'s body up to `maxBytes`, returning the decoded text, or
 * null if the body exceeds the cap. Checks Content-Length first (cheap,
 * catches well-behaved oversize clients without touching the body stream
 * at all), then streams the body with a running total regardless — a
 * missing or understated Content-Length (chunked transfer, a lying client)
 * is still caught, and the stream is cancelled the moment the cap is
 * crossed rather than read to completion. JSON.parse is never reached for
 * a body that fails this check.
 */
export async function readCappedBody(request: Request, maxBytes: number): Promise<string | null> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > maxBytes) return null;
	}

	const body = request.body;
	if (!body) return "";

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}

	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(combined);
}

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
ingest.post("/hooks", requireApiKey(), hookRateLimit(), async (c: Context) => {
	// D16: size cap before any parsing — an oversize body never reaches
	// JSON.parse or downstream processing.
	const bodyText = await readCappedBody(c.req.raw, MAX_HOOK_BODY_BYTES);
	if (bodyText === null) {
		incrementOversizeDropped();
		return c.json({ ok: true });
	}

	// Parse body; if malformed, return 200 with structured error log.
	// This complies with the always-200 post-auth contract.
	let parsed: HookEventPayload;
	try {
		parsed = JSON.parse(bodyText) as HookEventPayload;
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

	// Guard against valid-JSON non-object bodies (null, array, number, string).
	// JSON.parse("null") yields null; accessing .session_id on it throws outside
	// the try/catch above and breaks the always-200 contract (Hono returns 500).
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		console.warn(
			JSON.stringify({
				kind: "ingest_invalid_body_shape",
				level: "warn",
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

	// Phase 7 identity inputs (D2). Header reads and the authUser lookup are
	// synchronous, no I/O — this is the only new work allowed before the 200.
	const authUser = c.get("authUser") as AuthUser | undefined;
	const hookCtx = {
		keyId: authUser?.id ?? "anonymous",
		deliveryId: parseDeliveryId(c.req.header(DELIVERY_ID_HEADER)),
		origin: parseOrigin(c.req.header(ORIGIN_HEADER)),
	};

	// Return 200 IMMEDIATELY before any DB work (A-H1: <50ms budget).
	// Processing continues asynchronously via the per-session queue below.
	const response = c.json({ ok: true });

	// Enqueue processing for this session. All hooks for the same session_id
	// are serialized (arrival order) to prevent concurrent-insert races and
	// status-overwrite bugs. Hooks for distinct sessions remain fully parallel.
	incrementInFlightCount();
	const capturedParsed = parsed;
	const capturedAgentType = agentType;
	enqueueSessionTask(capturedParsed.session_id, async () => {
		try {
			const {
				isNew,
				session,
				events: storedEvents,
			} = await processHookEvent(capturedParsed, capturedAgentType, hookCtx);

			// Broadcast to WebSocket subscribers using the returned session row —
			// no second DB read needed (eliminates the N+1 getSession() call).
			if (isNew) {
				notifySessionCreated(session);
			} else {
				notifySessionUpdated(session);
			}

			// Broadcast exactly the rows this call stored, with their real DB
			// ids (Phase 6) — never a re-normalized, unstored, id:0 stand-in.
			// A content-window-deduped or compensated-away row is correctly
			// absent from storedEvents, so it's never broadcast either.
			for (const event of storedEvents) {
				notifyChannel("new_event", event);
			}
		} catch (err) {
			incrementBgErrorCount();
			console.error(
				JSON.stringify({
					kind: "ingest_bg_error",
					level: "error",
					// Sanitize user-controlled fields to prevent log injection.
					session_id: sanitizeLogField(capturedParsed.session_id),
					event_type: sanitizeLogField(capturedParsed.hook_event_name),
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				}),
			);
		} finally {
			decrementInFlightCount();
		}
	});

	return response;
});

// POST /api/v1/hooks/status - Receive semantic status updates
//
// Same always-200 post-auth contract as /hooks.
ingest.post("/hooks/status", requireApiKey(), hookRateLimit(), async (c) => {
	// D16: same size cap as /hooks.
	const statusBodyText = await readCappedBody(c.req.raw, MAX_HOOK_BODY_BYTES);
	if (statusBodyText === null) {
		incrementOversizeDropped();
		return c.json({ ok: true });
	}

	let update: SemanticStatusUpdate;
	try {
		update = JSON.parse(statusBodyText) as SemanticStatusUpdate;
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

	// Guard against valid-JSON non-object bodies (null, array, number, string).
	if (update === null || typeof update !== "object" || Array.isArray(update)) {
		console.warn(
			JSON.stringify({
				kind: "ingest_invalid_body_shape",
				level: "warn",
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
