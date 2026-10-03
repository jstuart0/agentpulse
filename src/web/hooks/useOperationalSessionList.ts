import { useMemo } from "react";
import type { ActiveOperationalStatus } from "../../shared/session-state.js";
import { api } from "../lib/api.js";
import { requestKey } from "../lib/live-request.js";
import { type DashboardScope, assertEchoMatches } from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useUserStore } from "../stores/user-store.js";
import { type PagedListSpec, useScopedPagedList } from "./useScopedPagedList.js";

/**
 * Server-paged session list for a single selected operational status card.
 * Inactive (an empty, non-loading result) when `status` is null: the
 * dashboard's unfiltered view keeps using the page useSessions() loaded.
 *
 * `search` is forwarded as `q`, so a search composes with the status filter
 * across the whole set. `scope` (whose sessions, and the scratch toggle) is
 * applied by the server before paging. Every answer lands only while the
 * scope, status and search it was asked under are still the live ones; see
 * useScopedPagedList.
 *
 * `isInteracting` lets the caller hold a debounced background refresh while the
 * person is hovering or focused on a card, so rows never move under their
 * pointer.
 */
export function useOperationalSessionList(
	status: ActiveOperationalStatus | null,
	isInteracting: (() => boolean) | undefined,
	search: string,
	scope: DashboardScope,
) {
	const viewerUserId = useUserStore((s) => s.userId);
	const owner = scope.owner;
	const excludeScratch = scope.excludeScratch;
	const spec = useMemo<PagedListSpec | null>(() => {
		if (!status) return null;
		const asked: DashboardScope = { owner, excludeScratch };
		return {
			key: requestKey(asked, "operational", status, search),
			fetch: async (cursor, want) => {
				const res = await api.getSessions(
					scopedQuery(asked, { operational: status, q: search, limit: want, offset: cursor }),
				);
				assertEchoMatches(owner, viewerUserId, res.ownerScope);
				const next = cursor + res.sessions.length;
				return {
					rows: res.sessions,
					total: res.total,
					next,
					done: res.sessions.length === 0 || next >= res.total,
				};
			},
		};
	}, [status, search, owner, excludeScratch, viewerUserId]);
	return useScopedPagedList(spec, isInteracting);
}
