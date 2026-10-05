import { useEffect } from "react";
import {
	type UnavailableReason,
	type WorkspaceTabId,
	resolveWorkspaceTab,
	tabBadge,
} from "../lib/session-summary-view.js";
import type { UseSessionSummary } from "./useSessionSummary.js";
import { useSummaryAvailability, useSummaryUnavailableReason } from "./useSummaryAvailable.js";

export interface SummaryRoute {
	/** The tab showing; null while a Summary link waits for availability. */
	workspaceTab: WorkspaceTabId | null;
	/** Set when a Summary link couldn't open the tab and Activity opened instead. */
	fellBack: { reason: UnavailableReason | null } | null;
	summaryAvailable: boolean;
}

/** Which tab `?tab=` opens right now, given whether the Summary tab exists. */
export function useSummaryRoute(tabParam: string | null): SummaryRoute {
	const availability = useSummaryAvailability();
	const reason = useSummaryUnavailableReason();
	const resolved = resolveWorkspaceTab(tabParam, availability, reason);
	return {
		workspaceTab: resolved.kind === "tab" ? resolved.tab : null,
		fellBack: resolved.kind === "tab" && resolved.fellBack ? { reason: resolved.reason } : null,
		summaryAvailable: availability === "available",
	};
}

/**
 * The word on the Summary tab. A result seen finishing is cleared as soon as the tab is open, so
 * "New" never shows for something already seen (BN-18).
 */
export function useSummaryTabBadge(
	summary: Pick<UseSessionSummary, "generating" | "newResult" | "clearNew">,
	workspaceTab: WorkspaceTabId | null,
): "Summarizing" | "New" | null {
	const tabActive = workspaceTab === "summary";
	const { newResult, clearNew } = summary;
	useEffect(() => {
		if (tabActive && newResult) clearNew();
	}, [tabActive, newResult, clearNew]);
	return tabBadge({ generating: summary.generating, newResult, tabActive });
}
