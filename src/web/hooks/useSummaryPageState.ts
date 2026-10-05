import type { UnavailableReason, WorkspaceTabId } from "../lib/session-summary-view.js";
import type { UseSessionSummary } from "./useSessionSummary.js";

export interface SummaryRoute {
	workspaceTab: WorkspaceTabId | null;
	fellBack: { reason: UnavailableReason | null } | null;
	summaryAvailable: boolean;
}

export function useSummaryRoute(_tabParam: string | null): SummaryRoute {
	return { workspaceTab: "activity", fellBack: null, summaryAvailable: false };
}

export function useSummaryTabBadge(
	_summary: Pick<UseSessionSummary, "generating" | "newResult" | "clearNew">,
	_workspaceTab: WorkspaceTabId | null,
): "Summarizing" | "New" | null {
	return null;
}
