import { create } from "zustand";
import type { LiveSessionEvent } from "../../shared/types.js";

interface EventStore {
	// Live events pushed via WebSocket, keyed by sessionId
	liveEvents: Map<string, LiveSessionEvent[]>;
	addLiveEvent: (event: LiveSessionEvent) => void;
	clearSession: (sessionId: string) => void;
}

export const useEventStore = create<EventStore>((set) => ({
	liveEvents: new Map(),

	addLiveEvent: (event) =>
		set((state) => {
			const map = new Map(state.liveEvents);
			const existing = map.get(event.sessionId) || [];
			map.set(event.sessionId, [...existing, event]);
			return { liveEvents: map };
		}),

	clearSession: (sessionId) =>
		set((state) => {
			const map = new Map(state.liveEvents);
			map.delete(sessionId);
			return { liveEvents: map };
		}),
}));
