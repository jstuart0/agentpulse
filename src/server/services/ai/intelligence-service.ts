import { desc, eq, inArray, sql } from "drizzle-orm";
import type { EventCategory, Session, SessionEvent } from "../../../shared/types.js";
import { config } from "../../config.js";
import { getDb } from "../../db/client.js";
import { events, sessions } from "../../db/schema/index.js";
import { executeRows } from "../../db/sql-helpers.js";
import { getSessionOwnerConnections } from "../session-ownership.js";
import { type SessionIntelligence, classifySession } from "./classifier.js";
import { loadRecentEvents } from "./event-queries.js";
import {
	type HitlRequestRecord,
	getOpenHitlForSession,
	listOpenHitlForSessions,
} from "./hitl-service.js";

const CLASSIFIER_EVENT_LOOKBACK = 50;

/**
 * The classifier's per-session event projection (Decision 15 / F53 / F76).
 * Deliberately excludes `rawPayload` and `toolInput` — the classifier never
 * reads them, and on Postgres `raw_payload`/`tool_input` are JSON columns
 * that a naive `JSON.parse` on the driver's already-parsed value throws on
 * (F76). Callers that need the full row use `loadRecentEvents` instead.
 */
export interface ProjectedEventRow {
	id: number;
	sessionId: string;
	eventType: string;
	category: EventCategory | null;
	source: SessionEvent["source"];
	content: string | null;
	isNoise: boolean;
	providerEventType: string | null;
	toolName: string | null;
	toolResponse: string | null;
	createdAt: string;
}

function toClassifierSessionEvent(row: ProjectedEventRow): SessionEvent {
	return {
		id: row.id,
		sessionId: row.sessionId,
		eventType: row.eventType,
		category: row.category,
		source: row.source,
		content: row.content,
		isNoise: row.isNoise,
		providerEventType: row.providerEventType,
		toolName: row.toolName,
		toolInput: null,
		toolResponse: row.toolResponse,
		rawPayload: {},
		createdAt: row.createdAt,
	};
}

/**
 * Loads each session's last `limit` events, ascending by id, projected to
 * the columns the classifier reads. Postgres runs one `LATERAL` query
 * (avoids starving the connection pool on a large batch — F75); SQLite runs
 * a projected per-session loop (synchronous, no pool to starve).
 */
export async function loadRecentEventsBySession(
	sessionIds: string[],
	limit: number,
): Promise<Map<string, ProjectedEventRow[]>> {
	const out = new Map<string, ProjectedEventRow[]>();
	if (sessionIds.length === 0) return out;
	for (const id of sessionIds) out.set(id, []);

	if (config.dialect === "postgres") {
		const idList = sql.join(
			sessionIds.map((id) => sql`(${id})`),
			sql`, `,
		);
		const rows = await executeRows<{
			id: number;
			session_id: string;
			event_type: string;
			category: string | null;
			source: string;
			content: string | null;
			is_noise: boolean;
			provider_event_type: string | null;
			tool_name: string | null;
			tool_response: string | null;
			created_at: string;
		}>(
			getDb(),
			sql`SELECT e.id, e.session_id, e.event_type, e.category, e.source, e.content, e.is_noise,
			           e.provider_event_type, e.tool_name, e.tool_response, e.created_at
			      FROM (VALUES ${idList}) AS s(session_id)
			      CROSS JOIN LATERAL (
			        SELECT * FROM events ev WHERE ev.session_id = s.session_id ORDER BY ev.id DESC LIMIT ${limit}
			      ) e
			     ORDER BY s.session_id, e.id ASC`,
		);
		for (const r of rows) {
			const list = out.get(r.session_id);
			if (!list) continue;
			list.push({
				id: r.id,
				sessionId: r.session_id,
				eventType: r.event_type,
				category: (r.category as EventCategory) ?? null,
				source: r.source as SessionEvent["source"],
				content: r.content,
				isNoise: !!r.is_noise,
				providerEventType: r.provider_event_type,
				toolName: r.tool_name,
				toolResponse: r.tool_response,
				createdAt: r.created_at,
			});
		}
		return out;
	}

	// SQLite: synchronous, no connection pool to starve — a per-session
	// projected query is simpler than a window-function query and just as
	// fast at this scale (percy, mid-build).
	for (const id of sessionIds) {
		const rows = await getDb()
			.select({
				id: events.id,
				sessionId: events.sessionId,
				eventType: events.eventType,
				category: events.category,
				source: events.source,
				content: events.content,
				isNoise: events.isNoise,
				providerEventType: events.providerEventType,
				toolName: events.toolName,
				toolResponse: events.toolResponse,
				createdAt: events.createdAt,
			})
			.from(events)
			.where(eq(events.sessionId, id))
			.orderBy(desc(events.id))
			.limit(limit);
		out.set(
			id,
			rows.reverse().map((row) => ({
				...row,
				category: row.category as EventCategory | null,
				source: row.source as SessionEvent["source"],
			})),
		);
	}
	return out;
}

/**
 * Compute intelligence for a session by stitching together the pieces the
 * classifier needs. Read-only: no writes to session state.
 */
export async function intelligenceForSession(
	sessionId: string,
	now = new Date(),
): Promise<SessionIntelligence | null> {
	const [row] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return null;

	const recentEvents = await loadRecentEvents(sessionId, CLASSIFIER_EVENT_LOOKBACK);
	const openHitl = await getOpenHitlForSession(sessionId);

	const supervisorConnected: boolean | undefined = (
		await getSessionOwnerConnections([sessionId])
	).get(sessionId);

	return classifySession({
		session: row as unknown as Session,
		recentEvents,
		openHitl,
		supervisorConnected,
		now,
	});
}

/**
 * Bulk compute intelligence for many sessions. Issues 4 queries total
 * (sessions, projected events-per-session via loadRecentEventsBySession,
 * managed+supervisor left join, open HITL) regardless of input size, then
 * runs the classifier in-memory per session. The single-session path
 * remains for call sites that only need one record.
 */
export async function intelligenceForSessions(
	sessionIds: string[],
	now = new Date(),
): Promise<Map<string, SessionIntelligence>> {
	const out = new Map<string, SessionIntelligence>();
	if (sessionIds.length === 0) return out;

	// 1) Session rows
	const sessionRows = await getDb()
		.select()
		.from(sessions)
		.where(inArray(sessions.sessionId, sessionIds));
	if (sessionRows.length === 0) return out;

	// Restrict subsequent lookups to ids that actually exist, mirroring the
	// `if (!row) return null` early-out from intelligenceForSession.
	const presentIds = sessionRows.map((r) => r.sessionId);

	// 2) Recent events per session, projected (Decision 15). Postgres runs
	// one LATERAL query; SQLite runs a projected per-session loop. See
	// loadRecentEventsBySession above.
	const projectedBySession = await loadRecentEventsBySession(presentIds, CLASSIFIER_EVENT_LOOKBACK);
	const eventsBySession = new Map<string, SessionEvent[]>();
	for (const id of presentIds) {
		eventsBySession.set(id, (projectedBySession.get(id) ?? []).map(toClassifierSessionEvent));
	}

	// 3) Owner-of-record supervisor connected-state, batched.
	const ownerConnected = await getSessionOwnerConnections(presentIds);
	const managedBySession = new Map<string, { supervisorConnected: boolean }>();
	for (const [id, connected] of ownerConnected) {
		managedBySession.set(id, { supervisorConnected: connected });
	}

	// 4) Open HITL across all sessions in one query.
	const hitlRows = await listOpenHitlForSessions(presentIds);
	// listOpenHitlForSessions returns at most one open row per session (the
	// schema's unique partial index guarantees it), but we sort by createdAt
	// desc within each session anyway to mirror getOpenHitlForSession's
	// "most recent open" behavior.
	const hitlBySession = new Map<string, HitlRequestRecord>();
	for (const h of hitlRows) {
		const existing = hitlBySession.get(h.sessionId);
		if (!existing || h.createdAt > existing.createdAt) {
			hitlBySession.set(h.sessionId, h);
		}
	}

	for (const row of sessionRows) {
		const id = row.sessionId;
		const recentEvents = eventsBySession.get(id) ?? [];
		const managed = managedBySession.get(id);
		const intel = classifySession({
			session: row as unknown as Session,
			recentEvents,
			openHitl: hitlBySession.get(id) ?? null,
			supervisorConnected: managed?.supervisorConnected,
			now,
		});
		out.set(id, intel);
	}

	return out;
}
