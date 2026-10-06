import type { UseSessionSummary } from "../../hooks/useSessionSummary.js";
import { useSummaryViewer } from "../../hooks/useSummaryViewer.js";
import { useAiStatusStore } from "../../stores/ai-status-store.js";
import { SessionSummaryPanel } from "./SessionSummaryPanel.js";

export interface SessionSummaryTabProps {
	sessionId: string;
	agentType: string | null;
	/** The page-level hook's result: the page mounts it once so a generation outlives a tab switch. */
	summary: UseSessionSummary;
	meta?: { name: string | null; branch: string | null; cwd: string | null };
	announce?: (text: string) => void;
}

/** The Summary tab: the page's summary state and the app's AI status and viewer, handed to the panel. */
export function SessionSummaryTab({
	sessionId,
	agentType,
	summary,
	meta,
	announce,
}: SessionSummaryTabProps) {
	const aiStatus = useAiStatusStore((s) => s.status);
	const viewer = useSummaryViewer();
	return (
		<SessionSummaryPanel
			sessionId={sessionId}
			agentType={agentType}
			load={summary.load}
			lostContact={summary.lostContact}
			refusal={summary.refusal}
			aiStatus={aiStatus}
			viewer={viewer}
			generate={summary.generate}
			retry={summary.retry}
			meta={meta}
			announce={announce}
			announcement={summary.announcement}
		/>
	);
}
