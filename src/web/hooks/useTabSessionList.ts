import { useMemo } from "react";
import { api } from "../lib/api.js";
import { requestKey } from "../lib/live-request.js";
import { type DashboardScope, assertEchoMatches } from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useUserStore } from "../stores/user-store.js";
import { type PagedListSpec, useScopedPagedList } from "./useScopedPagedList.js";

export type ListedTab = "active" | "completed" | "archived" | "all";

/**
 * The dashboard's tabs, listed by the server for the whole scope (not only the
 * newest page the dashboard holds): Active, Completed and Archived are the
 * server's three tab lists, which partition the scope and are the very sets the
 * tab badges count, so a list and its badge describe one set. All is the plain
 * list with the archived sessions left out (they have their own tab); it pages
 * through the server like the others, and what it skips over is still counted as
 * read, so a refresh re-reads exactly as far as the list had got.
 *
 * `search` is the server's `q`. Every answer lands only while the scope, tab and
 * search it was asked under are still the live ones; see useScopedPagedList.
 */
export function useTabSessionList(
	tab: ListedTab | null,
	isInteracting: (() => boolean) | undefined,
	search: string,
	scope: DashboardScope,
) {
	const viewerUserId = useUserStore((s) => s.userId);
	const owner = scope.owner;
	const excludeScratch = scope.excludeScratch;
	const spec = useMemo<PagedListSpec | null>(() => {
		if (!tab) return null;
		const asked: DashboardScope = { owner, excludeScratch };
		return {
			key: requestKey(asked, "tab", tab, search),
			fetch: async (cursor, want) => {
				const res = await api.getSessions(
					scopedQuery(asked, {
						...(tab === "all" ? {} : { tab }),
						q: search,
						limit: want,
						offset: cursor,
					}),
				);
				assertEchoMatches(owner, viewerUserId, res.ownerScope);
				const next = cursor + res.sessions.length;
				return {
					rows:
						tab === "all" ? res.sessions.filter((session) => !session.isArchived) : res.sessions,
					total: res.total,
					next,
					done: res.sessions.length === 0 || next >= res.total,
				};
			},
		};
	}, [tab, search, owner, excludeScratch, viewerUserId]);
	return useScopedPagedList(spec, isInteracting);
}
