import type { OwnerChipModel } from "../lib/owner-chip.js";
import { cn } from "../lib/utils.js";

/**
 * Who owns a session, on its card, right-aligned on the project-name line.
 * Not interactive and not coloured per person: a neutral initials circle and
 * the name, at every width; a long name is cut with the full one in the
 * tooltip. Service keys and unassigned sessions are plain text. Screen readers
 * get one sentence in place of the visual pieces.
 */
export function OwnerChip({
	chip,
	widthClass = "max-w-[55%]",
}: {
	chip: OwnerChipModel;
	/**
	 * The chip's width cap. A percentage resolves against the parent, which is right inside a
	 * card's full-width row and wrong inside a shrink-to-fit wrapper (the session header),
	 * where it collapses to a few pixels: there, pass a fixed cap.
	 */
	widthClass?: string;
}) {
	return (
		<span
			title={chip.title}
			className={cn(
				"inline-flex min-w-0 flex-shrink-0 items-center gap-1.5 rounded-full bg-muted py-0.5 pl-0.5 pr-2 text-[10px] font-medium text-foreground",
				widthClass,
			)}
		>
			{chip.initials && (
				<span
					aria-hidden="true"
					className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-background px-1 text-[9px] font-semibold leading-none"
				>
					{chip.initials}
				</span>
			)}
			<span aria-hidden="true" className={chip.initials ? "truncate" : "truncate pl-1.5"}>
				{chip.text}
			</span>
			<span className="sr-only">{chip.srText}</span>
		</span>
	);
}
