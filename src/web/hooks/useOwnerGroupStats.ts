import { useCallback, useEffect, useRef, useState } from "react";
import type { OwnerStatsGroup } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { requestKey, useRequestGuard } from "../lib/live-request.js";
import { type DashboardScope, echoMatchesRequest } from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { ownerStatsByKey } from "../pages/dashboard-groups.js";
import { useUserStore } from "../stores/user-store.js";

/**
 * The server's per-owner counts for the scope on screen, for the "N shown of M
 * · working · waiting" headers of Group by User. Asked for only while that
 * grouping is on; `refresh` is called together with the page's own counts, so
 * it adds no timer of its own. An answer lands only while the scope it was
 * asked under is still the live one.
 */
export function useOwnerGroupStats(scope: DashboardScope | null, enabled: boolean) {
	const [groups, setGroups] = useState<Map<string, OwnerStatsGroup> | null>(null);
	const viewerUserId = useUserStore((s) => s.userId);
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const key = requestKey(scope);
	const isCurrent = useRequestGuard(key);
	const generationRef = useRef(0);

	const load = useCallback(async () => {
		const asked = scopeRef.current;
		if (!asked) return;
		const askedKey = requestKey(asked);
		const generation = generationRef.current;
		try {
			const res = await api.getStatsByOwner(scopedQuery(asked));
			if (generation !== generationRef.current || !isCurrent(askedKey)) return;
			if (!echoMatchesRequest(asked.owner, viewerUserId, res.ownerScope)) return;
			setGroups(ownerStatsByKey(res.groups));
		} catch {
			// The headers fall back to counting the cards that are shown.
		}
	}, [isCurrent, viewerUserId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the scope; load reads the current one
	useEffect(() => {
		generationRef.current += 1;
		setGroups(null);
		if (!enabled || key === "") return;
		void load();
	}, [enabled, key, load]);

	return { groups, refresh: load };
}
