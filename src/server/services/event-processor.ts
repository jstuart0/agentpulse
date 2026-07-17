import { eq, inArray, sql } from "drizzle-orm";
import {
	EVENT_DUPLICATE_WINDOW_MS,
	areNearInTime,
	getEventSourcePriority,
	normalizeComparableContent,
} from "../../shared/event-authority.js";
import type {
	AgentType,
	EventCategory,
	EventSource,
	HookEventPayload,
	SemanticStatus,
	SemanticStatusUpdate,
} from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { events, sessions } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { evaluateAlertRules } from "./ai/alert-rule-evaluator.js";
import {
	type NormalizedEvent,
	normalizeHookEvent,
	normalizeStatusEvents,
} from "./event-normalizer.js";
import { associateObservedSession } from "./launch-dispatch.js";
import { generateSessionName } from "./name-generator.js";
import { getCachedProjects } from "./projects/cache.js";
import { resolveProjectIdForCwd } from "./projects/resolver.js";

function chooseHigherAuthorityEvent<
	T extends { source: EventSource | string; createdAt?: string | null },
>(left: T, right: T) {
	const leftPriority = getEventSourcePriority(left.source);
	const rightPriority = getEventSourcePriority(right.source);
	if (leftPriority !== rightPriority) return leftPriority > rightPriority ? left : right;
	return (left.createdAt || "") >= (right.createdAt || "") ? left : right;
}

type AuthorityComparableEvent = {
	id?: number;
	category: EventCategory | null;
	source: EventSource | string;
	content: string | null;
	createdAt?: string | null;
};

function isAssistantAuthorityDuplicate(
	existing: AuthorityComparableEvent,
	incoming: AuthorityComparableEvent,
) {
	if (existing.category !== "assistant_message" || incoming.category !== "assistant_message")
		return false;
	if (
		!normalizeComparableContent(existing.content) ||
		!normalizeComparableContent(incoming.content)
	)
		return false;
	if (normalizeComparableContent(existing.content) !== normalizeComparableContent(incoming.content))
		return false;
	if (!areNearInTime(existing.createdAt, incoming.createdAt, EVENT_DUPLICATE_WINDOW_MS))
		return false;
	return getEventSourcePriority(existing.source) !== getEventSourcePriority(incoming.source);
}

function buildDedupKey(event: {
	eventType: string;
	category: string | null;
	source: string;
	content: string | null;
	providerEventType: string | null;
	rawPayload?: Record<string, unknown>;
}) {
	const transcriptId =
		typeof event.rawPayload?.transcript_uuid === "string"
			? event.rawPayload.transcript_uuid
			: typeof event.rawPayload?.transcript_timestamp === "string"
				? event.rawPayload.transcript_timestamp
				: "";
	return [
		event.eventType || "",
		event.category || "",
		event.source || "",
		event.content || "",
		event.providerEventType || "",
		transcriptId,
	].join("::");
}

export async function insertNormalizedEvents(
	sessionId: string,
	normalizedEvents: NormalizedEvent[],
) {
	if (normalizedEvents.length === 0) return [];
	const nowIso = new Date().toISOString();

	const recentEvents = await getDb()
		.select({
			id: events.id,
			eventType: events.eventType,
			category: events.category,
			source: events.source,
			content: events.content,
			providerEventType: events.providerEventType,
			createdAt: events.createdAt,
		})
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(sql`${events.id} DESC`)
		.limit(50);

	const seen = new Set(recentEvents.map((event) => buildDedupKey({ ...event })));
	const deleteIds = new Set<number>();
	const retained: Array<NormalizedEvent & { createdAt: string }> = [];
	const authorityPool: AuthorityComparableEvent[] = recentEvents.map((event) => ({
		...event,
		category: event.category as EventCategory | null,
		source: event.source as EventSource,
		createdAt: event.createdAt,
	}));

	for (const event of normalizedEvents) {
		const normalizedEvent = { ...event, createdAt: nowIso };
		const key = buildDedupKey(event);
		if (seen.has(key)) continue;

		const strongerExisting = authorityPool.find((existing) => {
			if (!isAssistantAuthorityDuplicate(existing, normalizedEvent)) return false;
			return chooseHigherAuthorityEvent(existing, normalizedEvent) === existing;
		});
		if (strongerExisting) continue;

		for (const existing of authorityPool) {
			if (!existing.id) continue;
			if (!isAssistantAuthorityDuplicate(existing, normalizedEvent)) continue;
			if (chooseHigherAuthorityEvent(existing, normalizedEvent) === normalizedEvent) {
				deleteIds.add(existing.id);
			}
		}

		seen.add(key);
		retained.push(normalizedEvent);
		authorityPool.push({
			id: 0,
			category: normalizedEvent.category,
			source: normalizedEvent.source,
			content: normalizedEvent.content,
			createdAt: normalizedEvent.createdAt,
		});
	}

	if (deleteIds.size > 0) {
		await getDb()
			.delete(events)
			.where(inArray(events.id, Array.from(deleteIds)));
	}

	if (retained.length === 0) return [];

	const inserted = await getDb()
		.insert(events)
		.values(
			retained.map((event) => ({
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
			})),
		)
		.returning({ id: events.id });

	return retained.map((event, i) => ({
		id: inserted[i]?.id ?? 0,
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
		createdAt: event.createdAt,
	}));
}

// Detect agent type from the X-Agent-Type header. The payload argument is
// kept for call-site stability; no field on it is currently consulted.
export function detectAgentType(
	headerAgentType: string | undefined,
	_payload: HookEventPayload,
): AgentType {
	if (headerAgentType === "claude_code") return "claude_code";
	if (headerAgentType === "codex_cli") return "codex_cli";

	// No recognized X-Agent-Type header: default to claude_code. Every
	// producer (Claude settings.json, Codex hooks.json, relay, observer)
	// sends the header, so this default is not reached in practice.
	return "claude_code";
}

// ── Permission-wait tracking (Decision 10) ──────────────────────────────
//
// A session blocked on a permission prompt must be visibly distinguishable
// as "waiting" on the dashboard. State lives in sessions.metadata.permissionWait
// as { ids, anon, prevStatus } tracking *outstanding* waits — tool_use_id-keyed
// where available, with an anonymous counter fallback for payloads that omit it.
// See the plan's Decision 10 for the full state model and rationale.

export interface PermissionWaitState {
	ids: string[];
	anon: number;
	prevStatus: SemanticStatus | null;
}

const PERMISSION_WAIT_EVENT_TYPES = new Set([
	"PermissionRequest",
	"PermissionDenied",
	"PostToolUse",
	// A failed permission-gated tool call still resolves the tool call — it
	// must clear its tool_use_id wait exactly like a successful PostToolUse.
	"PostToolUseFailure",
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
]);

const BOUNDARY_EVENT_TYPES = new Set(["UserPromptSubmit", "Stop", "SessionStart"]);

// Per-session FIFO queue, local to this helper. Production hook processing
// is already serialized per session by ingest.ts's enqueueSessionTask before
// processHookEvent is ever called, so this is a defensive second layer —
// but it is load-bearing for direct concurrent callers (e.g. tests proving
// the merge-preservation property via Promise.all): bun-sqlite's manual
// BEGIN/COMMIT in withTransaction() throws "cannot start a transaction
// within a transaction" if two calls overlap on the same connection. Queuing
// per sessionId here avoids that crash without weakening the late
// read-modify-write semantics — each queued call still re-reads fresh state.
//
// Known accepted limitation: this queue is per-process, in-memory only. It
// provides no cross-process protection — irrelevant today under the
// single-replica deployment constraint (CLAUDE.md), but relevant the moment
// that constraint is lifted (e.g. multi-replica Postgres). At that point,
// real transaction-level interleaving across processes becomes reachable
// and needs its own dedicated coverage; the Promise.all test in
// event-processor.test.ts only proves the merge logic under this in-process
// serialization, not true cross-connection concurrency.
const permissionWaitQueues = new Map<string, Promise<void>>();

function enqueuePermissionWaitTask(sessionId: string, task: () => Promise<void>): Promise<void> {
	const prior = permissionWaitQueues.get(sessionId) ?? Promise.resolve();
	const result = prior.then(task, task);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	permissionWaitQueues.set(sessionId, settled);
	settled.then(() => {
		if (permissionWaitQueues.get(sessionId) === settled) {
			permissionWaitQueues.delete(sessionId);
		}
	});
	return result;
}

/**
 * Apply the Decision 10 permission-wait state transition for one hook event.
 *
 * Invoked unconditionally for every permission-relevant event type
 * (PermissionRequest plus all clear-capable events). Does a late
 * read-modify-write inside withTransaction — re-reads the session row
 * immediately before writing so concurrent hooks can't resurrect stale
 * state or drop unrelated metadata keys. No-ops (reads, writes nothing)
 * when the event type isn't permission-relevant or no wait exists to touch.
 */
export async function applyPermissionWaitTransition(
	sessionId: string,
	event: HookEventPayload,
): Promise<void> {
	const eventType = event.hook_event_name;
	if (!PERMISSION_WAIT_EVENT_TYPES.has(eventType)) return;

	await enqueuePermissionWaitTask(sessionId, () =>
		withTransaction(async (tx) => {
			const [row] = await tx
				.select({ metadata: sessions.metadata, semanticStatus: sessions.semanticStatus })
				.from(sessions)
				.where(eq(sessions.sessionId, sessionId))
				.limit(1);
			if (!row) return;

			const metadata = { ...(row.metadata ?? {}) } as Record<string, unknown>;
			const currentWait = metadata.permissionWait as PermissionWaitState | undefined;
			const currentStatus = row.semanticStatus as SemanticStatus | null;

			if (eventType === "PermissionRequest") {
				const pendingBefore = currentWait ? currentWait.ids.length + currentWait.anon : 0;
				const next: PermissionWaitState = currentWait
					? {
							ids: [...currentWait.ids],
							anon: currentWait.anon,
							prevStatus: currentWait.prevStatus,
						}
					: { ids: [], anon: 0, prevStatus: null };

				// 0→1 transition is the only point prevStatus is captured — a
				// second nested PermissionRequest must never overwrite it with
				// "waiting" itself.
				if (pendingBefore === 0) next.prevStatus = currentStatus;

				if (event.tool_use_id) {
					if (!next.ids.includes(event.tool_use_id)) next.ids.push(event.tool_use_id);
				} else {
					next.anon += 1;
				}

				metadata.permissionWait = next;
				await tx
					.update(sessions)
					.set({ metadata, semanticStatus: "waiting" })
					.where(eq(sessions.sessionId, sessionId));
				return;
			}

			// Clear-capable events: no-op if there's nothing pending.
			if (!currentWait) return;

			const next: PermissionWaitState = {
				ids: [...currentWait.ids],
				anon: currentWait.anon,
				prevStatus: currentWait.prevStatus,
			};
			let changed = false;

			if (BOUNDARY_EVENT_TYPES.has(eventType)) {
				// Boundary events clear ALL outstanding waits in one shot — a new
				// prompt, a completed turn, or a process (re)start means nothing
				// can still be outstanding for this session.
				if (next.ids.length > 0 || next.anon > 0) {
					next.ids = [];
					next.anon = 0;
					changed = true;
				}
			} else {
				// PermissionDenied / PostToolUse / PostToolUseFailure: only a
				// matching entry clears.
				const toolUseId = event.tool_use_id;
				if (toolUseId && next.ids.includes(toolUseId)) {
					next.ids = next.ids.filter((id) => id !== toolUseId);
					changed = true;
				} else if (!toolUseId && next.anon > 0) {
					next.anon -= 1;
					changed = true;
				}
				// Otherwise: unrelated tool_use_id or nothing to decrement — no-op.
			}

			if (!changed) return;

			const pendingAfter = next.ids.length + next.anon;
			if (pendingAfter === 0) {
				const { permissionWait: _clearedWait, ...restMetadata } = metadata;
				// Owned-status guard: restore prevStatus only if this session is
				// still sitting on the permission-owned "waiting" value at mutation
				// time. A fresher agent-reported status (processStatusUpdate) wins.
				if (currentStatus === "waiting") {
					await tx
						.update(sessions)
						.set({ metadata: restMetadata, semanticStatus: next.prevStatus })
						.where(eq(sessions.sessionId, sessionId));
				} else {
					await tx
						.update(sessions)
						.set({ metadata: restMetadata })
						.where(eq(sessions.sessionId, sessionId));
				}
			} else {
				metadata.permissionWait = next;
				await tx.update(sessions).set({ metadata }).where(eq(sessions.sessionId, sessionId));
			}
		}),
	);
}

// The session row shape returned by processHookEvent.
// Using typeof-based inference keeps this in sync with the drizzle schema
// without duplicating field lists.
type SessionRow = typeof import("../db/schema/index.js").sessions.$inferSelect;

/**
 * Process an incoming hook event.
 *
 * Returns { sessionId, isNew, session } so callers (ingest route) can
 * broadcast the upserted row without a second DB round-trip.
 */
export async function processHookEvent(
	payload: HookEventPayload,
	agentType: AgentType,
): Promise<{ sessionId: string; isNew: boolean; session: SessionRow }> {
	const sessionId = payload.session_id;
	const eventType = payload.hook_event_name;
	const now = new Date().toISOString();

	// Check if session exists
	const existing = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);

	const isNew = existing.length === 0;

	if (isNew) {
		// Create new session with a friendly display name
		await getDb()
			.insert(sessions)
			.values({
				sessionId,
				displayName: generateSessionName(),
				agentType,
				status: "active",
				cwd: payload.cwd || null,
				transcriptPath: payload.transcript_path || null,
				model: payload.model || null,
				startedAt: now,
				lastActivityAt: now,
				metadata: {},
			});
	}

	// Update session based on event type. Any event other than SessionEnd
	// reanimates the session back to "active" — including events that
	// arrive after the lifecycle ticked it over to idle or completed.
	// We also clear endedAt so the reanimated session doesn't carry a
	// stale terminal timestamp forward.
	const updates: Record<string, unknown> = {
		lastActivityAt: now,
		status: "active",
		endedAt: null,
	};

	if (payload.cwd) updates.cwd = payload.cwd;
	if (payload.model) updates.model = payload.model;

	// Handle session end events
	if (eventType === "SessionEnd") {
		updates.status = "completed";
		updates.endedAt = now;
		updates.isWorking = false;
	}

	// Track working state: agent is working between prompt/tool start and Stop
	if (eventType === "UserPromptSubmit" || eventType === "PreToolUse") {
		updates.isWorking = true;
	}
	if (eventType === "Stop") {
		updates.isWorking = false;
	}

	// Increment tool use count for tool events
	if (eventType === "PostToolUse" || eventType === "PreToolUse") {
		if (eventType === "PostToolUse") {
			await getDb()
				.update(sessions)
				.set({ totalToolUses: sql`${sessions.totalToolUses} + 1` })
				.where(eq(sessions.sessionId, sessionId));
		}
	}

	// Extract current task from task events
	if (eventType === "TaskCreated" && payload.task_subject) {
		updates.currentTask = payload.task_subject;
	}

	// Try to extract git branch from tool responses
	if (eventType === "PostToolUse" && payload.tool_name === "Bash" && payload.tool_response) {
		const response =
			typeof payload.tool_response === "string"
				? payload.tool_response
				: JSON.stringify(payload.tool_response);
		const input = payload.tool_input as Record<string, unknown> | undefined;
		const command = typeof input?.command === "string" ? input.command : "";

		// Match "git branch", "git status", etc. responses that contain branch info
		if (
			command.includes("git") &&
			(command.includes("branch") || command.includes("status") || command.includes("rev-parse"))
		) {
			const branchMatch = response.match(/(?:On branch |^\* |HEAD -> )([^\s,)]+)/m);
			if (branchMatch) {
				updates.gitBranch = branchMatch[1];
			}
		}
	}

	await getDb().update(sessions).set(updates).where(eq(sessions.sessionId, sessionId));

	// Decision 10: permission-wait tracking. Runs after the main update (not
	// folded into the early-snapshot `updates` object above) via its own late
	// read-modify-write transaction — see applyPermissionWaitTransition.
	await applyPermissionWaitTransition(sessionId, payload);

	// Resolve project_id based on cwd. Compare against the persisted value
	// so we only write when it actually changed.
	const [upserted] = await getDb()
		.select({ id: sessions.id, cwd: sessions.cwd, projectId: sessions.projectId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (upserted) {
		const resolvedProjectId = resolveProjectIdForCwd(upserted.cwd, getCachedProjects());
		if (resolvedProjectId !== upserted.projectId) {
			await getDb()
				.update(sessions)
				.set({ projectId: resolvedProjectId })
				.where(eq(sessions.id, upserted.id));
		}
	}

	if (isNew || eventType === "SessionStart") {
		await associateObservedSession({ sessionId });
	}

	// Store normalized timeline events
	const normalizedEvents = normalizeHookEvent(payload, agentType);
	await insertNormalizedEvents(sessionId, normalizedEvents);

	// Evaluate project alert rules for status_completed on SessionEnd.
	// Best-effort: rule evaluation failure must not block event ingestion.
	if (eventType === "SessionEnd") {
		void evaluateAlertRules(sessionId, "completed").catch((err) => {
			console.error("[alert-rule] evaluateAlertRules(completed) threw:", err);
		});
	}

	// Fetch the fully updated session row so the broadcast path in the
	// ingest route does not need a second DB round-trip (eliminates N+1).
	const [finalSession] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);

	// finalSession is guaranteed to exist here — we just inserted or updated it.
	// The non-null assertion is safe; a missing row would indicate DB corruption.
	return { sessionId, isNew, session: finalSession! };
}

/**
 * P3 write path: mark a session as failed.
 *
 * Called from launch-dispatch when a launch_request transitions to "failed"
 * and the session has never produced a SessionEnd event (i.e. the agent never
 * started cleanly).
 */
export async function markSessionFailed(sessionId: string): Promise<void> {
	const now = new Date().toISOString();
	await getDb()
		.update(sessions)
		.set({ status: "failed", endedAt: now, isWorking: false })
		.where(eq(sessions.sessionId, sessionId));
	// Evaluate project alert rules for status_failed transition.
	// Best-effort: a rule evaluation failure must not block the caller.
	void evaluateAlertRules(sessionId, "failed").catch((err) => {
		console.error("[alert-rule] evaluateAlertRules(failed) threw:", err);
	});
}

// Process a semantic status update from CLAUDE.md snippet
export async function processStatusUpdate(update: SemanticStatusUpdate): Promise<boolean> {
	const existing = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, update.session_id))
		.limit(1);

	if (existing.length === 0) {
		return false; // Session not found
	}

	const updates: Record<string, unknown> = {
		lastActivityAt: new Date().toISOString(),
		status: "active",
	};

	if (update.status) updates.semanticStatus = update.status;
	if (update.task) updates.currentTask = update.task;
	if (update.plan) updates.planSummary = update.plan;

	await getDb().update(sessions).set(updates).where(eq(sessions.sessionId, update.session_id));

	const normalizedEvents = normalizeStatusEvents(update);
	await insertNormalizedEvents(update.session_id, normalizedEvents);

	return true;
}
