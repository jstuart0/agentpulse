import {
	OWNER_ALL,
	type OwnedSession,
	type OwnerParam,
	hasOwnerInfo,
	matchesOwnerScope,
} from "../lib/owner-scope.js";

/**
 * What a live session message does to the dashboard: whether the row belongs
 * in the view, and, separately, whether it may raise a desktop notification.
 * Pure, so the socket hook only carries the answers out.
 */
export interface SocketContext {
	owner: OwnerParam;
	viewerUserId: string | null;
	/** Team mode: notifications are for the viewer's own sessions only. */
	teamMode: boolean;
	/** The session whose detail page is open, if any. */
	watchedSessionId?: string | null;
}

export interface SessionMessagePlan {
	store: "upsert" | "remove" | "ignore";
	notify: boolean;
}

/**
 * The view decides where a row goes; it doesn't decide who is told. In team
 * mode the viewer is told about their own sessions whatever view they are
 * looking at (their session finishing matters while they look at someone
 * else's) and never about other people's; solo tells about everything.
 */
export function planSessionMessage(
	session: OwnedSession,
	wasInStore: boolean,
	ctx: SocketContext,
): SessionMessagePlan {
	const own = ctx.viewerUserId !== null && session.ownerUserId === ctx.viewerUserId;
	const notify = ctx.teamMode ? own : true;
	if (ctx.owner !== OWNER_ALL && !hasOwnerInfo(session)) {
		return { store: wasInStore ? "upsert" : "ignore", notify };
	}
	if (!matchesOwnerScope(session, ctx.owner, ctx.viewerUserId)) {
		return { store: wasInStore ? "remove" : "ignore", notify };
	}
	return { store: "upsert", notify };
}

/**
 * A live event carries only a session id. In team mode keep it only for a
 * session the dashboard holds (and the view shows), or the one whose detail
 * page is open: events for everyone else's sessions would otherwise pile up
 * in memory with nothing on screen to read them. Solo keeps everything.
 */
export function shouldAcceptLiveEvent(
	sessionId: string,
	known: ReadonlyArray<OwnedSession & { sessionId: string }>,
	ctx: SocketContext,
): boolean {
	if (!ctx.teamMode) return true;
	if (ctx.watchedSessionId === sessionId) return true;
	const row = known.find((candidate) => candidate.sessionId === sessionId);
	if (row === undefined) return false;
	return !hasOwnerInfo(row) || matchesOwnerScope(row, ctx.owner, ctx.viewerUserId);
}
