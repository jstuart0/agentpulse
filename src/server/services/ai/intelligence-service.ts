import { eq, inArray } from "drizzle-orm";
import type { EventCategory, Session, SessionEvent } from "../../../shared/types.js";
import { db, sqlite } from "../../db/client.js";
import { managedSessions, sessions, supervisors } from "../../db/schema.js";
import { type SessionIntelligence, classifySession } from "./classifier.js";
import { loadRecentEvents } from "./event-queries.js";
import {
	type HitlRequestRecord,
	getOpenHitlForSession,
	listOpenHitlForSessions,
} from "./hitl-service.js";

const CLASSIFIER_EVENT_LOOKBACK = 50;

/**
 * Compute intelligence for a session by stitching together the pieces the
 * classifier needs. Read-only: no writes to session state.
 */
export async function intelligenceForSession(
	sessionId: string,
	now = new Date(),
): Promise<SessionIntelligence | null> {
	const [row] = await db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
	if (!row) return null;

	const events = await loadRecentEvents(sessionId, CLASSIFIER_EVENT_LOOKBACK);
	const openHitl = await getOpenHitlForSession(sessionId);

	let supervisorConnected: boolean | undefined;
	const [managed] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (managed) {
		const [sup] = await db
			.select({ status: supervisors.status })
			.from(supervisors)
			.where(eq(supervisors.id, managed.supervisorId))
			.limit(1);
		supervisorConnected = sup?.status === "connected";
	}

	return classifySession({
		session: row as unknown as Session,
		recentEvents: events,
		openHitl,
		supervisorConnected,
		now,
	});
}

/**
 * Bulk compute intelligence for many sessions. Issues 4 queries total
 * (sessions, events-per-session via window function, managed+supervisor
 * left join, open HITL) regardless of input size, then runs the
 * classifier in-memory per session. The single-session path remains for
 * call sites that only need one record.
 */
export async function intelligenceForSessions(
	sessionIds: string[],
	now = new Date(),
): Promise<Map<string, SessionIntelligence>> {
	const out = new Map<string, SessionIntelligence>();
	if (sessionIds.length === 0) return out;

	// 1) Session rows
	const sessionRows = await db
		.select()
		.from(sessions)
		.where(inArray(sessions.sessionId, sessionIds));
	if (sessionRows.length === 0) return out;

	// Restrict subsequent lookups to ids that actually exist, mirroring the
	// `if (!row) return null` early-out from intelligenceForSession.
	const presentIds = sessionRows.map((r) => r.sessionId);

	// 2) Recent events per session via window function. Drizzle's query
	// builder doesn't model window fns cleanly, so drop to raw SQL on the
	// shared bun:sqlite handle. SQLite >= 3.25 supports ROW_NUMBER().
	const placeholders = presentIds.map(() => "?").join(",");
	const eventStmt = sqlite.prepare(
		`SELECT id, session_id, event_type, category, source, content,
		        is_noise, provider_event_type, tool_name, tool_input,
		        tool_response, raw_payload, created_at
		   FROM (
		     SELECT *,
		            ROW_NUMBER() OVER (
		              PARTITION BY session_id
		              ORDER BY created_at DESC, id DESC
		            ) AS rn
		       FROM events
		      WHERE session_id IN (${placeholders})
		   )
		  WHERE rn <= ${CLASSIFIER_EVENT_LOOKBACK}
		  ORDER BY session_id, created_at ASC, id ASC`,
	);
	const eventRows = eventStmt.all(...presentIds) as Array<{
		id: number;
		session_id: string;
		event_type: string;
		category: string | null;
		source: string;
		content: string | null;
		is_noise: number;
		provider_event_type: string | null;
		tool_name: string | null;
		tool_input: string | null;
		tool_response: string | null;
		raw_payload: string | null;
		created_at: string;
	}>;
	const eventsBySession = new Map<string, SessionEvent[]>();
	for (const id of presentIds) eventsBySession.set(id, []);
	for (const r of eventRows) {
		const list = eventsBySession.get(r.session_id);
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
			toolInput: r.tool_input ? (JSON.parse(r.tool_input) as Record<string, unknown>) : null,
			toolResponse: r.tool_response,
			rawPayload: r.raw_payload
				? (JSON.parse(r.raw_payload) as Record<string, unknown>)
				: ({} as Record<string, unknown>),
			createdAt: r.created_at,
		});
	}

	// 3) Managed-session + supervisor connected-state in a single left join.
	const managedRows = await db
		.select({
			sessionId: managedSessions.sessionId,
			supervisorStatus: supervisors.status,
		})
		.from(managedSessions)
		.leftJoin(supervisors, eq(supervisors.id, managedSessions.supervisorId))
		.where(inArray(managedSessions.sessionId, presentIds));
	const managedBySession = new Map<string, { supervisorConnected: boolean }>();
	for (const r of managedRows) {
		managedBySession.set(r.sessionId, {
			supervisorConnected: r.supervisorStatus === "connected",
		});
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
