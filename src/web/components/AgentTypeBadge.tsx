import { AGENT_METADATA } from "../../shared/constants.js";
import type { AgentType } from "../../shared/types.js";
import { cn } from "../lib/utils.js";

// Fallback for historic data carrying an agent type we no longer ship —
// AGENT_METADATA has no entry for it, so the badge renders neutral rather
// than guessing at a color.
const NEUTRAL_BADGE_CLASS = "bg-zinc-500/8 text-zinc-400/90 border-zinc-500/15";
const NEUTRAL_DOT_CLASS = "bg-zinc-400/70";

interface AgentTypeBadgeProps {
	// `string` (not `AgentType`) is intentional — historic data may carry
	// agent types we no longer ship, and we still want to render them
	// gracefully. The label lookup falls back to the raw value below.
	agentType: string;
	className?: string;
}

export function AgentTypeBadge({ agentType, className }: AgentTypeBadgeProps) {
	const meta = AGENT_METADATA[agentType as AgentType] as
		| (typeof AGENT_METADATA)[AgentType]
		| undefined;
	const label = meta?.label ?? agentType;

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[10px] font-mono font-semibold tracking-wider uppercase border",
				meta?.badgeClass ?? NEUTRAL_BADGE_CLASS,
				className,
			)}
		>
			<span className={cn("w-1.5 h-1.5 rounded-full", meta?.dotClass ?? NEUTRAL_DOT_CLASS)} />
			{label}
		</span>
	);
}
