import type { StoredSessionSummary } from "../../shared/session-summary.js";
import {
	type CopyMeta,
	buildContextMarkdown,
	buildHandoffMarkdown,
	buildSummaryMarkdown,
} from "./session-summary-view.js";

export type CopyKind = "handoff" | "summary" | "context";

/** What the page's live region says after a successful copy. */
export const COPY_ANNOUNCEMENT: Record<CopyKind, string> = {
	handoff: "Handoff copied",
	summary: "Summary copied",
	context: "Context copied",
};

/** What Copy handoff holds, as its description and its visible hint. */
export const COPY_HANDOFF_HINT =
	"Outcome, unfinished work, next actions and key context, for another agent";

export const COPY_FALLBACK_LINE = "Couldn't copy automatically. Select the text below and copy it.";

export function buildCopyText(
	kind: CopyKind,
	stored: StoredSessionSummary,
	meta: CopyMeta,
): string {
	switch (kind) {
		case "handoff":
			return buildHandoffMarkdown(stored, meta);
		case "summary":
			return buildSummaryMarkdown(stored, meta);
		case "context":
			return buildContextMarkdown(stored);
	}
}

/** "refused" when the browser has no clipboard API or says no (a permission, an insecure page). */
export async function copyToClipboard(
	text: string,
	clipboard: { writeText(text: string): Promise<void> } | null = typeof navigator === "undefined"
		? null
		: navigator.clipboard,
): Promise<"copied" | "refused"> {
	try {
		if (!clipboard || typeof clipboard.writeText !== "function") return "refused";
		await clipboard.writeText(text);
		return "copied";
	} catch {
		return "refused";
	}
}
