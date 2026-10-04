import type { SessionSummaryView } from "../../shared/session-summary-view.js";
import type { RefusalCopy, SummaryLoad } from "../lib/session-summary-view.js";

/** Milliseconds between polls while a generation runs. */
export const SUMMARY_POLL_INTERVAL_MS = 2000;
/** Consecutive poll failures tolerated before the load is reported as failed. */
export const SUMMARY_POLL_RETRIES = 3;
export const COOLDOWN_TICK_MS = 1000;

export type SummaryAnnouncement = "Summarizing" | "Summary ready" | "Summary failed";

export interface UseSessionSummary {
	load: SummaryLoad;
	generating: boolean;
	startedHere: boolean;
	announcement: SummaryAnnouncement | null;
	newResult: boolean;
	refusal: RefusalCopy | null;
	generate: (options?: { confirmed?: boolean }) => Promise<
		"started" | "needs_confirmation" | "ignored"
	>;
	retry: () => void;
	clearNew: () => void;
}

export function useSessionSummary(
	_sessionId: string | undefined,
	_enabled: boolean,
): UseSessionSummary {
	throw new Error("not implemented");
}

export type { SessionSummaryView };
