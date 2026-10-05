import type { SummaryViewer } from "../lib/session-summary-view.js";

export function useSummaryViewer(): SummaryViewer {
	return { adminSettingsLocked: false, showSummarySharedNote: false, aiPanelAvailable: true };
}
