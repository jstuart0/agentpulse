import { cn } from "../lib/utils.js";

/**
 * StatCard — reusable KPI tile used by DashboardPage and DigestPage.
 *
 * Props:
 *   label    — short descriptor rendered above the value
 *   value    — the primary number or string
 *   sub      — optional secondary line below the value (DashboardPage usage)
 *   tone     — optional color override: "warn" (amber), "danger" (red),
 *              "success" (emerald) or "muted" (low-attention slate).
 *              Default is "default" (foreground color). DigestPage uses
 *              warn/danger to flag blocked / stuck counts; the dashboard's
 *              operational status cards use all four.
 *   onClick  — when set, the tile renders as a toggle button (used by the
 *              dashboard's single-select status filter)
 *   selected — pressed state of that toggle; also drives the highlight ring
 */
export function StatCard({
	label,
	value,
	sub,
	tone = "default",
	onClick,
	selected = false,
	title,
	compact = false,
}: {
	label: string;
	value: string | number;
	sub?: string;
	tone?: "default" | "warn" | "danger" | "success" | "muted";
	onClick?: () => void;
	selected?: boolean;
	/** Tooltip describing exactly what this tile counts (e.g. "Sessions with an outstanding permission prompt or an unseen finished turn"). */
	title?: string;
	/** Tighter padding on phones, for the team dashboard's four-in-a-row status cards. Solo and the Digest keep the original padding. */
	compact?: boolean;
}) {
	// Light-theme-safe shade paired with the existing dark-theme shade via
	// `dark:` (see StatusBadge.tsx for the same pairing on the status badges).
	const toneClass =
		tone === "warn"
			? "text-amber-700 dark:text-amber-300"
			: tone === "danger"
				? "text-red-600 dark:text-red-300"
				: tone === "success"
					? "text-emerald-700 dark:text-emerald-400"
					: tone === "muted"
						? "text-slate-600 dark:text-slate-400"
						: "text-foreground";
	// The read-only tiles reserve the sub-line's height always (invisible
	// placeholder when absent) so a changing `sub` never shifts the layout.
	// The clickable status cards never carry one, so they don't reserve it.
	const body = (
		<>
			<p className="text-xs text-muted-foreground mb-1">{label}</p>
			<p className={`text-2xl font-bold ${toneClass}`}>{value}</p>
			<p className="text-xs text-muted-foreground mt-0.5 min-h-[1em]">{sub || " "}</p>
		</>
	);
	const frame = cn("rounded-lg border bg-card", compact ? "p-2.5 md:p-4" : "p-4");
	if (onClick) {
		return (
			<button
				type="button"
				aria-pressed={selected}
				onClick={onClick}
				title={title}
				className={cn(
					frame,
					"w-full text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					selected
						? "border-primary bg-primary/10 dark:bg-primary/15"
						: "border-border hover:bg-accent",
				)}
			>
				{body}
			</button>
		);
	}
	return (
		<div className={cn(frame, "border-border")} title={title}>
			{body}
		</div>
	);
}
