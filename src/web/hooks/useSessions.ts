import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "../../shared/types.js";
import { plainErrorMessage } from "../lib/api-errors.js";
import { api } from "../lib/api.js";
import { BUSY_BANNER_AFTER, busyWaitMs } from "../lib/busy.js";
import { echoMatchesHost } from "../lib/host-scope.js";
import { requestKey, useRequestGuard } from "../lib/live-request.js";
import {
	type DashboardScope,
	OWNER_ALL,
	OWNER_ME,
	echoMatchesRequest,
} from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useReachabilityStore } from "../stores/reachability-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUserStore } from "../stores/user-store.js";

/** What made the caller's onPolled run: the timer, the socket coming back, or the viewer pressing Retry. */
export type PollReason = "poll" | "reconnect" | "retry";

const POLL_INTERVAL_MS = 30_000;
const NO_SESSIONS: Session[] = [];
const PAGE_LIMIT = 100;

/** The team line's other half counts everyone, on the same machines as the view it is subtracted from. */
function everyoneIsThisView(
	res: { ownerScope?: unknown; hostFilter?: unknown },
	viewer: string | null,
	host: string | undefined,
): boolean {
	return (
		echoMatchesRequest(OWNER_ALL, viewer, res.ownerScope) && echoMatchesHost(host, res.hostFilter)
	);
}

/**
 * The dashboard's session list and counts for one scope. The list, the stats
 * and the "everyone" stats are asked for together, in one poll, from the same
 * scope; each answer lands only while that scope is still the live one, so a
 * request that was in flight when the view changed can never write under the
 * new label. `scope` is null until the default scope is known: nothing is
 * requested.
 *
 * Requests per poll (every 30 s): the list and the stats; under Mine one more,
 * the everyone stats behind "N more active across the team". `onPolled` runs
 * after each poll so whatever else depends on the same moment (the per-owner
 * headers, a selected status list) refreshes with it and not on a timer of its own.
 * `refreshCounts` re-asks only the counts, for live updates between polls.
 */
export function useSessions(scope: DashboardScope | null, onPolled?: (reason: PollReason) => void) {
	const storedSessions = useSessionStore((s) => s.sessions);
	const storedStats = useSessionStore((s) => s.stats);
	const storedLoading = useSessionStore((s) => s.isLoading);
	const storedTotal = useSessionStore((s) => s.totalSessions);
	const storedOthers = useSessionStore((s) => s.othersStats);
	const listedKey = useSessionStore((s) => s.listedKey);
	const wsState = useConnectionStore((s) => s.wsState);
	const viewerUserId = useUserStore((s) => s.userId);
	const unconfirmed = useUserStore((s) => s.sessionUnconfirmed);
	const recoveries = useReachabilityStore((s) => s.recoveries);
	const [scopeMismatch, setScopeMismatch] = useState(false);
	/** The first answer for this view failed (not busy-and-recovering): say so, with Retry, rather than show an empty list. */
	const [loadError, setLoadError] = useState<string | null>(null);
	/** Polls have failed three times running while the last good answer is still on screen. */
	const [refreshDelayed, setRefreshDelayed] = useState(false);
	const [retryNonce, setRetryNonce] = useState(0);

	const owner = scope?.owner ?? null;
	const excludeScratch = scope?.excludeScratch ?? false;
	const host = scope?.host;
	const key = requestKey(scope);
	const isCurrent = useRequestGuard(key);
	const viewerRef = useRef(viewerUserId);
	viewerRef.current = viewerUserId;
	const onPolledRef = useRef(onPolled);
	onPolledRef.current = onPolled;
	/** Asks everything again now; set while a scope is live. */
	const pollNowRef = useRef<(() => Promise<boolean>) | null>(null);
	const retryPendingRef = useRef(false);

	/** The server answered for a different set than was asked: show nothing from it. */
	const refuse = useCallback(() => {
		const store = useSessionStore.getState();
		store.resetForScope(key);
		store.setLoading(false);
		setScopeMismatch(true);
	}, [key]);

	useEffect(() => {
		if (owner === null) return;
		const active: DashboardScope = { owner, excludeScratch, host };
		const askedKey = requestKey(active);
		const store = useSessionStore.getState();
		// Whatever is on screen describes another view: clear it, and stay loading
		// until this view's own first answer settles.
		if (store.listedKey !== askedKey) {
			store.resetForScope(askedKey);
			setLoadError(null);
			setRefreshDelayed(false);
		}

		let superseded = false;
		const wanted = () => !superseded && isCurrent(askedKey);
		let failures = 0;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;

		/** Resolves true when the answer landed. A busy server is asked again after the time it stated. */
		async function fetchSessions(): Promise<boolean> {
			let settled = true;
			try {
				const [sessionsRes, statsRes, everyoneRes] = await Promise.all([
					api.getSessions(scopedQuery(active, { limit: PAGE_LIMIT })),
					api.getStats(scopedQuery(active)),
					owner === OWNER_ME ? api.getEveryoneStats(excludeScratch, host) : Promise.resolve(null),
				]);
				if (!wanted()) return false;
				const viewer = viewerRef.current;
				if (
					!echoMatchesRequest(owner as string, viewer, sessionsRes.ownerScope) ||
					!echoMatchesRequest(owner as string, viewer, statsRes.ownerScope) ||
					!echoMatchesHost(host, sessionsRes.hostFilter) ||
					!echoMatchesHost(host, statsRes.hostFilter)
				) {
					refuse();
					return false;
				}
				failures = 0;
				setScopeMismatch(false);
				setLoadError(null);
				setRefreshDelayed(false);
				const next = useSessionStore.getState();
				next.setSessions(sessionsRes.sessions as Session[]);
				next.setStats(statsRes);
				next.setTotalSessions(sessionsRes.total);
				next.setOthersStats(
					everyoneRes && everyoneIsThisView(everyoneRes, viewer, host) ? everyoneRes : null,
				);
				return true;
			} catch (err) {
				if (!wanted()) return false;
				failures += 1;
				const wait = busyWaitMs(err);
				if (wait !== null && failures < BUSY_BANNER_AFTER) {
					// Keep what is on screen (or the skeleton) and ask again after the stated time.
					settled = false;
					retryTimer = setTimeout(() => {
						if (wanted())
							void fetchSessions().then((landed) => landed && onPolledRef.current?.("poll"));
					}, wait);
					return false;
				}
				console.error("[sessions] Failed to fetch:", err);
				if (useSessionStore.getState().isLoading) setLoadError(plainErrorMessage(err));
				else if (failures >= BUSY_BANNER_AFTER) setRefreshDelayed(true);
				return false;
			} finally {
				if (settled && wanted()) useSessionStore.getState().setLoading(false);
			}
		}

		pollNowRef.current = fetchSessions;
		// Refused as signed out with no way to confirm it: the identity check decides, not another round of requests.
		if (unconfirmed) {
			return () => {
				superseded = true;
				pollNowRef.current = null;
			};
		}
		const askedByRetry = retryPendingRef.current;
		retryPendingRef.current = false;
		void fetchSessions().then((landed) => {
			if (landed && wanted() && askedByRetry) onPolledRef.current?.("retry");
		});
		const interval = setInterval(() => {
			// Refused as signed out with no way to confirm it: wait for the identity check.
			if (useUserStore.getState().sessionUnconfirmed) return;
			void fetchSessions().then((landed) => {
				if (landed && wanted()) onPolledRef.current?.("poll");
			});
		}, POLL_INTERVAL_MS);
		return () => {
			superseded = true;
			pollNowRef.current = null;
			clearInterval(interval);
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [
		owner,
		excludeScratch,
		host,
		viewerUserId,
		unconfirmed,
		recoveries,
		retryNonce,
		isCurrent,
		refuse,
	]);

	// The socket coming back after a drop: whatever changed while it was down
	// was never pushed, so ask for everything again, lists included.
	const wasConnectedRef = useRef(false);
	useEffect(() => {
		if (wsState !== "connected") return;
		const reconnected = wasConnectedRef.current;
		wasConnectedRef.current = true;
		if (!reconnected) return;
		void pollNowRef.current?.().then((landed) => {
			if (landed) onPolledRef.current?.("reconnect");
		});
	}, [wsState]);

	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	/** Re-asks only the counts (the scoped stats and, under Mine, the everyone stats) in one go. */
	const refreshCounts = useCallback(async () => {
		const asked = scopeRef.current;
		if (!asked) return;
		const askedKey = requestKey(asked);
		try {
			const [statsRes, everyoneRes] = await Promise.all([
				api.getStats(scopedQuery(asked)),
				asked.owner === OWNER_ME
					? api.getEveryoneStats(asked.excludeScratch, asked.host)
					: Promise.resolve(null),
			]);
			if (!isCurrent(askedKey)) return;
			const viewer = viewerRef.current;
			if (
				!echoMatchesRequest(asked.owner, viewer, statsRes.ownerScope) ||
				!echoMatchesHost(asked.host, statsRes.hostFilter)
			) {
				refuse();
				return;
			}
			const store = useSessionStore.getState();
			store.setStats(statsRes);
			store.setOthersStats(
				everyoneRes && everyoneIsThisView(everyoneRes, viewer, asked.host) ? everyoneRes : null,
			);
		} catch {
			// Best-effort: the next poll asks again.
		}
	}, [isCurrent, refuse]);

	const retry = useCallback(() => {
		retryPendingRef.current = true;
		setLoadError(null);
		useSessionStore.getState().setLoading(true);
		setRetryNonce((n) => n + 1);
	}, []);

	// What the store holds describes the view it was loaded for. On the render
	// that changes the view, before the effect clears it, it must not be shown.
	const live = scope !== null && listedKey === key;
	return {
		sessions: live ? storedSessions : NO_SESSIONS,
		stats: live ? storedStats : null,
		isLoading: live ? storedLoading : true,
		totalSessions: live ? storedTotal : 0,
		othersStats: live ? storedOthers : null,
		scopeMismatch,
		loadError,
		refreshDelayed,
		retry,
		refreshCounts,
	};
}
