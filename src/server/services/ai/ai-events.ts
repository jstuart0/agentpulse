import type { EventCategory, EventSource, SessionEvent } from "../../../shared/types.js";
import type { NormalizedEvent } from "../event-normalizer.js";
import { insertNormalizedEvents } from "../event-processor.js";
import { notifySessionEvents } from "../notifier.js";

/**
 * Persist an AI-related event on the session timeline and broadcast it so
 * the UI updates instantly. Routes through `insertNormalizedEvents` to
 * inherit dedup, authority resolution, and FTS5 trigger plumbing — bypassing
 * those was the source of duplicate timeline rows and authority contamination
 * (Slice AI-EVT-1).
 *
 * `source` is required so the caller has to make an authority-correct choice;
 * watcher-runner emits use "managed_control", launch pipeline emits use
 * "launch_system", and observed-side HITL/proposal/report continuations stay
 * "observed_hook".
 */
export async function emitAiEvent(params: {
	sessionId: string;
	source: EventSource;
	category: EventCategory;
	eventType: string;
	content?: string | null;
	rawPayload?: Record<string, unknown>;
}): Promise<SessionEvent | null> {
	const normalized: NormalizedEvent = {
		eventType: params.eventType,
		category: params.category,
		source: params.source,
		content: params.content ?? null,
		isNoise: false,
		providerEventType: null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: params.rawPayload ?? {},
	};

	const inserted = await insertNormalizedEvents(params.sessionId, [normalized]);
	if (inserted.length === 0) {
		// Dedup or authority resolution rejected the event; nothing to broadcast.
		return null;
	}

	// insertNormalizedEvents already returns DTO rows through
	// toSessionEventDto (Phase 6, event-processor.ts's persistEvents) — no
	// second mapping needed here, and none that could reintroduce a leaked
	// column if the row shape ever widens.
	const sessionEvent = inserted[0];

	notifySessionEvents(params.sessionId, [sessionEvent]);
	return sessionEvent;
}
