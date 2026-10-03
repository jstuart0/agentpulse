import { create } from "zustand";
import type { LiveSessionEvent } from "../../shared/types.js";

interface EventStore {
	// Live events pushed via WebSocket, keyed by sessionId
	liveEvents: Map<string, LiveSessionEvent[]>;
	/** The session whose detail page is open: its live events are kept even when the dashboard doesn't hold the session. */
	watchedSessionId: string | null;
	watch: (sessionId: string | null) => void;
	addLiveEvent: (event: LiveSessionEvent) => void;
	clearSession: (sessionId: string) => void;
}

/** A session that stays open for days would otherwise grow without bound: the newest events are kept. */
export const MAX_LIVE_EVENTS_PER_SESSION = 500;

export const useEventStore = create<EventStore>((set) => ({
	liveEvents: new Map(),
	watchedSessionId: null,
	watch: (watchedSessionId) => set({ watchedSessionId }),

	addLiveEvent: (event) =>
		set((state) => {
			const map = new Map(state.liveEvents);
			const existing = map.get(event.sessionId) || [];
			map.set(event.sessionId, [...existing, event].slice(-MAX_LIVE_EVENTS_PER_SESSION));
			return { liveEvents: map };
		}),

	clearSession: (sessionId) =>
		set((state) => {
			const map = new Map(state.liveEvents);
			map.delete(sessionId);
			return { liveEvents: map };
		}),
}));
