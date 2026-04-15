import { cn } from "../lib/utils.js";
import { STATUS_COLORS, SEMANTIC_STATUS_COLORS } from "../../shared/constants.js";

interface StatusBadgeProps {
	status: string;
	variant?: "session" | "semantic";
	className?: string;
}

export function StatusBadge({ status, variant = "session", className }: StatusBadgeProps) {
	const colors = variant === "semantic" ? SEMANTIC_STATUS_COLORS : STATUS_COLORS;
	const color = colors[status] || "bg-slate-500";
	const isActive = status === "active";

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium text-white",
				color,
				className,
			)}
		>
			{isActive && (
				<span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse-dot" />
			)}
			{status}
		</span>
	);
}
