import { and, eq, inArray, sql } from "drizzle-orm";
import { AGENT_TYPES, SEMANTIC_STATUSES } from "../../shared/constants.js";
import type {
	AgentType,
	HookEventPayload,
	SemanticStatus,
	SemanticStatusUpdate,
	SessionEvent,
} from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { events, sessions } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import {
	incrementIngestForeignKeyDropped,
	incrementIngestOwnerMismatch,
	incrementIngestUnacknowledgeDropped,
	incrementSessionCreationLimited,
} from "../routes/ingest-counters.js";
import { evaluateAlertRules } from "./ai/alert-rule-evaluator.js";
import {
	type ForeignKeyVerdict,
	commitForeignKeyVerdict,
	judgeForeignKeyWrite,
	mayCreateSessionForPendingLaunch,
} from "./authorization.js";
import { resolveObservedSessionCorrelation } from "./correlation-resolver.js";
import {
	type DedupPolicy,
	type DropReason,
	type HookDeliveryContext,
	type InsertPlan,
	type PlannedRow,
	type RecentEventRow,
	contentWindowKey,
	planEventInsert,
	recordDrops,
	recordLegacyObserverDelivery,
} from "./event-dedup.js";
import { toSessionEventDtos } from "./event-dto.js";
import {
	type NormalizedEvent,
	normalizeHookEvent,
	normalizeStatusEvents,
} from "./event-normalizer.js";
import { getMode } from "./instance-mode.js";
import { associateObservedSession } from "./launch-dispatch.js";
import { generateSessionName } from "./name-generator.js";
import { getCachedProjects } from "./projects/cache.js";
import { resolveProjectIdForCwd } from "./projects/resolver.js";
import {
	type Attribution,
	canAcknowledgeOwnedSession,
	fillForUnownedRow,
	isOwnerMismatch,
	ownerForNewSession,
} from "./session-attribution.js";
import {
	noteOverLimitOnce,
	sessionCreationLimitSubject,
	tryConsumeSessionCreation,
} from "./session-creation-limit.js";

const RECENT_ROWS_FOR_DEDUP = 50;

async function loadRecentRows(sessionId: string): Promise<RecentEventRow[]> {
	return getDb()
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
		.limit(RECENT_ROWS_FOR_DEDUP);
}

// A row read back from `events` (all columns, including dedup_key) — the
// shape `.returning()` and a plain `.select()` both produce.
type StoredEventRow = typeof events.$inferSelect;

// Matches a RETURNING row back to the PlannedRow that produced it, without
// assuming RETURNING order matches insert order (F35 — Postgres doesn't
// guarantee it for multi-row inserts). A non-null dedupKey is unique by
// construction (Decision 2's UNIQUE(session_id, dedup_key)); a null
// dedupKey (content_window) falls back to contentWindowKey, which
// planContentWindow's own `seen` Set already guarantees is unique within
// one incoming batch.
function matchKey(row: {
	dedupKey: string | null;
	eventType: string;
	category: string | null;
	source: string;
	content: string | null;
	providerEventType: string | null;
	rawPayload?: Record<string, unknown>;
}): string {
	return row.dedupKey ? `k:${row.dedupKey}` : `c:${contentWindowKey(row)}`;
}

/**
 * The single write path for a planner InsertPlan (D9/D12): one explicit
 * insert (never a spread of caller/planner objects — F65), then
 * compensating deletes for rows that superseded an existing row, scoped to
 * this session (F82) and limited to rows this call actually stored (bob
 * L1/F47) — a row that lost an ON CONFLICT DO NOTHING race must never
 * trigger the delete it would have earned had it been stored. Returns DTO
 * rows (Decision 16; dedup_key never leaves this function) sorted by id.
 */
async function persistEvents(sessionId: string, plan: InsertPlan): Promise<SessionEvent[]> {
	if (plan.retained.length === 0) {
		recordDrops(plan.drops);
		return [];
	}

	const insertedRows: StoredEventRow[] = await getDb()
		.insert(events)
		.values(
			plan.retained.map((row) => ({
				sessionId,
				eventType: row.eventType,
				category: row.category,
				source: row.source,
				content: row.content,
				isNoise: row.isNoise,
				providerEventType: row.providerEventType,
				toolName: row.toolName,
				toolInput: row.toolInput,
				toolResponse: row.toolResponse,
				rawPayload: row.rawPayload,
				dedupKey: row.dedupKey,
			})),
		)
		.onConflictDoNothing()
		.returning();

	const byMatchKey = new Map<string, PlannedRow>(plan.retained.map((row) => [matchKey(row), row]));
	let stored = insertedRows
		.map((dbRow) => ({ dbRow, planned: byMatchKey.get(matchKey(dbRow)) }))
		.filter(
			(pair): pair is { dbRow: StoredEventRow; planned: PlannedRow } => pair.planned !== undefined,
		);

	// Phase 7 (D2/F48): classify the identity outcome for hook_delivery rows.
	// content_window rows never carry a dedupKey, so this never fires for them.
	const postInsertDrops: Partial<Record<DropReason, number>> = {};
	const bump = (reason: DropReason) => {
		postInsertDrops[reason] = (postInsertDrops[reason] ?? 0) + 1;
	};
	const storedKeys = new Set(
		stored.map(({ dbRow }) => dbRow.dedupKey).filter((key): key is string => key !== null),
	);

	// Whole-delivery drop: the delivery's primary row (rowIndex 0) is what
	// actually distinguishes "the same delivery arrived again" from
	// "genuinely new". If it lost the ON CONFLICT race, any sibling row this
	// call just stored — even one whose own key happened to be free, e.g. an
	// authority-superseded secondary that was since deleted — must not
	// survive: keeping it would resurrect exactly the row an earlier
	// authority delete removed. Compensate it away and count both the
	// primary and every compensated sibling as the same kind of retry.
	if (plan.primaryDedupKey != null && !storedKeys.has(plan.primaryDedupKey)) {
		const kind: DropReason = plan.primaryDedupKey.startsWith("t:")
			? "toolUseRetry"
			: "deliveryRetry";
		// Every planned row of this delivery counts as a retry: the primary's
		// own natural conflict, any sibling that independently conflicted too
		// (a genuine full re-delivery), and any sibling that must now be
		// compensated away (its own key happened to be free, e.g. an
		// authority-superseded row that was since deleted).
		for (let i = 0; i < plan.retained.length; i++) bump(kind);
		if (stored.length > 0) {
			await getDb()
				.delete(events)
				.where(
					and(
						eq(events.sessionId, sessionId),
						inArray(
							events.id,
							stored.map(({ dbRow }) => dbRow.id),
						),
					),
				);
		}
		stored = [];
	} else {
		for (const row of plan.retained) {
			if (!row.dedupKey || storedKeys.has(row.dedupKey)) continue;
			bump(row.dedupKey.startsWith("t:") ? "toolUseRetry" : "deliveryRetry");
		}
	}

	const deleteIds = new Set(stored.flatMap(({ planned }) => planned.deletesIfStored));
	if (deleteIds.size > 0) {
		await getDb()
			.delete(events)
			.where(and(eq(events.sessionId, sessionId), inArray(events.id, Array.from(deleteIds))));
	}

	recordDrops(plan.drops);
	recordDrops(postInsertDrops);

	return toSessionEventDtos(stored.map(({ dbRow }) => dbRow)).sort((a, b) => a.id - b.id);
}

/**
 * General-purpose entry point (transcript sync, managed-session events,
 * AI-emitted events, and anything else that isn't a raw hook delivery).
 * Always content-windowed — these sources have no delivery-id header to
 * key on.
 */
export async function insertNormalizedEvents(
	sessionId: string,
	normalizedEvents: NormalizedEvent[],
): Promise<SessionEvent[]> {
	if (normalizedEvents.length === 0) return [];

	const plan = planEventInsert({
		policy: { kind: "content_window" },
		recent: await loadRecentRows(sessionId),
		incoming: normalizedEvents,
		nowIso: new Date().toISOString(),
	});

	return persistEvents(sessionId, plan);
}

/**
 * Hook-ingestion entry point (D9's second entry point). Kept separate from
 * insertNormalizedEvents so its policy can differ: hook deliveries use exact
 * identity (`hook_delivery`), never the content window.
 */
export async function insertHookEvents(
	sessionId: string,
	normalizedEvents: NormalizedEvent[],
	policy: DedupPolicy,
): Promise<SessionEvent[]> {
	if (normalizedEvents.length === 0) return [];

	const plan = planEventInsert({
		policy,
		recent: await loadRecentRows(sessionId),
		incoming: normalizedEvents,
		nowIso: new Date().toISOString(),
	});

	return persistEvents(sessionId, plan);
}

// Detect agent type from the X-Agent-Type header. The payload argument is
// kept for call-site stability; no field on it is currently consulted.
export function detectAgentType(
	headerAgentType: string | undefined,
	_payload: HookEventPayload,
): AgentType {
	if (headerAgentType && (AGENT_TYPES as readonly string[]).includes(headerAgentType)) {
		return headerAgentType as AgentType;
	}

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
	// D21: terminal boundaries that must also clear an outstanding wait.
	"SessionEnd",
	"Interrupt",
]);

// D21: SessionEnd and Interrupt are terminal boundaries too — a session that
// ends or is interrupted while "waiting" must have its waits dropped and
// semanticStatus restored, the same as a fresh prompt or a completed turn.
const BOUNDARY_EVENT_TYPES = new Set([
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
	"SessionEnd",
	"Interrupt",
]);

// ── D21: delivery-order tolerance for async/detached Codex hooks ───────
//
// Codex's command hooks detach their POST (D13), so delivery order to the
// server can interleave with logical turn order. Two bounded rules cover
// this:
//
// 1. Terminal latch: once SessionEnd completes a session, a late event
//    (other than SessionStart/UserPromptSubmit, which are real resumes)
//    within TERMINAL_LATCH_WINDOW_MS is still stored and broadcast, but
//    doesn't reanimate status/endedAt/isWorking.
// 2. Closed turns: a Stop/Interrupt carrying turn_id marks that turn
//    closed; a later PreToolUse for the same turn_id doesn't reopen
//    isWorking.
//
// See the plan's Decision 21 for the full rationale and the exact
// boundary semantics (29.999s latched, 30.000s/30.001s not).
const TERMINAL_LATCH_WINDOW_MS = 30_000;
const CLOSED_TURN_ID_LIMIT = 20;

interface EndedByEventState {
	at: string;
}

export interface D21State {
	/** True iff this event arrived within the post-SessionEnd latch window. */
	latched: boolean;
	/** True iff this event's turn_id was already closed by a prior Stop/Interrupt. */
	closedTurn: boolean;
}

function isWithinLatchWindow(endedByEvent: unknown, nowMs: number): boolean {
	if (!endedByEvent || typeof endedByEvent !== "object") return false;
	const at = (endedByEvent as EndedByEventState).at;
	const atMs = typeof at === "string" ? Date.parse(at) : Number.NaN;
	if (!Number.isFinite(atMs)) return false;
	return nowMs - atMs < TERMINAL_LATCH_WINDOW_MS;
}

function computeD21State(
	priorMetadata: Record<string, unknown>,
	payload: HookEventPayload,
	nowMs: number,
): D21State {
	const eventType = payload.hook_event_name;
	// SessionStart/UserPromptSubmit are always real resumes — never latched.
	const latched =
		eventType !== "SessionStart" &&
		eventType !== "UserPromptSubmit" &&
		isWithinLatchWindow(priorMetadata.endedByEvent, nowMs);

	const closedTurnIds = Array.isArray(priorMetadata.closedTurnIds)
		? (priorMetadata.closedTurnIds as unknown[]).filter(
				(id): id is string => typeof id === "string",
			)
		: [];
	const closedTurn = Boolean(payload.turn_id) && closedTurnIds.includes(payload.turn_id as string);

	return { latched, closedTurn };
}

/**
 * Merge this event's D21 metadata effects (endedByEvent / closedTurnIds) into
 * `priorMetadata`. Returns null when nothing changed, so the caller can skip
 * writing the metadata column.
 */
function computeD21MetadataUpdate(
	priorMetadata: Record<string, unknown>,
	payload: HookEventPayload,
	now: string,
): Record<string, unknown> | null {
	const eventType = payload.hook_event_name;
	let changed = false;
	const next = { ...priorMetadata };

	if (eventType === "SessionEnd") {
		next.endedByEvent = { at: now } satisfies EndedByEventState;
		changed = true;
	}

	if ((eventType === "Stop" || eventType === "Interrupt") && payload.turn_id) {
		const priorIds = Array.isArray(priorMetadata.closedTurnIds)
			? (priorMetadata.closedTurnIds as unknown[]).filter(
					(id): id is string => typeof id === "string",
				)
			: [];
		const ids = priorIds.filter((id) => id !== payload.turn_id);
		ids.push(payload.turn_id);
		next.closedTurnIds = ids.slice(-CLOSED_TURN_ID_LIMIT);
		changed = true;
	}

	return changed ? next : null;
}

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
 * The most permission-wait ids kept per session. Every stats poll reads this
 * metadata, and a hook stream can open requests without ever closing them.
 */
const MAX_PERMISSION_WAIT_IDS = 256;

/**
 * Keeps the newest ids and counts the rest as anonymous, so the session still
 * reads as waiting for as many requests as were opened. (An id that was folded
 * can no longer be cleared by name: answering an id that isn't stored subtracts
 * from the anonymous count instead.)
 */
function foldOldestIdsIntoAnon(wait: PermissionWaitState): void {
	const overflow = wait.ids.length - MAX_PERMISSION_WAIT_IDS;
	if (overflow <= 0) return;
	wait.ids = wait.ids.slice(overflow);
	wait.anon += overflow;
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
 *
 * D21: `d21` is the same { latched, closedTurn } computed by the caller for
 * this event. A PermissionRequest inside the terminal latch or on an
 * already-closed turn opens no wait — the event is still stored/broadcast
 * by the caller, but metadata.permissionWait and semanticStatus are left
 * untouched. Clear-capable events (including the boundary events, now
 * SessionEnd/Interrupt too) always run their clear logic regardless of d21,
 * since clearing is idempotent and is exactly what restores state when a
 * terminal boundary lands while a wait is outstanding.
 *
 * `d21` defaults to the no-op state ({latched:false, closedTurn:false}) —
 * existing direct callers that predate D21 (tests exercising the base
 * permission-wait machinery in isolation) are unaffected.
 */
export async function applyPermissionWaitTransition(
	sessionId: string,
	event: HookEventPayload,
	d21: D21State = { latched: false, closedTurn: false },
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
				// D21: a request that arrives inside the terminal latch, or whose
				// turn was already closed by a prior Stop/Interrupt, opens no
				// wait — the event is still stored/broadcast by the caller.
				if (d21.latched || d21.closedTurn) return;

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
				foldOldestIdsIntoAnon(next);

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
				} else if (next.anon > 0) {
					// No id, or an id that isn't stored: it may be one folded into the
					// anonymous count past the id cap, which can only be answered by
					// subtracting from the count.
					next.anon -= 1;
					changed = true;
				}
				// Otherwise: nothing outstanding that this could answer — no-op.
			}

			if (!changed) return;

			const pendingAfter = next.ids.length + next.anon;
			if (pendingAfter === 0) {
				const { permissionWait: _clearedWait, ...restMetadata } = metadata;

				// Metadata clear is unconditional — the resolved wait is always
				// removed, regardless of whether the status restore below fires.
				await tx
					.update(sessions)
					.set({ metadata: restMetadata })
					.where(eq(sessions.sessionId, sessionId));

				// Owned-status guard, made atomic (codex r2 finding): gating on
				// `currentStatus` (read once, early in this transaction) is not
				// safe — processStatusUpdate writes semanticStatus in its own
				// background task, outside this helper's transaction/queue, and
				// can land between our read and this write. Predicating the WHERE
				// clause on semanticStatus itself re-checks the live value at the
				// moment this UPDATE actually executes (SQLite: fully serialized
				// by withTransaction anyway; Postgres: the row lock this UPDATE
				// takes forces it to see any write that already committed, and
				// blocks-then-re-evaluates against one that's mid-flight), so a
				// fresher agent-reported status can never be clobbered by the
				// stale prevStatus.
				await tx
					.update(sessions)
					.set({ semanticStatus: next.prevStatus })
					.where(and(eq(sessions.sessionId, sessionId), eq(sessions.semanticStatus, "waiting")));
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

// Test-only seam (see the call site in processHookEvent): a hook a test can
// set to deterministically land a competing session-row insert between the
// existence check and this call's own insert, reproducing the creation-race
// loser path on demand. Never consulted for correctness — unset (null) in
// production.
let _preInsertRaceHookForTest: ((sessionId: string) => Promise<void>) | null = null;
export function _setPreInsertRaceHookForTest(
	hook: ((sessionId: string) => Promise<void>) | null,
): void {
	_preInsertRaceHookForTest = hook;
}

// Default ctx when a caller omits it (existing tests, and any producer that
// predates Phase 7): anonymous key, no delivery id, native origin. Hook
// deliveries still use exact identity under this default — only rows that
// carry a tool_use_id or arrive with a real delivery id get a durable key;
// everything else is unkeyed and always stored (fail-open, D3).
const DEFAULT_HOOK_DELIVERY_CTX: HookDeliveryContext = {
	keyId: "anonymous",
	deliveryId: null,
	origin: "native",
};

/**
 * Team mode only: has this poster (its key's owner, else the key) used up its
 * session-creation allowance for the minute? Counts the drop on /health and
 * logs it once per window. Solo is never limited, and the mode is read only
 * once the allowance is spent.
 */
async function isOverCreationLimit(attribution: Attribution): Promise<boolean> {
	const subject = sessionCreationLimitSubject(attribution);
	if (subject === null || tryConsumeSessionCreation(subject)) return false;
	if ((await getMode()) !== "team") return false;
	incrementSessionCreationLimited();
	if (noteOverLimitOnce(subject)) {
		console.warn(
			JSON.stringify({
				kind: "session_creation_limited",
				level: "warn",
				keyId: attribution.ingestKeyId,
				ownerUserId: attribution.ownerUserId,
				message:
					"New sessions from this poster are being dropped: over the per-minute creation limit.",
			}),
		);
	}
	return true;
}

/** The hook rule's verdict, committed straight away: for a write that is applied as soon as it is admitted. */
async function admitForeignKeyWrite(
	session: Parameters<typeof judgeForeignKeyWrite>[0],
	attribution: Attribution,
): Promise<boolean> {
	return commitForeignKeyVerdict(
		session.sessionId,
		await judgeForeignKeyWrite(session, attribution),
	);
}

/**
 * Process an incoming hook event.
 *
 * Returns { sessionId, isNew, session, events } so callers (ingest route)
 * can broadcast the upserted session row and the actually-stored event
 * rows — with real ids, exactly the rows this call persisted — without a
 * second DB round-trip (Phase 6).
 *
 * `ctx` carries the Phase 7 identity inputs (keyId, delivery id, origin).
 * A legacy-observer-shaped delivery — codex_cli, origin "native" (no
 * X-AgentPulse-Origin header), no transcript_path — is the one hook shape
 * that still goes through the content window (mozart D14): it's the only
 * producer that predates the delivery-id/origin headers, so it has no
 * exact identity to key on, and it's counted via recordLegacyObserverDelivery
 * so operators can see hosts that need a supervisor upgrade.
 */
export async function processHookEvent(
	payload: HookEventPayload,
	agentType: AgentType,
	ctx: HookDeliveryContext = DEFAULT_HOOK_DELIVERY_CTX,
): Promise<{
	sessionId: string;
	isNew: boolean;
	/** Null only when the event was dropped (UserAcknowledge for an unknown session). */
	session: SessionRow | null;
	events: SessionEvent[];
}> {
	const sessionId = payload.session_id;
	const eventType = payload.hook_event_name;
	const now = new Date().toISOString();
	const attribution: Attribution = ctx.attribution ?? { ownerUserId: null, ingestKeyId: null };

	// AGEN (security): "mark as unseen" is never hook-reachable, unlike
	// UserAcknowledge. This is not an ownership question -- every
	// UserUnacknowledge hook delivery is dropped before it touches the
	// database, known session or not, owner match or not. Without this, the
	// event falls into the generic path below, which sets status:"active"
	// and clears endedAt -- any ingest key could reanimate a failed
	// session and hide its ERROR state. The dashboard's own DELETE
	// /sessions/:id/acknowledge route (unacknowledgeSession in
	// session-tracker.ts) is the only legitimate way to clear an
	// acknowledgement; it does not go through this hook path.
	if (eventType === "UserUnacknowledge") {
		incrementIngestUnacknowledgeDropped();
		return { sessionId, isNew: false, session: null, events: [] };
	}

	// Check if session exists
	const existing = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);

	// Whether this row existed before this call touched anything. Distinct
	// from `isNew` below, which also flips to false when this call's own
	// insert loses a creation race — the owner-fill exception applies to
	// that race-loser case specifically, never to a row that was already
	// here when this call started.
	const existedBeforeThisCall = existing.length > 0;
	let isNew = !existedBeforeThisCall;
	let priorRow: (typeof existing)[number] | undefined = existing[0];
	let isRaceLoser = false;

	// Team mode: an event for an owned session from a key that isn't the
	// owner's (nor the session's own recorded key) is dropped before anything
	// is stored — it could otherwise reanimate a failed session, clear the
	// owner's WAITING, or open or clear a permission wait. 200 all the same
	// (the hook route's contract), counted on /health. The check is free for
	// the owner's own keys; only a foreign-looking key costs the mode lookup.
	let keyVerdict: ForeignKeyVerdict | null = null;
	if (priorRow) {
		keyVerdict = await judgeForeignKeyWrite(priorRow, attribution);
		if (keyVerdict.drop) {
			incrementIngestForeignKeyDropped();
			return { sessionId, isNew: false, session: null, events: [] };
		}
	}

	// Synthetic acknowledgement (e.g. a relay-side transcript watcher saw a
	// successful /copy): it records that the user looked at the latest result
	// and nothing else. It never creates a session (an ack for an unknown or
	// deleted session is dropped — `session: null`, nothing stored), never
	// flips isWorking, never touches lifecycle status/endedAt (so it cannot
	// reanimate a completed session and is independent of the D21 latch),
	// never clears a permission wait (it is not in PERMISSION_WAIT_EVENT_TYPES)
	// and does not move lastAgentTurnCompletedAt or lastActivityAt — a
	// replaying sender must not be able to keep a dead session alive and
	// suppress the no-activity alert by repeatedly "acknowledging" it. The
	// stamp is server receive time so it compares with the Stop-side stamp
	// (hooks and acks travel the same per-session FIFO, so arrival order is
	// event order); the client-side `acknowledged_at` stays in the stored
	// event payload.
	if (eventType === "UserAcknowledge") {
		if (isNew) return { sessionId, isNew: false, session: null, events: [] };
		// Ownership guard (AGEN): a stranger's key (or a lagging relay) must
		// not clear another user's WAITING/ERROR state, and — unlike the
		// creation-race fill path's isOwnerMismatch check — an ownerless key
		// (no caller context, or a service key) is never let in just because
		// its own side is null: only a session with no owner accepts any
		// caller. A rejected ack is a silent no-op, same shape as the
		// unknown-session case — never an error, since the hook route is
		// always-200 — but it does bump the owner-mismatch counter so a
		// stranger repeatedly probing an owned session is observable.
		if (
			!canAcknowledgeOwnedSession({ ownerUserId: existing[0]?.ownerUserId ?? null }, attribution)
		) {
			incrementIngestOwnerMismatch();
			return { sessionId, isNew: false, session: null, events: [] };
		}
		const ackUpdates: Record<string, unknown> = { lastUserAcknowledgedAt: now };
		await getDb().update(sessions).set(ackUpdates).where(eq(sessions.sessionId, sessionId));
		const storedEvents = await insertHookEvents(sessionId, normalizeHookEvent(payload, agentType), {
			kind: "hook_delivery",
			ctx,
			rawPayload: payload,
		});
		const [ackSession] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		return { sessionId, isNew: false, session: ackSession ?? null, events: storedEvents };
	}

	// Past every refusal that leaves the row untouched (an acknowledgement is
	// refused above for any ownerless key): the event will be applied, so a
	// service key that was accepted only on condition of being recorded is
	// recorded now. Of two service keys racing for the same session, one wins
	// and the other is dropped here.
	if (priorRow && keyVerdict && !(await commitForeignKeyVerdict(sessionId, keyVerdict))) {
		incrementIngestForeignKeyDropped();
		return { sessionId, isNew: false, session: null, events: [] };
	}

	if (isNew) {
		// A real key may only create so many sessions a minute; over the limit
		// the creation is dropped (200, counted) before any statement is spent.
		if (await isOverCreationLimit(attribution)) {
			return { sessionId, isNew: false, session: null, events: [] };
		}

		// Extra read-only queries, only on a brand-new session — does a
		// pending launch correlate to this session id? If so its requester
		// wins the owner slot regardless of which path (hook or supervisor
		// report) creates the row first. Read-only: the actual launch
		// attach/running-transition still happens later via
		// associateObservedSession, unchanged. Not "one extra select": when
		// no pending launch matches, resolveObservedSessionCorrelation stops
		// after its own single lookup; when one does match, it goes on to
		// check for a conflicting managed row and a conflicting pre-existing
		// session (the squat guard, AGEN-65) — up to 3 selects total on this
		// path. See ingest-latency.test.ts's pinned statement counts for the
		// exact measured numbers on both dialects.
		const correlation = await resolveObservedSessionCorrelation(sessionId);
		// The new row will record the posting key as its ingest key (write access
		// for the session's life), so in team mode only the requester's keys, the
		// target host owner's keys and service keys may start it; any other key's
		// first event creates nothing.
		if (
			correlation &&
			!(await mayCreateSessionForPendingLaunch(correlation.launchRequest, attribution))
		) {
			incrementIngestForeignKeyDropped();
			return { sessionId, isNew: false, session: null, events: [] };
		}
		const owner = ownerForNewSession({
			launchRequesterUserId: correlation?.launchRequest.requestedByUserId ?? null,
			attribution,
		});

		// Test-only seam: lets a test deterministically land a competing
		// insert for this exact session id between our existence check above
		// and our insert below, reproducing the race-loser path on demand
		// instead of hoping real concurrency lands the same way. A no-op in
		// production (the hook is unset).
		if (_preInsertRaceHookForTest) {
			await _preInsertRaceHookForTest(sessionId);
		}

		// onConflictDoNothing + re-read (not a plain insert): two different
		// creation paths (this hook path and managed-session-state.ts's
		// supervisor path) can race to create the same session id. Without
		// this, the loser throws a unique-constraint error and the event is
		// lost; with it, the loser's insert is silently a no-op and it falls
		// through to the race-loser reconciliation below using the winner's
		// row. `session_id` remains the only session identity (cwd, project,
		// display name and agent type never participate).
		const inserted = await getDb()
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
				ownerUserId: owner.ownerUserId,
				ingestKeyId: owner.ingestKeyId,
			})
			.onConflictDoNothing({ target: sessions.sessionId })
			.returning();

		if (inserted.length === 0) {
			isNew = false;
			isRaceLoser = true;
			const [row] = await getDb()
				.select()
				.from(sessions)
				.where(eq(sessions.sessionId, sessionId))
				.limit(1);
			priorRow = row;
			if (priorRow && !(await admitForeignKeyWrite(priorRow, attribution))) {
				incrementIngestForeignKeyDropped();
				return { sessionId, isNew: false, session: null, events: [] };
			}
		} else {
			priorRow = undefined;
		}
	}

	if (priorRow && isRaceLoser) {
		// The one exception to "owner is decided only at creation": this
		// call's own insert lost the creation race in this same call, to
		// another request creating the same session id. It may fill the
		// winner's row, but only if both owner columns are still null —
		// guarded in SQL, not just in memory, so a second concurrent filler
		// (e.g. a third racer, or the supervisor path's own creation write)
		// can't double-apply.
		const fill = fillForUnownedRow(priorRow, attribution);
		if (fill) {
			await getDb()
				.update(sessions)
				.set(fill)
				.where(
					and(
						eq(sessions.sessionId, sessionId),
						sql`${sessions.ownerUserId} IS NULL AND ${sessions.ingestKeyId} IS NULL`,
					),
				);
		}
		if (isOwnerMismatch(priorRow, attribution)) {
			incrementIngestOwnerMismatch();
		}
	} else if (priorRow && existedBeforeThisCall) {
		// A genuinely pre-existing row — this call did not create it and did
		// not just lose a creation race for it. Ingest never fills an owner
		// here, even when both columns are still null: the owner is decided
		// only at creation, and an unassigned session (including one that
		// predates this feature) stays unassigned until an admin sets it
		// explicitly. The mismatch counter is independent of fill
		// eligibility and still applies to every existing-row event.
		if (isOwnerMismatch(priorRow, attribution)) {
			incrementIngestOwnerMismatch();
		}
	}

	// D21: compute the terminal-latch/closed-turn state from the metadata as
	// it stood *before* this event, then fold this event's own effects
	// (SessionEnd sets endedByEvent; a turn-scoped Stop/Interrupt records
	// closedTurnIds) into the metadata write below. A genuinely new row has
	// no prior metadata, so d21 is trivially {latched:false, closedTurn:false}.
	const priorMetadata = (priorRow?.metadata ?? {}) as Record<string, unknown>;
	const nowMs = Date.parse(now);
	const d21 = computeD21State(priorMetadata, payload, nowMs);
	const metadataUpdate = computeD21MetadataUpdate(priorMetadata, payload, now);

	// Update session based on event type. Any event other than SessionEnd
	// reanimates the session back to "active" — including events that
	// arrive after the lifecycle ticked it over to idle or completed. We
	// also clear endedAt so the reanimated session doesn't carry a stale
	// terminal timestamp forward. D21: inside the post-SessionEnd terminal
	// latch, status/endedAt/isWorking are held — the event is still stored
	// and broadcast (below), it just can't reanimate a completed session.
	const updates: Record<string, unknown> = { lastActivityAt: now };
	if (!d21.latched) {
		updates.status = "active";
		updates.endedAt = null;
	}
	if (metadataUpdate) updates.metadata = metadataUpdate;

	if (payload.cwd) updates.cwd = payload.cwd;
	if (payload.model) updates.model = payload.model;

	// Handle session end events
	if (eventType === "SessionEnd" && !d21.latched) {
		updates.status = "completed";
		updates.endedAt = now;
		updates.isWorking = false;
	}

	// Track working state: agent is working between prompt/tool start and
	// Stop/Interrupt. D21: a PreToolUse whose turn was already closed by a
	// prior Stop/Interrupt doesn't reopen isWorking (UserPromptSubmit always
	// starts a fresh turn, so closedTurn never suppresses it); latched
	// events don't touch isWorking at all.
	//
	// Acknowledgement model: a new prompt also acknowledges whatever the agent
	// produced before it (the user necessarily interacted with the previous
	// result), and Stop marks the agent turn as completed — the two
	// timestamps the WAITING/IDLE distinction is derived from (see
	// getOperationalStatus in src/shared/session-state.ts). lastActivityAt is
	// deliberately not used for this: Notification and other hooks bump it
	// too. Interrupt clears isWorking but stamps neither — the user cut the
	// turn short, so there is no finished result awaiting acknowledgement.
	if (eventType === "UserPromptSubmit" && !d21.latched) {
		updates.isWorking = true;
		updates.lastUserAcknowledgedAt = now;
	}
	if (eventType === "PreToolUse" && !d21.closedTurn && !d21.latched) {
		updates.isWorking = true;
	}
	if ((eventType === "Stop" || eventType === "Interrupt") && !d21.latched) {
		updates.isWorking = false;
		if (eventType === "Stop") updates.lastAgentTurnCompletedAt = now;
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
	// read-modify-write transaction — see applyPermissionWaitTransition. D21:
	// gated by the same { latched, closedTurn } computed above for this event.
	await applyPermissionWaitTransition(sessionId, payload, d21);

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

	// Store normalized timeline events. F140 (D21): oversize-stub semantics
	// come only from ctx.oversizeStub (server-set), never from the payload.
	const normalizedEvents = normalizeHookEvent(payload, agentType, ctx.oversizeStub === true);
	const isLegacyObserver =
		agentType === "codex_cli" && ctx.origin === "native" && !payload.transcript_path;
	let storedEvents: SessionEvent[];
	if (isLegacyObserver) {
		recordLegacyObserverDelivery();
		storedEvents = await insertNormalizedEvents(sessionId, normalizedEvents);
	} else {
		storedEvents = await insertHookEvents(sessionId, normalizedEvents, {
			kind: "hook_delivery",
			ctx,
			rawPayload: payload,
		});
	}

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
	return { sessionId, isNew, session: finalSession!, events: storedEvents };
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
/** True only for the declared SEMANTIC_STATUSES values. */
export function isSemanticStatus(value: unknown): value is SemanticStatus {
	return typeof value === "string" && (SEMANTIC_STATUSES as readonly string[]).includes(value);
}

/**
 * xander F90: `status` arrives from an ingest-keyed POST /hooks/status body
 * and is later rendered into LLM prompts, so anything outside the declared
 * set is dropped (the rest of the update still applies; ingest never errors).
 */
export async function processStatusUpdate(
	input: SemanticStatusUpdate,
	attribution: Attribution = { ownerUserId: null, ingestKeyId: null },
): Promise<boolean> {
	const { status, ...rest } = input;
	const update: SemanticStatusUpdate = isSemanticStatus(status) ? { ...rest, status } : rest;

	const existing = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, update.session_id))
		.limit(1);

	if (existing.length === 0) {
		return false; // Session not found
	}

	// Same rule and counter as a hook event: a key that is foreign to an owned
	// session can't reanimate it or rewrite its status, task or plan.
	if (!(await admitForeignKeyWrite(existing[0], attribution))) {
		incrementIngestForeignKeyDropped();
		return false;
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
