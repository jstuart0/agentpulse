import type { EventCategory, EventSource, SessionEvent } from "../../shared/types.js";

/**
 * One event DTO (Decision 16). Applied to the three REST event reads in
 * routes/sessions.ts (Phase 2); MCP reads REST over HTTP, so it inherits
 * the same shape. `persistEvents` (event-processor.ts, Phase 6) is now the
 * single write path and returns rows through this DTO, so every live
 * broadcast — the hook WS path (routes/ingest.ts), the supervisor managed-
 * session-events response, and AI-emitted events (ai-events.ts) — inherits
 * it too. In every case, `dedup_key` (server-derived durable identity,
 * Decision 2) never leaks past the persistence layer. An explicit
 * allowlist, not a spread-then-delete: a future column added to the
 * `events` table is dropped by default instead of leaking until someone
 * remembers to exclude it here.
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
