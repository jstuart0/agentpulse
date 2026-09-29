import type { EventCategory, EventSource, SessionEvent } from "../../shared/types.js";

/**
 * One event DTO (Decision 16). Every full-row event read returned to a
 * client — REST, WS, supervisor, MCP (which reads REST over HTTP) — goes
 * through this, so `dedup_key` (server-derived durable identity, Decision 2)
 * never leaks past the persistence layer. An explicit allowlist, not a
 * spread-then-delete: a future column added to the `events` table is
 * dropped by default instead of leaking until someone remembers to
 * exclude it here.
 */
export interface EventDtoSourceRow {
	id: number;
	sessionId: string;
	eventType: string;
	category: string | null;
	source: string;
	content: string | null;
	isNoise: boolean;
	providerEventType: string | null;
	toolName: string | null;
	toolInput: unknown;
	toolResponse: string | null;
	rawPayload: unknown;
	createdAt: string;
	// Extra/unknown columns (dedupKey, or anything added later) are ignored.
	[key: string]: unknown;
}

export function toSessionEventDto(row: EventDtoSourceRow): SessionEvent {
	return {
		id: row.id,
		sessionId: row.sessionId,
		eventType: row.eventType,
		category: row.category as EventCategory | null,
		source: row.source as EventSource,
		content: row.content,
		isNoise: row.isNoise,
		providerEventType: row.providerEventType,
		toolName: row.toolName,
		toolInput: (row.toolInput as Record<string, unknown> | null) ?? null,
		toolResponse: row.toolResponse,
		rawPayload: (row.rawPayload as Record<string, unknown>) ?? {},
		createdAt: row.createdAt,
	};
}

export function toSessionEventDtos(rows: EventDtoSourceRow[]): SessionEvent[] {
	return rows.map(toSessionEventDto);
}
