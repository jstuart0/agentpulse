import type { UseSessionSummary } from "../../hooks/useSessionSummary.js";

export interface SessionSummaryTabProps {
	sessionId: string;
	agentType: string | null;
	summary: UseSessionSummary;
}

export function SessionSummaryTab(_props: SessionSummaryTabProps) {
	return null;
}
