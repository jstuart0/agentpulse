import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge.js";
import { AgentTypeBadge } from "../components/AgentTypeBadge.js";
import { PlanTracker } from "../components/PlanTracker.js";
import { formatDuration, formatTimeAgo } from "../lib/utils.js";
import { api } from "../lib/api.js";
import type { Session, SessionEvent } from "../../shared/types.js";

export function SessionDetailPage() {
	const { sessionId } = useParams<{ sessionId: string }>();
	const navigate = useNavigate();
	const [session, setSession] = useState<Session | null>(null);
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!sessionId) return;

		async function fetch() {
			try {
				const data = await api.getSession(sessionId!);
				setSession(data.session as Session);
				setEvents(data.events as SessionEvent[]);
			} catch (err) {
				console.error("Failed to fetch session:", err);
			} finally {
				setLoading(false);
			}
		}

		fetch();
		const interval = setInterval(fetch, 5_000);
		return () => clearInterval(interval);
	}, [sessionId]);

	if (loading) {
		return (
			<div className="p-6">
				<div className="animate-pulse space-y-4">
					<div className="h-8 bg-muted rounded w-1/3" />
					<div className="h-4 bg-muted rounded w-1/2" />
					<div className="h-64 bg-muted rounded" />
				</div>
			</div>
		);
	}

	if (!session) {
		return (
			<div className="p-6 text-center text-muted-foreground">
				<p>Session not found</p>
				<button onClick={() => navigate("/")} className="mt-2 text-primary hover:underline text-sm">
					Back to dashboard
				</button>
			</div>
		);
	}

	return (
		<div className="p-6 max-w-5xl">
			{/* Back button */}
			<button
				onClick={() => navigate("/")}
				className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors"
			>
				<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
				</svg>
				Back
			</button>

			{/* Session header */}
			<div className="border border-border bg-card rounded-lg p-6 mb-6">
				<div className="flex items-start justify-between mb-4">
					<div>
						<h1 className="text-xl font-bold text-foreground mb-1">
							{session.cwd?.split("/").pop() || "Session"}
						</h1>
						<p className="text-sm text-muted-foreground">{session.cwd}</p>
					</div>
					<div className="flex items-center gap-2">
						<AgentTypeBadge agentType={session.agentType} />
						<StatusBadge status={session.status} />
					</div>
				</div>

				<div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
					<div>
						<p className="text-muted-foreground text-xs">Duration</p>
						<p className="font-medium">{formatDuration(session.startedAt)}</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">Tool Uses</p>
						<p className="font-medium">{session.totalToolUses}</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">Model</p>
						<p className="font-medium">{session.model || "Unknown"}</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">Last Activity</p>
						<p className="font-medium">{formatTimeAgo(session.lastActivityAt)}</p>
					</div>
				</div>

				{/* Semantic status */}
				{session.semanticStatus && (
					<div className="mt-4 pt-4 border-t border-border">
						<div className="flex items-center gap-2 mb-2">
							<StatusBadge status={session.semanticStatus} variant="semantic" />
							{session.currentTask && (
								<span className="text-sm text-foreground">{session.currentTask}</span>
							)}
						</div>
						<PlanTracker plan={session.planSummary} />
					</div>
				)}
			</div>

			{/* Event Timeline */}
			<h2 className="text-lg font-semibold mb-3">Event Timeline</h2>
			<div className="space-y-2">
				{events.length === 0 ? (
					<p className="text-sm text-muted-foreground py-4">No events recorded yet</p>
				) : (
					events.map((event) => (
						<div
							key={event.id}
							className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
						>
							{/* Event icon */}
							<div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
								<span className="text-xs font-medium text-muted-foreground">
									{event.eventType === "PostToolUse" || event.eventType === "PreToolUse"
										? "T"
										: event.eventType === "SessionStart"
											? "S"
											: event.eventType === "Stop"
												? "X"
												: "E"}
								</span>
							</div>

							{/* Event details */}
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium text-foreground">
										{event.eventType}
									</span>
									{event.toolName && (
										<span className="text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
											{event.toolName}
										</span>
									)}
									<span className="text-xs text-muted-foreground ml-auto flex-shrink-0">
										{formatTimeAgo(event.createdAt)}
									</span>
								</div>
								{event.toolInput && (
									<p className="text-xs text-muted-foreground mt-1 truncate">
										{JSON.stringify(event.toolInput).slice(0, 120)}
									</p>
								)}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}
