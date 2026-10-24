import { desc, eq } from "drizzle-orm";
import type { EventCategory, SessionEvent } from "../../../shared/types.js";
import { getDb } from "../../db/client.js";
import { events } from "../../db/schema/index.js";

/**
 * Load the last N events for a session, newest-last. Used by the context
 * builder, classifier, and continuability predicate.
 *
 * Pure read helper — split out of `ai-events.ts` so that module exports only
 * the write path (Slice AI-EVT-1).
 */
export async function loadRecentEvents(sessionId: string, limit = 60): Promise<SessionEvent[]> {
	const rows = await getDb()
		.select()
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(desc(events.id))
		.limit(limit);
	// Drizzle returned newest-first; flip for chronological iteration.
	return rows.map(toSessionEvent).reverse();
}

/** One event by id, however old it is, or null. A run's trigger is looked up by id, never searched for in a window. */
export async function getEventById(id: number): Promise<SessionEvent | null> {
	const [row] = await getDb().select().from(events).where(eq(events.id, id)).limit(1);
	return row ? toSessionEvent(row) : null;
}

function toSessionEvent(row: typeof events.$inferSelect): SessionEvent {
	return {
		id: row.id,
		sessionId: row.sessionId,
		eventType: row.eventType,
		category: (row.category as EventCategory) ?? null,
		source: row.source as SessionEvent["source"],
		content: row.content,
		isNoise: row.isNoise,
		providerEventType: row.providerEventType,
		toolName: row.toolName,
		toolInput: row.toolInput as Record<string, unknown> | null,
		toolResponse: row.toolResponse,
		rawPayload: (row.rawPayload as Record<string, unknown>) ?? {},
		createdAt: row.createdAt,
	};
}
