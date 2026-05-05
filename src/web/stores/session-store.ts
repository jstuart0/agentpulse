import { create } from "zustand";
import type { DashboardStats, Session } from "../../shared/types.js";

interface SessionStore {
	sessions: Session[];
	stats: DashboardStats | null;
	isLoading: boolean;
	selectedSessionId: string | null;

	setSessions: (sessions: Session[]) => void;
	setStats: (stats: DashboardStats) => void;
	setLoading: (loading: boolean) => void;
	setSelectedSession: (id: string | null) => void;

	addSession: (session: Session) => void;
	updateSession: (session: Session) => void;
	// A-M6: shared reducer called by both WS handler and polling paths so
	// add-or-update semantics live in exactly one place.
	applySessionUpdate: (session: Session) => void;
	removeSession: (sessionId: string) => void;
}

/**
 * A-M6: pure reducer — add if new, replace if exists.
 * Extracted so WS and polling paths share identical upsert logic.
 */
export function applySessionUpdateToList(sessions: Session[], session: Session): Session[] {
	const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
	if (idx === -1) return [session, ...sessions];
	return sessions.map((s) => (s.sessionId === session.sessionId ? session : s));
}

export const useSessionStore = create<SessionStore>((set) => ({
	sessions: [],
	stats: null,
	isLoading: true,
	selectedSessionId: null,

	setSessions: (sessions) => set({ sessions }),
	setStats: (stats) => set({ stats }),
	setLoading: (isLoading) => set({ isLoading }),
	setSelectedSession: (selectedSessionId) => set({ selectedSessionId }),

	addSession: (session) =>
		set((state) => ({
			sessions: applySessionUpdateToList(state.sessions, session),
		})),

	updateSession: (session) =>
		set((state) => ({
			sessions: state.sessions.map((s) => (s.sessionId === session.sessionId ? session : s)),
		})),

	// A-M6: unified upsert used by WS handler (session_created / session_updated)
	// and by the polling path when it needs to merge a single updated session.
	applySessionUpdate: (session) =>
		set((state) => ({
			sessions: applySessionUpdateToList(state.sessions, session),
		})),

	removeSession: (sessionId) =>
		set((state) => ({
			sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
		})),
}));
