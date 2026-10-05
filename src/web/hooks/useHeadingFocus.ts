import { type RefObject, useEffect } from "react";
import { shouldFocusHeading } from "../lib/session-summary-core.js";
import type { SummaryAnnouncement } from "./useSessionSummary.js";

interface Containing {
	contains(node: unknown): boolean;
}
interface Focusable {
	focus(): void;
}

/**
 * When your own generation ends (the announcement says ready or failed), the panel's heading
 * takes focus, but only if focus is still inside the panel: someone who moved on is not pulled back.
 */
export function useHeadingFocus(
	root: RefObject<Containing | null>,
	heading: RefObject<Focusable | null>,
	announcement: SummaryAnnouncement | null,
	active: () => unknown = () => document.activeElement,
): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the announcement changes, nothing else
	useEffect(() => {
		const inside = root.current?.contains(active()) ?? false;
		if (shouldFocusHeading(announcement, inside)) heading.current?.focus();
	}, [announcement]);
}
