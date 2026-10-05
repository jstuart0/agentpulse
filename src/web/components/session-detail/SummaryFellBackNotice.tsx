import type { UnavailableReason } from "../../lib/session-summary-view.js";

export function SummaryFellBackNotice(_props: {
	reason: UnavailableReason | null;
	onRetry: () => void;
}) {
	return null;
}
