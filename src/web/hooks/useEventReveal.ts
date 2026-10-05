import type { TimelineMode } from "../components/session-detail/TimelineView.js";
import type { RevealFilters, RevealInput } from "../lib/event-deep-link.js";
import type { WorkspaceTabId } from "../lib/session-summary-core.js";

export interface EventRevealInput {
	sessionId: string | undefined;
	tab: WorkspaceTabId | null;
	eventId: number | null;
	events: RevealInput["events"];
	eventsLoaded: boolean;
	mode: TimelineMode;
	filters: RevealFilters;
	apply: {
		setMode: (mode: TimelineMode) => void;
		setFilters: (filters: Partial<Record<keyof RevealFilters, true>>) => void;
	};
	fetchContext: (eventId: number) => Promise<void>;
	flash: (eventId: number) => boolean;
	announce: (text: string) => void;
}

export function useEventReveal(_input: EventRevealInput): {
	notice: string | null;
	loadingContext: boolean;
} {
	return { notice: null, loadingContext: false };
}
