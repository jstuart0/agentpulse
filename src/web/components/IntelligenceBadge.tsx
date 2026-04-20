import type { SessionHealthState, SessionIntelligence } from "../lib/api.js";

const STYLES: Record<SessionHealthState, { dot: string; label: string; text: string }> = {
	healthy: {
		dot: "bg-emerald-400",
		label: "healthy",
		text: "text-emerald-300",
	},
	blocked: {
		dot: "bg-amber-400",
		label: "blocked",
		text: "text-amber-300",
	},
	stuck: {
		dot: "bg-red-400",
		label: "stuck",
		text: "text-red-300",
	},
	risky: {
		dot: "bg-red-400",
		label: "risky",
		text: "text-red-300",
	},
	complete_candidate: {
		dot: "bg-sky-400",
		label: "done?",
		text: "text-sky-300",
	},
};

interface Props {
	intelligence: SessionIntelligence | null | undefined;
	size?: "sm" | "md";
}

/**
 * Small status chip rendering the Phase 2 classifier output. The tooltip
 * carries the full explanation so operators can see *why* without clicking
 * into the session.
 */
export function IntelligenceBadge({ intelligence, size = "sm" }: Props) {
	if (!intelligence) return null;
	const style = STYLES[intelligence.health];
	const padding = size === "md" ? "px-2 py-0.5" : "px-1.5 py-0.5";
	const textSize = size === "md" ? "text-xs" : "text-[10px]";
	return (
		<span
			title={`${intelligence.health} — ${intelligence.explanation}`}
			className={`inline-flex items-center gap-1 rounded ${padding} ${textSize} font-medium bg-background/50 border border-border ${style.text}`}
		>
			<span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
			{style.label}
		</span>
	);
}
