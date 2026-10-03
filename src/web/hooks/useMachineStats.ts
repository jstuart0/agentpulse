import { useCallback, useEffect, useRef, useState } from "react";
import type { HostStatsGroup } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { HOST_ALL, echoMatchesHost } from "../lib/host-scope.js";
import { requestKey, useRequestGuard } from "../lib/live-request.js";
import { type DashboardScope, echoMatchesRequest } from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useUserStore } from "../stores/user-store.js";

/**
 * The server's per-machine counts for the owner scope and scratch setting on
 * screen, for the Machine filter's options and the Group by Machine headers.
 * Always asked about every machine, whatever machine is chosen: the filter has
 * to keep offering the others. `refresh` is called together with the page's own
 * counts, so it adds no timer of its own. An answer lands only while the scope it
 * was asked under is still the live one, and only if it says it covered every
 * machine and the owner scope that was asked for.
 */
export function useMachineStats(scope: DashboardScope | null) {
	const [groups, setGroups] = useState<HostStatsGroup[] | null>(null);
	const viewerUserId = useUserStore((s) => s.userId);
	const everyMachine = scope === null ? null : { ...scope, host: HOST_ALL };
	const scopeRef = useRef(everyMachine);
	scopeRef.current = everyMachine;
	const key = requestKey(everyMachine);
	const isCurrent = useRequestGuard(key);
	const generationRef = useRef(0);

	const load = useCallback(async () => {
		const asked = scopeRef.current;
		if (!asked) return;
		const askedKey = requestKey(asked);
		const generation = generationRef.current;
		try {
			const res = await api.getStatsByHost(scopedQuery(asked));
			if (generation !== generationRef.current || !isCurrent(askedKey)) return;
			if (!echoMatchesRequest(asked.owner, viewerUserId, res.ownerScope)) return;
			if (!echoMatchesHost(HOST_ALL, res.hostFilter) || res.hostFilter === undefined) return;
			setGroups(res.groups);
		} catch {
			// The control keeps what it had, or stays out of the way until the next refresh.
		}
	}, [isCurrent, viewerUserId]);

	useEffect(() => {
		generationRef.current += 1;
		setGroups(null);
		if (key === "") return;
		void load();
	}, [key, load]);

	return { groups, refresh: load };
}
