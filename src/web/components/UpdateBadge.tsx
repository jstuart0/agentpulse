import { ArrowUpCircle, CircleHelp, ShieldAlert, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useOwnershipUi } from "../hooks/useOwnershipUi.js";
import { cn } from "../lib/utils.js";
import { useUpdateStore } from "../stores/update-store.js";
import { type UpdateBadgeView, deriveUpdateBadge } from "./update-view.js";

/**
 * "A newer version exists" (or "can't verify"), as a link to the Updates panel. Words and an icon, never
 * colour alone; a 44px target; its accessible name starts with the visible words. It is drawn in the desktop
 * top bar and the mobile bar, and `data-update-badge` is how the banner finds whichever one is on screen.
 */
export function UpdateBadge({ surface }: { surface: "desktop" | "mobile" }) {
	const status = useUpdateStore((s) => s.status);
	const { adminSettingsLocked } = useOwnershipUi();
	const badge = deriveUpdateBadge(status, { adminSettingsLocked });
	return badge ? <UpdateBadgeLink badge={badge} surface={surface} /> : null;
}

export function UpdateBadgeLink({
	badge,
	surface,
}: {
	badge: UpdateBadgeView;
	surface: "desktop" | "mobile";
}) {
	const Icon =
		badge.state === "security"
			? ShieldAlert
			: badge.state === "unverified"
				? CircleHelp
				: badge.tone === "red"
					? TriangleAlert
					: ArrowUpCircle;
	const mobile = surface === "mobile";
	// The link is the 44px tap area; the pill inside is what is seen, so the bar stays slim.
	return (
		<Link
			to="/settings?panel=updates"
			aria-label={badge.name}
			data-update-badge={surface}
			className="ml-2 inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span
				className={cn(
					"inline-flex items-center gap-1 rounded-md border font-medium",
					mobile ? "px-1.5 py-0.5 text-[11px]" : "px-2.5 py-1.5 text-xs",
					badge.tone === "red"
						? "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-300"
						: "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
				)}
			>
				<Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
				<span>{mobile ? badge.shortText : badge.text}</span>
			</span>
		</Link>
	);
}
