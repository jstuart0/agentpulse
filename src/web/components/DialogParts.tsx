import type { ReactNode } from "react";

/** A disabled primary button takes the muted fill, not a half-faded teal: in dark mode a faded teal still reads as clickable. */
const DISABLED_PRIMARY =
	"disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:ring-1 disabled:ring-inset disabled:ring-border dark:disabled:bg-muted dark:disabled:text-muted-foreground";

export const PRIMARY_BUTTON = `min-h-[44px] rounded-md bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 text-sm font-medium transition-colors ${DISABLED_PRIMARY} disabled:hover:bg-muted dark:disabled:hover:bg-muted md:min-h-0`;
export const SECONDARY_BUTTON =
	"min-h-[44px] rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50 md:min-h-0";
export const FIELD_CONTROL =
	"min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring md:min-h-0";

/**
 * The button row pinned to the bottom of a dialog, so it stays in reach on a
 * sheet. A `note` (why the main button is disabled) sits above the buttons on
 * phones and to their left from `md`, so it is read before the button it explains.
 */
export function DialogFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
	return (
		<div className="sticky bottom-0 mt-auto flex flex-col gap-2 border-t border-border bg-card p-4 md:flex-row md:items-center md:justify-end md:px-6">
			{note}
			<div className="flex flex-col-reverse gap-2 md:flex-row md:items-center md:justify-end">
				{children}
			</div>
		</div>
	);
}
