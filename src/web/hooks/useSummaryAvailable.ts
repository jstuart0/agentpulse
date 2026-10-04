import {
	type Availability,
	SESSION_SUMMARY_FLAG,
	summaryAvailability,
} from "../lib/session-summary-view.js";
import { useAiStatusStore } from "../stores/ai-status-store.js";
import { useLabsStore } from "../stores/labs-store.js";

/**
 * Whether the Summary tab exists, with "pending" while the Labs flags or the AI status are still
 * loading (so a `?tab=summary` link neither bounces nor waits forever). Each input is a primitive
 * selector: a change to anything else in either store re-renders nothing.
 */
export function useSummaryAvailability(): Availability {
	const flag = useLabsStore((s) =>
		s.flags === null
			? null
			: (s.flags as Readonly<Record<string, boolean>>)[SESSION_SUMMARY_FLAG] === true,
	);
	const labsLoadFailed = useLabsStore((s) => s.flags === null && s.error !== null && !s.loading);
	const aiBuild = useAiStatusStore((s) => (s.status === null ? null : s.status.build));
	const aiLoadFailed = useAiStatusStore((s) => s.status === null && s.loadState === "error");
	return summaryAvailability({ flag, labsLoadFailed, aiBuild, aiLoadFailed });
}

export function useSummaryAvailable(): boolean {
	return useSummaryAvailability() === "available";
}
