import { useCallback, useEffect } from "react";
import { browserStorage } from "../lib/id-set-storage.js";
import { OWNER_ALL, type OwnerParam } from "../lib/owner-scope.js";
import {
	choiceForOwner,
	defaultOwner,
	parseScopeChoice,
	scopeStorageKey,
} from "../pages/dashboard-scope.js";
import { useDashboardScopeStore } from "../stores/dashboard-scope-store.js";
import { useUserStore } from "../stores/user-store.js";
import { fetchOwnSessionCount } from "./useOwnSessionCount.js";
import { useOwnershipUi } from "./useOwnershipUi.js";

/**
 * Settles whose sessions the dashboard opens on, once per visit: solo is
 * always everyone's; a team viewer gets their stored Mine | Everyone choice,
 * or else Mine if the server says they own any session (asked, because their
 * sessions may not be in the newest page) and Everyone if not. Nothing is
 * stored until the viewer picks something themselves.
 */
export function useDefaultOwnerScope() {
	const ui = useOwnershipUi();
	const userId = useUserStore((s) => s.userId);
	const owner = useDashboardScopeStore((s) => s.owner);
	const resolved = useDashboardScopeStore((s) => s.resolved);
	const resolveOwner = useDashboardScopeStore((s) => s.resolveOwner);
	const setOwner = useDashboardScopeStore((s) => s.setOwner);

	useEffect(() => {
		// Without the switch (solo, or the instance was switched back to solo
		// while this tab was open) nothing but Everyone can be on, and nothing
		// on the page could change it.
		if (!ui.showScope) {
			if (!resolved || owner !== OWNER_ALL) resolveOwner(OWNER_ALL);
			return;
		}
		if (resolved) return;
		const stored = parseScopeChoice(browserStorage()?.getItem(scopeStorageKey(userId)) ?? null);
		if (stored) {
			resolveOwner(defaultOwner({ stored, ownSessions: null }));
			return;
		}
		let cancelled = false;
		void fetchOwnSessionCount().then((ownSessions) => {
			if (!cancelled) resolveOwner(defaultOwner({ stored: null, ownSessions }));
		});
		return () => {
			cancelled = true;
		};
	}, [resolved, owner, ui.showScope, userId, resolveOwner]);

	/** The viewer picked Mine, Everyone or an owner: apply it and remember Mine | Everyone for next time. */
	const choose = useCallback(
		(next: OwnerParam) => {
			setOwner(next);
			try {
				browserStorage()?.setItem(scopeStorageKey(userId), choiceForOwner(next));
			} catch {
				// Storage refused the write: the choice still holds for this visit.
			}
		},
		[setOwner, userId],
	);

	return { owner, resolved, choose };
}
