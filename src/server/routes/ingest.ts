import type { Context } from "hono";
import { Hono } from "hono";
import { DELIVERY_ID_HEADER, ORIGIN_HEADER } from "../../shared/hook-headers.js";
import type { HookEventPayload, HookEventType, SemanticStatusUpdate } from "../../shared/types.js";
import type { AuthUser } from "../auth/middleware.js";
import { requireApiKey } from "../auth/middleware.js";
import { hookRateLimit } from "../middleware/hook-rate-limit.js";
import { canonicalizeHookPayload } from "../services/agents/canonicalize.js";
import { type HookDeliveryContext, parseDeliveryId, parseOrigin } from "../services/event-dedup.js";
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
// is silently acknowledged (200, no parse), and counted via oversizeDropped
// (surfaced on /health, same shape as rateLimitedDropped).
export const MAX_HOOK_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB

// F128 (codex r2): D16 made an oversize delivery disappear entirely — before
// D16 it was stored with tool_response capped at 4 KB; after D16 nothing was
// stored at all, which can lose every event in a large delivery (a big
// Codex chunk, a huge tool_response). readCappedBody now keeps a bounded
// prefix of an overflowing body instead of discarding it, so
// extractOversizeIdentity below can recover session_id/hook_event_name and
// friends when they precede the huge field (real hook payloads always emit
// identity fields before tool_input/tool_response) and route a minimal stub
// row through the normal dedup/processHookEvent path.
export const OVERSIZE_PREFIX_BYTES = 64 * 1024; // 64 KiB

export type CappedBodyResult =
	| { oversize: false; text: string }
	| { oversize: true; prefix: string };

function decodeChunks(chunks: Uint8Array[], totalBytes: number): string {
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(combined);
}

/**
 * Reads `request`'s body up to `maxBytes`. On overflow, returns
 * `{ oversize: true, prefix }` where `prefix` is at most `OVERSIZE_PREFIX_BYTES`
 * of the body actually read — never the full oversize body, and never more
 * than a bounded amount even when Content-Length alone already proves the
 * body is oversize (that path used to skip the stream entirely; it now
 * reads just enough to capture the prefix, then cancels — still a small,
 * fixed amount of work, never proportional to the declared or actual body
 * size). A missing or understated Content-Length (chunked transfer, a lying
 * client) is still caught by the running total. JSON.parse is never reached
 * for a body that fails this check.
 */
export async function readCappedBody(
	request: Request,
	maxBytes: number,
): Promise<CappedBodyResult> {
	const contentLength = request.headers.get("content-length");
	let declaredOversize = false;
	if (contentLength !== null) {
		const declared = Number(contentLength);
		declaredOversize = Number.isFinite(declared) && declared > maxBytes;
	}

	const body = request.body;
	if (!body) {
		return declaredOversize ? { oversize: true, prefix: "" } : { oversize: false, text: "" };
	}

	const reader = body.getReader();
	const fullChunks: Uint8Array[] = [];
	const prefixChunks: Uint8Array[] = [];
	let total = 0;
	let prefixBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;

		if (prefixBytes < OVERSIZE_PREFIX_BYTES) {
			const remaining = OVERSIZE_PREFIX_BYTES - prefixBytes;
			const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			prefixChunks.push(slice);
			prefixBytes += slice.byteLength;
		}

		// Once Content-Length already proved oversize, stop as soon as the
		// bounded prefix is full — no need to keep draining toward the
		// declared (possibly huge) length just to re-confirm what the header
		// already told us.
		const overflow = total > maxBytes || (declaredOversize && prefixBytes >= OVERSIZE_PREFIX_BYTES);
		if (overflow) {
			await reader.cancel().catch(() => {});
			return { oversize: true, prefix: decodeChunks(prefixChunks, prefixBytes) };
		}
		fullChunks.push(value);
	}

	return { oversize: false, text: decodeChunks(fullChunks, total) };
}

// ── F128/F132/F133 (D19): identity extraction from an oversize body's ──────
// bounded prefix

const OVERSIZE_FIELD_MAX_LEN = 512;

const OVERSIZE_SCAN_FIELDS = new Set([
	"session_id",
	"hook_event_name",
	"tool_name",
	"tool_use_id",
	"turn_id",
	"cwd",
	"transcript_path",
]);

// Same charset convention as the codex-observer's native-marker session id
// check (D19, src/supervisor/services/codex-observer.ts SESSION_ID_CHARSET):
// session ids are UUID-shaped, so anything else is treated as an untrusted
// or garbled extraction rather than routed onward.
const OVERSIZE_SESSION_ID_CHARSET = /^[A-Za-z0-9-]{1,128}$/;

// F133 (D19): a recovered hook_event_name must be one of these, or no stub
// is built. A local literal set rather than importing from
// `src/shared/types.ts`'s ClaudeCodeEvent/CodexEvent unions — that file
// stays untouched across this campaign (plan R9), to avoid a merge conflict
// with the sibling cli-parity campaign. Not one of the seven
// parity-guarded wiring sites (scripts/check-hook-event-parity.ts); keep it
// in lockstep by hand if those unions change. CodexEvent's values are a
// subset of ClaudeCodeEvent's, so this list is exactly ClaudeCodeEvent.
const KNOWN_HOOK_EVENT_TYPES: ReadonlySet<HookEventType> = new Set<HookEventType>([
	"SessionStart",
	"SessionEnd",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"TaskCreated",
	"TaskCompleted",
	"UserPromptSubmit",
	"PermissionRequest",
	"PermissionDenied",
	"Notification",
	"PreCompact",
	"PostCompact",
	"PostToolUseFailure",
]);

/**
 * Un-escapes a JSON string body (already stripped of its surrounding
 * quotes) by hand rather than `JSON.parse('"' + body + '"')` — the ingest
 * route's own oversize test pins that JSON.parse is never reached for any
 * part of an oversize body, and a hand-rolled unescape keeps that guarantee
 * airtight instead of "only for the full body".
 */
function unescapeJsonString(raw: string): string {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch !== "\\" || i + 1 >= raw.length) {
			out += ch;
			continue;
		}
		const next = raw[i + 1];
		switch (next) {
			case '"':
			case "\\":
			case "/":
				out += next;
				i++;
				break;
			case "n":
				out += "\n";
				i++;
				break;
			case "t":
				out += "\t";
				i++;
				break;
			case "r":
				out += "\r";
				i++;
				break;
			case "b":
				out += "\b";
				i++;
				break;
			case "f":
				out += "\f";
				i++;
				break;
			case "u": {
				const hex = raw.slice(i + 2, i + 6);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					out += String.fromCharCode(Number.parseInt(hex, 16));
					i += 5;
				} else {
					out += ch;
				}
				break;
			}
			default:
				out += ch;
		}
	}
	return out;
}

/**
 * F132 (D19): scans `text` for TOP-LEVEL (depth-1) string key/value pairs
 * only, via a minimal string-aware bracket tracker — not a regex search
 * across the whole prefix, which would also match e.g. a `session_id`
 * nested inside `tool_input` and let a crafted payload forge a different
 * session's identity (F132). `text` must already start with `{` (checked by
 * the caller, after trimStart); anything else yields no fields.
 *
 * F141 (D21): the bracket tracker is a stack of expected closers, not a
 * flat depth counter. A flat counter treats `{` and `[` as interchangeable
 * — `{"tool_input":{"nested":"x"]"session_id":"attacker",...}` closes the
 * nested object with `]` instead of `}`; a counter just sees depth go
 * 2 -> 1 either way and happily reads everything after that `]` as
 * top-level, defeating F132 entirely. The stack catches the type mismatch
 * and aborts extraction outright — no partial result, no stub, just a
 * counted oversize drop.
 *
 * One linear pass over `text`, no regex and no backtracking at all — safe
 * against an adversarial prefix (e.g. thousands of unterminated
 * `"session_id":"` runs): the loop is strictly bounded by text.length
 * regardless of content, and it never JSON.parses anything.
 */
function scanTopLevelStringFields(
	text: string,
	fields: ReadonlySet<string>,
): Partial<Record<string, string>> {
	const result: Partial<Record<string, string>> = {};
	if (text[0] !== "{") return result;

	const closers: Array<"}" | "]"> = [];
	let inString = false;
	let escaped = false;
	let awaitingValue = false;
	let pendingKey: string | null = null;
	let stringStart = -1;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
				if (closers.length === 1) {
					const value = unescapeJsonString(text.slice(stringStart, i));
					if (!awaitingValue) {
						// A depth-1 string not currently answering a pending key is
						// itself a key.
						pendingKey = value;
						awaitingValue = true;
					} else {
						if (pendingKey !== null && fields.has(pendingKey) && !(pendingKey in result)) {
							result[pendingKey] = value.slice(0, OVERSIZE_FIELD_MAX_LEN);
						}
						pendingKey = null;
						awaitingValue = false;
					}
				}
				continue;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			stringStart = i + 1;
			continue;
		}
		if (ch === "{") {
			closers.push("}");
			continue;
		}
		if (ch === "[") {
			closers.push("]");
			continue;
		}
		if (ch === "}" || ch === "]") {
			const stackLenBefore = closers.length;
			const expected = closers.pop();
			if (expected === undefined || expected !== ch) {
				// F141: a mismatched (or stray) closer — this prefix isn't
				// well-formed JSON from here on, so nothing scanned so far can
				// be trusted as genuinely top-level. Abort with nothing.
				return {};
			}
			if (closers.length === 0) break; // the root object closed — done
			if (stackLenBefore === 2) {
				// A nested object/array just closed — that was pendingKey's
				// value, not a string. Ready for the next top-level key.
				awaitingValue = false;
				pendingKey = null;
			}
			continue;
		}
		if (closers.length === 1 && awaitingValue && ch === ",") {
			// A non-string value (number/bool/null) ended without a closing
			// quote of its own — ready for the next top-level key.
			awaitingValue = false;
			pendingKey = null;
		}
	}

	return result;
}

/**
 * F133 (D19): strips control characters and caps length on an extracted
 * stub field before it's ever returned — an oversize prefix is untrusted
 * input exactly like a normal body, and a recovered field must never carry
 * raw control characters into a stored row.
 */
function sanitizeStubField(
	value: string | undefined,
	maxLen = OVERSIZE_FIELD_MAX_LEN,
): string | undefined {
	if (value === undefined) return undefined;
	const cleaned = sanitizeLogField(value, maxLen);
	return cleaned.length > 0 ? cleaned : undefined;
}

export interface OversizeIdentity {
	sessionId: string;
	hookEventName: HookEventType;
	toolName?: string;
	toolUseId?: string;
	turnId?: string;
	cwd?: string;
	transcriptPath?: string;
}

/**
 * Recovers hook identity fields from an oversize body's bounded prefix.
 * Requires the (trimmed) prefix to start with `{` and extracts only
 * top-level string fields (F132); requires both session_id and
 * hook_event_name (mirroring the same `!parsed.session_id ||
 * !parsed.hook_event_name` gate the normal-size path applies), a session_id
 * matching the existing charset convention, and a hook_event_name that is a
 * known HookEventType (F133) — otherwise no stub. Every returned field is
 * control-character-stripped and length-capped (F133).
 */
export function extractOversizeIdentity(prefixText: string): OversizeIdentity | null {
	const trimmed = prefixText.trimStart();
	const fields = scanTopLevelStringFields(trimmed, OVERSIZE_SCAN_FIELDS);

	const sessionId = fields.session_id;
	if (!sessionId || !OVERSIZE_SESSION_ID_CHARSET.test(sessionId)) return null;

	const hookEventNameRaw = fields.hook_event_name;
	if (!hookEventNameRaw || !KNOWN_HOOK_EVENT_TYPES.has(hookEventNameRaw as HookEventType)) {
		return null;
	}

	return {
		sessionId,
		hookEventName: hookEventNameRaw as HookEventType,
		toolName: sanitizeStubField(fields.tool_name),
		toolUseId: sanitizeStubField(fields.tool_use_id),
		turnId: sanitizeStubField(fields.turn_id),
		cwd: sanitizeStubField(fields.cwd, 4096),
		transcriptPath: sanitizeStubField(fields.transcript_path, 4096),
	};
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

/**
 * Phase 7 identity inputs (D2), shared by the real-body and F128
 * oversize-stub paths. Never sets `oversizeStub` — only
 * handleOversizeHookDelivery does that, on its own copy (F140/D21).
 */
export function buildHookDeliveryContext(c: Context): HookDeliveryContext {
	const authUser = c.get("authUser") as AuthUser | undefined;
	return {
		keyId: authUser?.id ?? "anonymous",
		deliveryId: parseDeliveryId(c.req.header(DELIVERY_ID_HEADER)),
		origin: parseOrigin(c.req.header(ORIGIN_HEADER)),
		attribution: postingAttribution(authUser),
	};
}

/**
 * Who posted this write: the posting key's owner and the key itself. Read
 * straight off the already-resolved AuthUser set by requireApiKey() — no extra
 * lookup, synchronous, no I/O.
 */
function postingAttribution(authUser: AuthUser | undefined): {
	ownerUserId: string | null;
	ingestKeyId: string | null;
} {
	return { ownerUserId: authUser?.userId ?? null, ingestKeyId: authUser?.keyId ?? null };
}

/**
 * Enqueues normalize+dedup+persist+broadcast for one hook payload, serialized
 * per session_id (see enqueueSessionTask above). Shared by the normal-size
 * path and the F128 oversize-stub path — both need the same dedup/broadcast
 * behavior, just with a different (real vs. synthetic) payload.
 */
// Test-only seam: lets a test replace the background enqueue work for the
// duration of a call — e.g. holding it behind a latch so a DB-statement
// count taken around app.request() can't race the detached microtask chain
// (see ingest-latency.test.ts's "nothing between the 200 and
// enqueueHookProcessing" behavioral test). A no-op indirection in
// production (the override is never set).
let _enqueueHookProcessingOverride: typeof enqueueHookProcessingReal | null = null;
export function _setEnqueueHookProcessingOverrideForTest(
	fn: typeof enqueueHookProcessingReal | null,
): void {
	_enqueueHookProcessingOverride = fn;
}

function enqueueHookProcessing(
	payload: HookEventPayload,
	agentType: ReturnType<typeof detectAgentType>,
	hookCtx: HookDeliveryContext,
): void {
	(_enqueueHookProcessingOverride ?? enqueueHookProcessingReal)(payload, agentType, hookCtx);
}

function enqueueHookProcessingReal(
	payload: HookEventPayload,
	agentType: ReturnType<typeof detectAgentType>,
	hookCtx: HookDeliveryContext,
): void {
	incrementInFlightCount();
	enqueueSessionTask(payload.session_id, async () => {
		try {
			const {
				isNew,
				session,
				events: storedEvents,
			} = await processHookEvent(payload, agentType, hookCtx);

			// Broadcast to WebSocket subscribers using the returned session row —
			// no second DB read needed (eliminates the N+1 getSession() call).
			// A null row means the event was dropped (UserAcknowledge for an
			// unknown session): nothing changed, nothing to broadcast.
			if (!session) return;
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
					session_id: sanitizeLogField(payload.session_id),
					event_type: sanitizeLogField(payload.hook_event_name),
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				}),
			);
		} finally {
			decrementInFlightCount();
		}
	});
}

/**
 * F128 (codex r2): an oversize /hooks delivery. oversizeDropped is already
 * incremented by the caller for every oversize delivery, identity-bearing or
 * not. When the bounded prefix yields a usable session_id + hook_event_name,
 * a minimal synthetic payload goes through the exact same dedup/persist/
 * broadcast path as a normal hook — same hookCtx, so a stamped delivery id
 * or tool_use_id still dedups a replayed oversize delivery to one row. With
 * no usable identity, the delivery is dropped exactly as before D18's fix
 * (200, counted, nothing stored).
 */
function handleOversizeHookDelivery(c: Context, prefix: string): Response {
	const identity = extractOversizeIdentity(prefix);
	if (!identity) {
		return c.json({ ok: true });
	}

	const syntheticPayload: HookEventPayload = {
		session_id: identity.sessionId,
		hook_event_name: identity.hookEventName,
		tool_name: identity.toolName,
		tool_use_id: identity.toolUseId,
		cwd: identity.cwd,
		transcript_path: identity.transcriptPath,
	};
	const agentType = detectAgentType(c.req.header("X-Agent-Type"), syntheticPayload);
	// F140 (D21): oversizeStub is set here only — the one place a stub is
	// ever legitimately built — never derived from anything in the payload.
	const hookCtx: HookDeliveryContext = { ...buildHookDeliveryContext(c), oversizeStub: true };

	const response = c.json({ ok: true });
	enqueueHookProcessing(syntheticPayload, agentType, hookCtx);
	return response;
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
	// JSON.parse. F128: on overflow, try to recover enough identity from the
	// bounded prefix to store an informative stub row instead of dropping
	// the delivery outright.
	const capped = await readCappedBody(c.req.raw, MAX_HOOK_BODY_BYTES);
	if (capped.oversize) {
		incrementOversizeDropped();
		return handleOversizeHookDelivery(c, capped.prefix);
	}
	const bodyText = capped.text;

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

	// F140 (D21) defense in depth: strip any top-level key with the reserved
	// `agentpulse_` prefix before this payload goes anywhere near
	// processing. Stub semantics are decided solely by the server-built
	// HookDeliveryContext.oversizeStub (never by the payload — see the hook
	// normalizer and event-dedup.ts), so this has no effect on genuine
	// oversize-stub behavior; it only closes the payload off as a spoofing
	// surface for a namespace this server-side flag now owns exclusively.
	// F142 (xander): case-insensitive — `Agentpulse_Oversize` is exactly as
	// reserved as `agentpulse_oversize`.
	for (const key of Object.keys(parsed)) {
		if (key.toLowerCase().startsWith("agentpulse_")) {
			(parsed as unknown as Record<string, unknown>)[key] = undefined;
		}
	}

	const agentTypeHeader = c.req.header("X-Agent-Type");
	const agentType = detectAgentType(agentTypeHeader, parsed);
	parsed = canonicalizeHookPayload(agentType, parsed, c.req.query("event"));

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

	// Phase 7 identity inputs (D2). Header reads and the authUser lookup are
	// synchronous, no I/O — this is the only new work allowed before the 200.
	const hookCtx = buildHookDeliveryContext(c);

	// Return 200 IMMEDIATELY before any DB work (A-H1: <50ms budget).
	// Processing continues asynchronously via the per-session queue below.
	const response = c.json({ ok: true });
	enqueueHookProcessing(parsed, agentType, hookCtx);
	return response;
});

// POST /api/v1/hooks/status - Receive semantic status updates
//
// Same always-200 post-auth contract as /hooks.
ingest.post("/hooks/status", requireApiKey(), hookRateLimit(), async (c: Context) => {
	// D16: same size cap as /hooks. Status updates carry no tool identity
	// worth recovering (F128's stub-row path is /hooks-specific), so an
	// oversize status body is still a plain drop-and-count.
	const cappedStatus = await readCappedBody(c.req.raw, MAX_HOOK_BODY_BYTES);
	if (cappedStatus.oversize) {
		incrementOversizeDropped();
		return c.json({ ok: true });
	}
	const statusBodyText = cappedStatus.text;

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
	const attribution = postingAttribution(c.get("authUser") as AuthUser | undefined);

	incrementInFlightCount();
	void (async () => {
		try {
			const success = await processStatusUpdate(update, attribution);

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
