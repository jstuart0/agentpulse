import { desc, eq } from "drizzle-orm";
import type { EventCategory, SessionEvent } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { events, sessions } from "../../db/schema.js";
import { notifySessionEvents } from "../notifier.js";

/**
 * Persist an AI-related event on the session timeline and broadcast it so
 * the UI updates instantly. Thin wrapper around the events insert so the
 * runner doesn't have to know about table shape.
 */
export async function emitAiEvent(params: {
	sessionId: string;
	category: EventCategory;
	eventType: string;
	content?: string | null;
	rawPayload?: Record<string, unknown>;
}): Promise<SessionEvent | null> {
	const now = new Date().toISOString();
	const [inserted] = await db
		.insert(events)
		.values({
			sessionId: params.sessionId,
			eventType: params.eventType,
			category: params.category,
			source: "observed_hook",
			content: params.content ?? null,
			isNoise: false,
			providerEventType: null,
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload: params.rawPayload ?? {},
			createdAt: now,
		})
		.returning();

	const sessionEvent: SessionEvent = {
		id: inserted.id,
		sessionId: inserted.sessionId,
		eventType: inserted.eventType,
		category: (inserted.category as EventCategory) ?? null,
		source: inserted.source as SessionEvent["source"],
		content: inserted.content,
		isNoise: inserted.isNoise,
		providerEventType: inserted.providerEventType,
		toolName: inserted.toolName,
		toolInput: inserted.toolInput as Record<string, unknown> | null,
		toolResponse: inserted.toolResponse,
		rawPayload: (inserted.rawPayload as Record<string, unknown>) ?? {},
		createdAt: inserted.createdAt,
	};

	notifySessionEvents(params.sessionId, [sessionEvent]);
	return sessionEvent;
}

/**
 * Load the last N events for a session, newest-last. Used by the context
 * builder and continuability predicate.
 */
export async function loadRecentEvents(sessionId: string, limit = 60): Promise<SessionEvent[]> {
	const rows = await db
		.select()
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(desc(events.createdAt))
		.limit(limit);
	// Drizzle returned newest-first; flip for chronological iteration.
	return rows
		.map(
			(row): SessionEvent => ({
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
			}),
		)
		.reverse();
}

/**
 * Stamp the session row with watcher state + last-run timestamp for UI
 * badges. Broadcast happens via the caller (usually notifySessionUpdated
 * after it refreshes the session snapshot).
 */
export async function stampWatcherState(sessionId: string, state: string): Promise<void> {
	await db
		.update(sessions)
		.set({ watcherState: state, watcherLastRunAt: new Date().toISOString() })
		.where(eq(sessions.sessionId, sessionId));
}

/** Mark the last time a user prompt landed so race-control sees it. */
export async function stampUserPrompt(sessionId: string): Promise<void> {
	await db
		.update(sessions)
		.set({ watcherLastUserPromptAt: new Date().toISOString() })
		.where(eq(sessions.sessionId, sessionId));
}
