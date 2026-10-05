import type { UseSessionSummary } from "../../hooks/useSessionSummary.js";
import type { AiStatusResponse } from "../../lib/api.js";
import type {
	ClockOptions,
	RefusalCopy,
	SummaryLoad,
	SummaryViewer,
} from "../../lib/session-summary-view.js";

export interface SessionSummaryPanelProps {
	sessionId: string;
	agentType: string | null;
	load: SummaryLoad;
	lostContact: boolean;
	refusal: RefusalCopy | null;
	aiStatus: AiStatusResponse | null;
	viewer: SummaryViewer;
	generate: UseSessionSummary["generate"];
	retry: () => void;
	clock?: ClockOptions;
}

export function SessionSummaryPanel(_props: SessionSummaryPanelProps) {
	return null;
}
