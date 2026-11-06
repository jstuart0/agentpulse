import { AlertTriangle } from "lucide-react";

/**
 * A stop that failed, kept on the page beside the composer until something newer happens (AGEN-110). It sits
 * in the flow at every width, so a phone sees it too. It carries no live role of its own: the page's live
 * region speaks it once when the stop turns from running to failed, and a second announcement from here
 * would read it twice.
 */
export function StopFailureAlert({ text }: { text: string }) {
	return (
		<div
			data-stop-failure=""
			className="flex items-start gap-2 border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-800 md:px-6 dark:text-red-300"
		>
			<AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
			<span className="[overflow-wrap:anywhere]">{text}</span>
		</div>
	);
}
