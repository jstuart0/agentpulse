import { useCallback, useEffect, useRef, useState } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import { ApiError, api } from "../lib/api.js";
import { createRequestOrder } from "../lib/request-order.js";

/**
 * Builds the load-failure copy shown in place of the list: distinct from the genuine "no hosts
 * registered" empty state. A failed list request used to render identically to a server with zero
 * registered hosts.
 */
export function formatLoadError(err: unknown): string {
	const detail = err instanceof ApiError ? `${err.status} ${err.message}` : "network error";
	return `Couldn't load hosts: ${detail}`;
}

export interface SupervisorListOptions {
	/** Called when a load's answer was taken, so the page's clock can move. */
	onFresh: () => void;
}

/**
 * The Hosts page's list, and the order its answers may land in. An older answer never replaces a
 * newer one; an older failure after a newer answer is not shown. `quiet` is the background refetch
 * while the tab is in view: no spinner, and a failure waits for the next one.
 */
export function useSupervisorList({ onFresh }: SupervisorListOptions) {
	const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [refreshFailed, setRefreshFailed] = useState(false);
	const [lastHeardAt, setLastHeardAt] = useState<number | null>(null);

	const onFreshRef = useRef(onFresh);
	onFreshRef.current = onFresh;
	const orderRef = useRef(createRequestOrder());
	const pendingRef = useRef(0);
	const refreshingRef = useRef(0);
	const mountedRef = useRef(false);

	useEffect(() => {
		mountedRef.current = true;
		const order = orderRef.current;
		return () => {
			mountedRef.current = false;
			order.markApplied();
		};
	}, []);

	/** True when the answer was taken. */
	const load = useCallback(async (showInitialLoader = false, quiet = false): Promise<boolean> => {
		const ticket = orderRef.current.begin();
		const personsRefresh = !showInitialLoader && !quiet;
		pendingRef.current++;
		if (showInitialLoader) setLoading(true);
		if (personsRefresh) {
			refreshingRef.current++;
			setRefreshing(true);
		}
		let taken = false;
		try {
			const result = (await api.getSupervisors({ background: quiet })) as {
				supervisors: SupervisorRecord[];
			};
			if (!mountedRef.current || !ticket.claim()) return false;
			taken = true;
			setSupervisors(result.supervisors ?? []);
			setLoadError(null);
			setRefreshFailed(false);
			setLastHeardAt(Date.now());
			onFreshRef.current();
			return true;
		} catch (err) {
			if (mountedRef.current && ticket.peek()) {
				console.error("Failed to load supervisors:", err);
				if (quiet) setRefreshFailed(true);
				else setLoadError(formatLoadError(err));
			}
			return false;
		} finally {
			pendingRef.current--;
			if (personsRefresh) refreshingRef.current--;
			if (mountedRef.current) {
				if (taken || pendingRef.current === 0) setLoading(false);
				setRefreshing(refreshingRef.current > 0);
			}
		}
	}, []);

	return { supervisors, loading, refreshing, loadError, refreshFailed, lastHeardAt, load };
}
