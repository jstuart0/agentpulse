import { eq } from "drizzle-orm";
import type { Session } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { managedSessions, sessions, supervisors } from "../../db/schema.js";
import { type SessionIntelligence, classifySession } from "./classifier.js";
import { loadRecentEvents } from "./event-queries.js";
import { getOpenHitlForSession } from "./hitl-service.js";

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

export async function intelligenceForSessions(
	sessionIds: string[],
	now = new Date(),
): Promise<Map<string, SessionIntelligence>> {
	const out = new Map<string, SessionIntelligence>();
	// Keep it simple: a small inner loop. At list sizes the dashboard uses
	// (hundreds of sessions), this is still fast; we can parallelize if it
	// matters later.
	for (const id of sessionIds) {
		const intel = await intelligenceForSession(id, now);
		if (intel) out.set(id, intel);
	}
	return out;
}
