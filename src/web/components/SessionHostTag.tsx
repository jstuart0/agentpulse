import { Monitor } from "lucide-react";
import type { SessionHostLabel } from "../lib/session-host.js";
import { cn } from "../lib/utils.js";

/**
 * "on <machine>" beside a session's name or owner. Plain muted text with a small
 * icon, no border or fill, so it stays quiet; a long name is cut with the full
 * one in the tooltip. The name comes from the sender and is rendered only as React
 * text. Screen readers get one sentence in place of the visual pieces.
 */
export function SessionHostTag({
	label,
	className,
}: {
	label: SessionHostLabel;
	className?: string;
}) {
	return (
		<span
			title={label.title}
			className={cn(
				"inline-flex min-w-0 flex-shrink items-center gap-1 text-[11px] text-muted-foreground",
				className,
			)}
		>
			<Monitor aria-hidden="true" className="h-3 w-3 flex-shrink-0" />
			<span aria-hidden="true" className="truncate">
				{label.text}
			</span>
			<span className="sr-only">{label.srText}</span>
		</span>
	);
}
