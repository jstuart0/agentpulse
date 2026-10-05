import { Link } from "react-router-dom";
import { useOwnershipUi } from "../../hooks/useOwnershipUi.js";
import {
	SESSION_SUMMARY_FLAG,
	labsPointer,
	selectAiBuild,
} from "../../lib/session-summary-core.js";
import { useAiStatusStore } from "../../stores/ai-status-store.js";
import { useLabsStore } from "../../stores/labs-store.js";
import { workspaceTabButtonId } from "./WorkspaceTabBar.js";

/** Moves focus to the Summary tab button, which has just appeared; does nothing if it isn't there. */
export function focusSummaryTab(root: Pick<Document, "getElementById">): void {
	root.getElementById(workspaceTabButtonId("summary"))?.focus();
}

/**
 * Turns Session summaries on through the Labs store. True once the flag is on (the store puts it
 * back and says why when the server refuses, so a refusal reads as false and focus stays put).
 */
export async function turnOnSessionSummaries(): Promise<boolean> {
	await useLabsStore.getState().setFlag(SESSION_SUMMARY_FLAG as never, true);
	const flags = useLabsStore.getState().flags as Readonly<Record<string, boolean>> | null;
	return flags?.[SESSION_SUMMARY_FLAG] === true;
}

async function turnOn() {
	if (await turnOnSessionSummaries()) {
		requestAnimationFrame(() => focusSummaryTab(document));
	}
}

/**
 * The line at the top of the AI tab while Session summaries are off: what it is, a Turn on button
 * for someone who may change Labs, or whom to ask. Draws nothing before the flags load, once the
 * flag is on, or when AI isn't built into this server.
 */
export function SummaryLabsPointer() {
	const flags = useLabsStore((s) => s.flags) as Readonly<Record<string, boolean>> | null;
	const aiBuild = useAiStatusStore(selectAiBuild);
	const { adminSettingsLocked } = useOwnershipUi();
	const pointer = labsPointer(flags, { adminSettingsLocked }, aiBuild);
	if (!pointer.visible) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
			<span>{pointer.text}</span>
			{pointer.canTurnOn && (
				<button
					type="button"
					onClick={() => void turnOn()}
					className="min-h-[44px] rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 md:min-h-0"
				>
					Turn on
				</button>
			)}
			{pointer.learnMoreHref && (
				<Link
					to={pointer.learnMoreHref}
					className="inline-flex min-h-[44px] items-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground md:min-h-0"
				>
					What it does
				</Link>
			)}
		</div>
	);
}
