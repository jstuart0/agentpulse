import type { SummaryViewer } from "../lib/session-summary-view.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useOwnershipUi } from "./useOwnershipUi.js";

/**
 * What the summary copy needs to know about the person looking: whether they can change settings,
 * whether the instance is shared, and whether Settings has an AI section to link to (the Labs
 * flag `aiSettingsPanel`, read the way the Settings page reads it).
 */
export function useSummaryViewer(): SummaryViewer {
	const { adminSettingsLocked, showSummarySharedNote } = useOwnershipUi();
	const aiPanelAvailable = useLabsStore((s) => s.isEnabled("aiSettingsPanel"));
	return { adminSettingsLocked, showSummarySharedNote, aiPanelAvailable };
}
