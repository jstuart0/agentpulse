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
	removeSession: (sessionId: string) => void;
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
		set((state) => {
			// Don't add duplicates
			if (state.sessions.some((s) => s.sessionId === session.sessionId)) {
				return {
					sessions: state.sessions.map((s) => (s.sessionId === session.sessionId ? session : s)),
				};
			}
			return { sessions: [session, ...state.sessions] };
		}),

	updateSession: (session) =>
		set((state) => ({
			sessions: state.sessions.map((s) => (s.sessionId === session.sessionId ? session : s)),
		})),

	removeSession: (sessionId) =>
		set((state) => ({
			sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
		})),
}));
