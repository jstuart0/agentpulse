import { cn } from "../lib/utils.js";
import { AGENT_TYPE_LABELS } from "../../shared/constants.js";

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
				"inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
				isClaude
					? "bg-orange-500/10 text-orange-400 border border-orange-500/20"
					: "bg-green-500/10 text-green-400 border border-green-500/20",
				className,
			)}
		>
			<span className="text-[10px]">{isClaude ? "C" : "X"}</span>
			{label}
		</span>
	);
}
