import {
	type Availability,
	type UnavailableReason,
	selectAiBuild,
	selectAiLoadFailed,
	selectLabsLoadFailed,
	selectSummaryFlag,
	summaryAvailabilityDetail,
} from "../lib/session-summary-core.js";
import { useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";

/**
 * Whether the Summary tab exists, with why not. Each input is a primitive selector (the same pure
 * selectors `availabilityFromStores` uses), so a change to anything else in either store
 * re-renders nothing.
 */
function useAvailabilityDetail() {
	const flag = useLabsStore(selectSummaryFlag);
	const labsLoadFailed = useLabsStore(selectLabsLoadFailed);
	const aiBuild = useAiStatusStore(selectAiBuild);
	const aiLoadFailed = useAiStatusStore(selectAiLoadFailed);
	return summaryAvailabilityDetail({ flag, labsLoadFailed, aiBuild, aiLoadFailed });
}

/** "pending" while the Labs flags or the AI status are still loading (a `?tab=summary` link neither bounces nor waits forever). */
export function useSummaryAvailability(): Availability {
	return useAvailabilityDetail().availability;
}

/** Why the tab is missing, for the one line shown when a summary link falls back; null otherwise. */
export function useSummaryUnavailableReason(): UnavailableReason | null {
	return useAvailabilityDetail().reason;
}

export function useSummaryAvailable(): boolean {
	return useSummaryAvailability() === "available";
}

/**
 * Ask again for whichever source has not answered (a flags load that failed, an AI status load
 * that failed). The session page calls it on mount so one failed startup load doesn't hide the
 * tab for the whole visit. Sources that already answered are not asked again; failures stay on
 * the stores and never throw.
 */
export async function reloadSummaryAvailability(): Promise<void> {
	const labs = useLabsStore.getState();
	await Promise.all([
		labs.flags === null ? labs.load() : Promise.resolve(),
		useAiStatusStore.getState().load(),
	]);
}

/** For pages that only link to the Summary tab: availability, asking for whatever hasn't loaded yet. */
export function useEnsuredSummaryAvailability(): Availability {
	return useSummaryAvailability();
}
