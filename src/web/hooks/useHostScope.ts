import { useCallback, useEffect, useState } from "react";
import {
	type HostParam,
	hostStorageKey,
	isExpressibleHost,
	normalizedHost,
} from "../lib/host-scope.js";
import { browserStorage } from "../lib/id-set-storage.js";
import { useDashboardScopeStore } from "../stores/dashboard-scope-store.js";
import { useUserStore } from "../stores/user-store.js";

/**
 * Which machine's sessions the dashboard opens on and shows: the viewer's stored
 * choice (kept per person, like the grouping) or every machine, settled once
 * per visit before the first request goes out. Unlike the owner scope it needs
 * no instance mode: a machine filter exists in solo and in a team alike.
 */
export function useHostScope() {
	const userId = useUserStore((s) => s.userId);
	const host = useDashboardScopeStore((s) => s.host);
	const resolved = useDashboardScopeStore((s) => s.hostResolved);
	const resolveHost = useDashboardScopeStore((s) => s.resolveHost);
	const setHost = useDashboardScopeStore((s) => s.setHost);

	const [storedChoiceDropped, setStoredChoiceDropped] = useState(false);

	useEffect(() => {
		if (resolved) return;
		const stored = browserStorage()?.getItem(hostStorageKey(userId)) ?? null;
		// A saved value the filter can't express shows every machine, and says so.
		setStoredChoiceDropped(stored !== null && !isExpressibleHost(stored));
		resolveHost(normalizedHost(stored));
	}, [resolved, userId, resolveHost]);

	/**
	 * The viewer picked a machine (or every machine): apply it and remember it for
	 * next time. A name the filter can't express is refused (false) and the view is
	 * left as it was: it is never quietly widened to every machine.
	 */
	const choose = useCallback(
		(next: HostParam): boolean => {
			if (!isExpressibleHost(next)) return false;
			const chosen = normalizedHost(next);
			setHost(chosen);
			try {
				browserStorage()?.setItem(hostStorageKey(userId), chosen);
			} catch {
				// Storage refused the write: the choice still holds for this visit.
			}
			return true;
		},
		[setHost, userId],
	);

	return { host, resolved, choose, storedChoiceDropped };
}
