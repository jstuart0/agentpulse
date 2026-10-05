import { Link } from "react-router-dom";
import { useEnsuredSummaryAvailability } from "../hooks/useSummaryAvailable.js";
import { summaryHref } from "../lib/session-summary-core.js";

/**
 * A link to a session's Summary tab, drawn only while the feature is available (the Labs flag on
 * and AI built in), so nobody is sent to a tab that isn't there.
 */
export function SummaryLink({
	sessionId,
	variant,
}: { sessionId: string; variant: "button" | "text" }) {
	if (useEnsuredSummaryAvailability() !== "available") return null;
	return variant === "button" ? (
		<Link
			to={summaryHref(sessionId)}
			className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
		>
			Open Summary
		</Link>
	) : (
		<Link to={summaryHref(sessionId)} className="text-primary hover:underline">
			Summary
		</Link>
	);
}
