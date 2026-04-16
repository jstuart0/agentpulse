import { useNavigate } from "react-router-dom";
import { StatusBadge } from "./StatusBadge.js";
import { AgentTypeBadge } from "./AgentTypeBadge.js";
import { TokenCounter } from "./TokenCounter.js";
import { PlanTracker } from "./PlanTracker.js";
import { formatDuration, extractProjectName } from "../lib/utils.js";
import type { Session } from "../../shared/types.js";

interface SessionCardProps {
	session: Session;
}

export function SessionCard({ session }: SessionCardProps) {
	const navigate = useNavigate();
	const projectName = extractProjectName(session.cwd);
	const name = session.displayName || session.sessionId?.slice(0, 8) || "session";

	return (
		<div
			onClick={() => navigate(`/sessions/${session.sessionId}`)}
			className="group cursor-pointer rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5"
		>
			{/* Session name badge */}
			<div className="flex items-center justify-between gap-2 mb-2">
				<span className="inline-flex items-center gap-1.5 text-xs font-mono font-bold text-primary bg-primary/10 border border-primary/20 rounded px-2 py-0.5">
					{name}
				</span>
				<StatusBadge status={session.status} />
			</div>

			{/* Project */}
			<div className="mb-3">
				<h3 className="text-sm font-semibold truncate text-foreground group-hover:text-primary transition-colors">
					{projectName}
				</h3>
				<p className="text-xs text-muted-foreground truncate mt-0.5" title={session.cwd || ""}>
					{session.cwd}
				</p>
			</div>

			{/* Agent type + duration */}
			<div className="flex items-center gap-2 mb-3">
				<AgentTypeBadge agentType={session.agentType} />
				<span className="text-xs text-muted-foreground">
					{formatDuration(session.startedAt)}
				</span>
				<TokenCounter toolUses={session.totalToolUses} className="ml-auto" />
			</div>

			{/* Semantic status + current task */}
			{session.semanticStatus && (
				<div className="mb-2">
					<StatusBadge status={session.semanticStatus} variant="semantic" />
				</div>
			)}

			{session.currentTask && (
				<p className="text-xs text-foreground/80 truncate mb-2">{session.currentTask}</p>
			)}

			{/* Plan progress */}
			<PlanTracker plan={session.planSummary} className="mt-2" />
		</div>
	);
}
