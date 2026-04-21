import { useState } from "react";
import type { ControlAction } from "../../../shared/types.js";

/**
 * Control-history card. On mobile, the list is collapsed by default
 * so the timeline isn't pushed off-screen; a single-line summary of
 * the most-recent action remains visible and tap expands the rest.
 * Desktop shows the full card as before.
 */
export function ControlHistory({ actions }: { actions: ControlAction[] }) {
	const [expanded, setExpanded] = useState(false);
	if (actions.length === 0) return null;
	const recent = actions.slice(-5).reverse();
	const latest = recent[0];

	return (
		<div className="mx-3 md:mx-6 mt-2 md:mt-3 rounded-lg border border-border bg-card px-3 py-2 md:py-2.5">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="w-full flex items-center justify-between gap-2 md:hidden text-left"
				aria-expanded={expanded}
			>
				<span className="text-xs font-medium text-foreground">
					Control history · {actions.length}
				</span>
				<span className="flex items-center gap-2 text-[10px] text-muted-foreground">
					<span className="truncate max-w-[10rem]">
						{latest.actionType} · {latest.status}
					</span>
					<svg
						className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
					</svg>
				</span>
			</button>
			<div className="hidden md:block text-xs font-medium text-foreground">Control History</div>
			<div className={`${expanded ? "block" : "hidden"} md:block mt-2 space-y-1.5`}>
				{recent.map((action) => (
					<div key={action.id} className="flex items-center justify-between gap-3 text-[11px]">
						<span className="text-muted-foreground">
							{action.actionType}
							{action.error ? `: ${action.error}` : ""}
						</span>
						<span className="font-mono text-foreground">{action.status}</span>
					</div>
				))}
			</div>
		</div>
	);
}
