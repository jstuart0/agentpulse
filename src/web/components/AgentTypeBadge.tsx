import { AGENT_TYPE_LABELS } from "../../shared/constants.js";
import { cn } from "../lib/utils.js";

interface AgentTypeBadgeProps {
	agentType: string;
	className?: string;
}

export function AgentTypeBadge({ agentType, className }: AgentTypeBadgeProps) {
	const label = AGENT_TYPE_LABELS[agentType] || agentType;
	const isClaude = agentType === "claude_code";

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[10px] font-mono font-semibold tracking-wider uppercase border",
				isClaude
					? "bg-orange-500/8 text-orange-400/90 border-orange-500/15"
					: "bg-green-500/8 text-green-400/90 border-green-500/15",
				className,
			)}
		>
			<span
				className={cn(
					"w-1.5 h-1.5 rounded-full",
					isClaude ? "bg-orange-400/70" : "bg-green-400/70",
				)}
			/>
			{label}
		</span>
	);
}
