import { useNavigate } from "react-router-dom";
import { StatusBadge } from "./StatusBadge.js";
import { AgentTypeBadge } from "./AgentTypeBadge.js";
import { TokenCounter } from "./TokenCounter.js";
import { PlanTracker } from "./PlanTracker.js";
import { formatDuration, extractProjectName } from "../lib/utils.js";
import { useSessionStore } from "../stores/session-store.js";
import type { Session } from "../../shared/types.js";

interface SessionCardProps {
	session: Session;
}

export function SessionCard({ session }: SessionCardProps) {
	const navigate = useNavigate();
	const removeSession = useSessionStore((s) => s.removeSession);
	const updateSession = useSessionStore((s) => s.updateSession);
	const projectName = extractProjectName(session.cwd);
	const name = session.displayName || session.sessionId?.slice(0, 8) || "session";
	const isInactive = session.status === "completed" || session.status === "archived" || session.status === "failed";

	async function handleArchive(e: React.MouseEvent) {
		e.stopPropagation();
		await fetch(`/api/v1/sessions/${session.sessionId}/archive`, { method: "PUT" });
		updateSession({ ...session, status: "archived" });
	}

	async function handleDelete(e: React.MouseEvent) {
		e.stopPropagation();
		if (!confirm(`Delete session "${name}"? This removes all events and cannot be undone.`)) return;
		await fetch(`/api/v1/sessions/${session.sessionId}`, { method: "DELETE" });
		removeSession(session.sessionId);
	}

	return (
		<div
			onClick={() => navigate(`/sessions/${session.sessionId}`)}
			className="group cursor-pointer rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5"
		>
			{/* Session name badge + actions */}
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2">
					<span className="inline-flex items-center gap-1.5 text-xs font-mono font-bold text-primary bg-primary/10 border border-primary/20 rounded px-2 py-0.5">
						{name}
					</span>
					{session.isWorking && (
						<span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
							<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
							working
						</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					{/* Archive/Delete buttons - show on hover for inactive sessions */}
					{isInactive && (
						<div className="hidden group-hover:flex items-center gap-1 mr-1">
							{session.status !== "archived" && (
								<button
									onClick={handleArchive}
									title="Archive"
									className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
								>
									<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
									</svg>
								</button>
							)}
							<button
								onClick={handleDelete}
								title="Delete"
								className="rounded p-1 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
							>
								<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
								</svg>
							</button>
						</div>
					)}
					<StatusBadge status={session.status} />
				</div>
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
