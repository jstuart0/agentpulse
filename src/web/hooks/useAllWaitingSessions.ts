import { useEffect, useState } from "react";
import type { Session } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { requestKey, useRequestGuard } from "../lib/live-request.js";
import { type DashboardScope, ScopeMismatchError, assertEchoMatches } from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { collectMarkAllPages } from "../pages/dashboard-view-state.js";
import { useUserStore } from "../stores/user-store.js";

/** How long the waiting count must hold still before the whole waiting set is re-collected. */
export const MARK_ALL_SETTLE_MS = 500;

/**
 * The whole waiting set of the scope on screen, paged through the server's
 * operational filter (the same one the Waiting card's list uses), for "Mark all
 * as seen": not only the newest page the dashboard holds. Re-collected when the
 * waiting count or the scope changes, after a short settle so a burst of live
 * updates doesn't re-run the scan per event. Rows from another scope are never
 * kept: a scope change empties the set until the new scope's pages arrive.
 */
export function useAllWaitingSessions(
	scope: DashboardScope | null,
	waitingCount: number,
): Session[] {
	const [held, setHeld] = useState<{ key: string; sessions: Session[] }>({ key: "", sessions: [] });
	const viewerUserId = useUserStore((s) => s.userId);
	const owner = scope?.owner ?? null;
	const excludeScratch = scope?.excludeScratch ?? false;
	const liveKey = owner === null ? "" : requestKey({ owner, excludeScratch }, "waiting");
	const isCurrent = useRequestGuard(liveKey);

	useEffect(() => {
		if (owner === null || waitingCount === 0) {
			setHeld({ key: "", sessions: [] });
			return;
		}
		const asked = { owner, excludeScratch };
		const askedKey = requestKey(asked, "waiting");
		const timer = setTimeout(async () => {
			try {
				const collected = await collectMarkAllPages<Session>(async (offset, limit) => {
					const res = await api.getSessions(
						scopedQuery(asked, { operational: "waiting", limit, offset }),
					);
					assertEchoMatches(owner, viewerUserId, res.ownerScope);
					return { sessions: res.sessions as Session[], total: res.total };
				});
				if (isCurrent(askedKey)) setHeld({ key: askedKey, sessions: collected });
			} catch (err) {
				// A refused echo means these rows are not this view's: nothing to mark.
				// Any other failure is best-effort: the button keeps the previous set.
				if (err instanceof ScopeMismatchError && isCurrent(askedKey)) {
					setHeld({ key: askedKey, sessions: [] });
				}
			}
		}, MARK_ALL_SETTLE_MS);
		return () => clearTimeout(timer);
	}, [owner, excludeScratch, waitingCount, viewerUserId, isCurrent]);

	return held.key === liveKey ? held.sessions : [];
}
