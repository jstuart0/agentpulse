import { useEffect } from "react";
import { useSummaryViewStore } from "../stores/summary-view-store.js";
import { useSessionSummary } from "./useSessionSummary.js";
import { reloadSummaryAvailability } from "./useSummaryAvailable.js";
import { useSummaryRoute, useSummaryTabBadge } from "./useSummaryPageState.js";

/**
 * Everything the session page does for the Summary feature, in one place: which tab the URL opens,
 * the one page-level read of the summary (only while the feature is available), the tab badge,
 * availability asked for on mount, announcements into the page's live region, and the held
 * open/closed state cleared when the session changes.
 */
export function useSessionSummaryPage(input: {
	sessionId: string | undefined;
	tabParam: string | null;
	announce: (text: string) => void;
}) {
	const { sessionId, tabParam, announce } = input;
	const route = useSummaryRoute(tabParam);
	const summary = useSessionSummary(sessionId, route.summaryAvailable);
	const badge = useSummaryTabBadge(summary, route.workspaceTab);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the session id is the trigger
	useEffect(() => {
		useSummaryViewStore.getState().reset();
		return () => useSummaryViewStore.getState().reset();
	}, [sessionId]);
	const { announcement } = summary;
	useEffect(() => {
		if (announcement) announce(announcement);
	}, [announcement, announce]);
	useEffect(() => {
		void reloadSummaryAvailability();
	}, []);

	return {
		route,
		summary,
		badge,
		retryAvailability: () => void reloadSummaryAvailability(),
	};
}
