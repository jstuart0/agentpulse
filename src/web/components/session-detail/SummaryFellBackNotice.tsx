import { type UnavailableReason, fellBackCopy } from "../../lib/session-summary-view.js";
import { SummaryLabsPointer } from "./SummaryLabsPointer.js";

/**
 * Above Activity when a `?tab=summary` link couldn't open the Summary tab: why, in one line, and
 * the way forward that fits (the Labs pointer when it's just off, Retry when the check failed).
 */
export function SummaryFellBackNotice({
	reason,
	onRetry,
}: {
	reason: UnavailableReason | null;
	onRetry: () => void;
}) {
	const line = fellBackCopy(reason);
	if (!line) return null;
	return (
		<div className="space-y-2 px-3 pt-3 md:px-6">
			<p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
				<span>{line}</span>
				{reason === "load_failed" && (
					<button
						type="button"
						onClick={onRetry}
						className="min-h-[44px] rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent md:min-h-0"
					>
						Retry
					</button>
				)}
			</p>
			{reason === "flag_off" && <SummaryLabsPointer />}
		</div>
	);
}
