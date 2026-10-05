import type { StoredSessionSummary } from "../../shared/session-summary.js";
import type { CopyMeta } from "./session-summary-view.js";

export type CopyKind = "handoff" | "summary" | "context";

export const COPY_ANNOUNCEMENT: Record<CopyKind, string> = {
	handoff: "",
	summary: "",
	context: "",
};

export const COPY_FALLBACK_LINE = "";

export function buildCopyText(
	_kind: CopyKind,
	_stored: StoredSessionSummary,
	_meta: CopyMeta,
): string {
	return "";
}

export async function copyToClipboard(
	_text: string,
	_clipboard?: { writeText(text: string): Promise<void> } | null,
): Promise<"copied" | "refused"> {
	return "refused";
}
