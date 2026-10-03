import { create } from "zustand";
import type { DashboardStats, Session } from "../../shared/types.js";
import { OWNER_ALL, type OwnerParam, hasOwnerInfo, matchesOwnerScope } from "../lib/owner-scope.js";
import { useDashboardScopeStore } from "./dashboard-scope-store.js";
import { useUserStore } from "./user-store.js";

/** What the list is showing, so a row that doesn't belong is neither added nor kept. */
export interface SessionListScope {
	owner: OwnerParam;
	viewerUserId: string | null;
}

interface SessionStore {
	sessions: Session[];
	stats: DashboardStats | null;
	isLoading: boolean;
	selectedSessionId: string | null;
	/**
	 * The server's unfiltered `GET /sessions` total (every session ever
	 * recorded) — distinct from `sessions.length`, which is capped at
	 * whatever page size useSessions() fetches. Powers the dashboard's
	 * "Total Sessions" KPI tile.
	 */
	totalSessions: number;
	/**
	 * Counts for everyone, kept only while the view is narrowed to Mine: the
	 * difference is the "N more active across the team" line.
	 */
	othersStats: DashboardStats | null;
	/** The key of the scope `sessions` currently holds (see requestKey); null before any. */
	listedKey: string | null;
	/**
	 * Counts live changes that altered the list (a socket message, an action on a
	 * card); the poll's own refresh doesn't count. The dashboard re-asks the
	 * counts after a quiet moment following a change.
	 */
	liveChanges: number;

	setSessions: (sessions: Session[]) => void;
	setStats: (stats: DashboardStats) => void;
	setLoading: (loading: boolean) => void;
	setSelectedSession: (id: string | null) => void;
	setTotalSessions: (total: number) => void;
	setOthersStats: (stats: DashboardStats | null) => void;
	/** The scope changed: nothing on screen describes the new set yet. */
	resetForScope: (key: string) => void;

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
export function applySessionUpdateToList(
	sessions: Session[],
	session: Session,
	scope?: SessionListScope,
): Session[] {
	const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
	if (scope && scope.owner !== OWNER_ALL && !hasOwnerInfo(session)) {
		// Fail open: a filter can't judge a row that says nothing about its owner.
		// One already shown is kept and refreshed; one that isn't waits for the poll.
		return idx === -1 ? sessions : sessions.map((s, i) => (i === idx ? session : s));
	}
	if (scope && !matchesOwnerScope(session, scope.owner, scope.viewerUserId)) {
		// Not this view's: never added, and dropped if its owner just changed away.
		return idx === -1 ? sessions : sessions.filter((s) => s.sessionId !== session.sessionId);
	}
	if (idx === -1) return [session, ...sessions];
	return sessions.map((s) => (s.sessionId === session.sessionId ? session : s));
}

/** Replace a row that is already listed; a row that isn't listed stays unlisted. A replacement that no longer belongs drops out. */
export function updateSessionInList(
	sessions: Session[],
	session: Session,
	scope?: SessionListScope,
): Session[] {
	if (!sessions.some((s) => s.sessionId === session.sessionId)) return sessions;
	return applySessionUpdateToList(sessions, session, scope);
}

/** The scope live updates are tested against: what the dashboard is showing, for the signed-in viewer. */
function currentListScope(): SessionListScope {
	return {
		owner: useDashboardScopeStore.getState().owner,
		viewerUserId: useUserStore.getState().userId,
	};
}

/**
 * F95: merge the store's copy of a session (kept live by the WebSocket
 * session_updated broadcast) into the detail page's own state, which also
 * holds detail-only fields. The store copy wins on the fields it carries.
 */
export function mergeSessionIntoDetail(
	current: Session | null,
	incoming: Session | undefined,
): Session | null {
	if (!incoming) return current;
	if (!current) return incoming;
	if (current.sessionId !== incoming.sessionId) return current;
	return { ...current, ...incoming };
}

/** A live change that left the list as it was (a row the view doesn't show) is no change. */
function listChange(
	state: { sessions: Session[]; liveChanges: number },
	sessions: Session[],
): { sessions: Session[]; liveChanges: number } | Record<string, never> {
	if (sessions === state.sessions) return {};
	return { sessions, liveChanges: state.liveChanges + 1 };
}

export const useSessionStore = create<SessionStore>((set) => ({
	sessions: [],
	stats: null,
	isLoading: true,
	selectedSessionId: null,
	totalSessions: 0,
	othersStats: null,
	listedKey: null,
	liveChanges: 0,

	setSessions: (sessions) => set({ sessions }),
	setStats: (stats) => set({ stats }),
	setLoading: (isLoading) => set({ isLoading }),
	setSelectedSession: (selectedSessionId) => set({ selectedSessionId }),
	setTotalSessions: (totalSessions) => set({ totalSessions }),
	setOthersStats: (othersStats) => set({ othersStats }),
	resetForScope: (key) =>
		set({
			sessions: [],
			stats: null,
			totalSessions: 0,
			othersStats: null,
			isLoading: true,
			listedKey: key,
		}),

	addSession: (session) =>
		set((state) =>
			listChange(state, applySessionUpdateToList(state.sessions, session, currentListScope())),
		),

	updateSession: (session) =>
		set((state) =>
			listChange(state, updateSessionInList(state.sessions, session, currentListScope())),
		),

	// A-M6: unified upsert used by WS handler (session_created / session_updated)
	// and by the polling path when it needs to merge a single updated session.
	applySessionUpdate: (session) =>
		set((state) =>
			listChange(state, applySessionUpdateToList(state.sessions, session, currentListScope())),
		),

	removeSession: (sessionId) =>
		set((state) => {
			const remaining = state.sessions.filter((s) => s.sessionId !== sessionId);
			return listChange(
				state,
				remaining.length === state.sessions.length ? state.sessions : remaining,
			);
		}),
}));
