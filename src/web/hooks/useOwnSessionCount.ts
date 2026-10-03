import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { OWNER_ME, echoMatchesRequest } from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useUserStore } from "../stores/user-store.js";

let pending: Promise<number | null> | null = null;

/**
 * How many sessions the signed-in viewer owns, according to the server (not the
 * newest page the dashboard loaded). One request per page load, shared by the
 * default-scope decision and the "Connect your machine" card. Null when it
 * couldn't be asked.
 */
export function fetchOwnSessionCount(): Promise<number | null> {
	if (!pending) {
		pending = api
			.getSessions(scopedQuery({ owner: OWNER_ME, excludeScratch: false }, { limit: 1 }))
			.then((res) =>
				echoMatchesRequest(OWNER_ME, useUserStore.getState().userId, res.ownerScope)
					? res.total
					: null,
			)
			.catch(() => {
				pending = null;
				return null;
			});
	}
	return pending;
}

/** Forgets the shared answer, so a test can ask again. */
export function resetOwnSessionCountForTest(): void {
	pending = null;
}

export function useOwnSessionCount(enabled: boolean): number | null {
	const [count, setCount] = useState<number | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		void fetchOwnSessionCount().then((total) => {
			if (!cancelled) setCount(total);
		});
		return () => {
			cancelled = true;
		};
	}, [enabled]);
	return count;
}
