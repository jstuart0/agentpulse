import type { SessionSummary, SummarySuspectReason } from "../../../../shared/session-summary.js";

export function extractUrlKeys(_text: string, _mode: "model" | "user"): string[] {
	throw new Error("not implemented");
}

export function collectUserPromptUrls(_texts: Iterable<string>): Set<string> {
	throw new Error("not implemented");
}

export function checkText(
	_text: string,
	_opts: { checkUrls: boolean; userPromptUrls: ReadonlySet<string> },
): SummarySuspectReason[] {
	throw new Error("not implemented");
}

export function runTripwire(
	_summary: SessionSummary,
	_userPromptUrls: ReadonlySet<string>,
): SummarySuspectReason[] {
	throw new Error("not implemented");
}
