import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge.js";
import { AgentTypeBadge } from "../components/AgentTypeBadge.js";
import { PlanTracker } from "../components/PlanTracker.js";
import { formatDuration, formatTimeAgo } from "../lib/utils.js";
import { api } from "../lib/api.js";
import { useEventStore } from "../stores/event-store.js";
import type { Session, SessionEvent } from "../../shared/types.js";

function extractPrompt(event: SessionEvent): string | null {
	if (event.eventType === "UserPromptSubmit") {
		const raw = event.rawPayload as Record<string, unknown>;
		if (typeof raw?.prompt === "string") return raw.prompt;
	}
	return null;
}

function PromptBubble({ text, time }: { text: string; time: string }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[80%]">
				<div className="rounded-2xl rounded-br-sm bg-primary/15 border border-primary/20 px-4 py-3">
					<p className="text-sm text-foreground whitespace-pre-wrap">{text}</p>
				</div>
				<p className="text-[10px] text-muted-foreground mt-1 text-right">
					{formatTimeAgo(time)}
				</p>
			</div>
		</div>
	);
}

function ToolEvent({ event }: { event: SessionEvent }) {
	const input = event.toolInput
		? typeof event.toolInput === "object"
			? JSON.stringify(event.toolInput).slice(0, 150)
			: String(event.toolInput).slice(0, 150)
		: null;

	return (
		<div className="flex items-start gap-2 px-2">
			<div className="flex-shrink-0 w-6 h-6 rounded-full bg-muted/50 flex items-center justify-center mt-0.5">
				<span className="text-[10px] font-medium text-muted-foreground">
					{event.toolName?.[0] || "E"}
				</span>
			</div>
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					{event.toolName && (
						<span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
							{event.toolName}
						</span>
					)}
					<span className="text-[10px] text-muted-foreground/60 ml-auto">
						{formatTimeAgo(event.createdAt)}
					</span>
				</div>
				{input && (
					<p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">
						{input}
					</p>
				)}
			</div>
		</div>
	);
}

export function SessionDetailPage() {
	const { sessionId } = useParams<{ sessionId: string }>();
	const navigate = useNavigate();
	const [session, setSession] = useState<Session | null>(null);
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const timelineEndRef = useRef<HTMLDivElement>(null);

	const liveEvents = useEventStore((s) => s.liveEvents.get(sessionId || "") || []);

	useEffect(() => {
		if (!sessionId) return;
		async function fetchData() {
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
		fetchData();
		const interval = setInterval(fetchData, 10_000);
		return () => clearInterval(interval);
	}, [sessionId]);

	useEffect(() => {
		timelineEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [events.length, liveEvents.length]);

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

	const displayName = session.displayName || session.sessionId.slice(0, 8);

	// Build chronological event list
	// Skip tool events (PreToolUse, PostToolUse) -- they're noise.
	// Show: prompts, session lifecycle, tasks, subagents, stops (as dividers)
	const skipEvents = new Set(["PreToolUse", "PostToolUse"]);
	const allEvents = [...events]
		.reverse()
		.filter((e) => !skipEvents.has(e.eventType));

	// Append live events not already in DB
	for (const le of liveEvents) {
		if (skipEvents.has(le.eventType)) continue;
		const alreadyExists = events.some(
			(e) =>
				e.eventType === le.eventType &&
				Math.abs(new Date(e.createdAt).getTime() - new Date(le.createdAt).getTime()) < 2000,
		);
		if (!alreadyExists) {
			allEvents.push({
				id: Date.now() + Math.random(),
				sessionId: le.sessionId,
				eventType: le.eventType,
				toolName: le.toolName,
				toolInput: le.toolInput,
				toolResponse: null,
				rawPayload: le.prompt ? { prompt: le.prompt } : {},
				createdAt: le.createdAt,
			} as SessionEvent);
		}
	}

	return (
		<div className="flex flex-col h-full">
			{/* Sticky session name bar */}
			<div className="sticky top-0 z-10 bg-background border-b border-border px-6 py-2.5 flex items-center gap-3 flex-shrink-0">
				<button
					onClick={() => navigate("/")}
					className="text-muted-foreground hover:text-foreground transition-colors"
				>
					<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
					</svg>
				</button>
				<span className="font-mono font-bold text-sm text-primary bg-primary/10 border border-primary/20 rounded px-2.5 py-1">
					{displayName}
				</span>
				<span className="text-xs text-muted-foreground truncate">
					{session.cwd?.split("/").pop()}
				</span>
				<span className="text-xs text-muted-foreground">
					{formatDuration(session.startedAt)}
				</span>
				<div className="ml-auto flex items-center gap-2">
					<span className="text-xs text-muted-foreground">{session.totalToolUses} tools</span>
					<AgentTypeBadge agentType={session.agentType} />
					<StatusBadge status={session.status} />
				</div>
			</div>

			{/* Scrollable content */}
			<div className="flex-1 overflow-auto">
				<div className="max-w-4xl p-6">
					{/* Session info card */}
					{(session.semanticStatus || session.currentTask || session.planSummary) && (
						<div className="border border-border bg-card rounded-lg p-4 mb-4">
							{session.semanticStatus && (
								<div className="flex items-center gap-2 mb-1">
									<StatusBadge status={session.semanticStatus} variant="semantic" />
									{session.currentTask && (
										<span className="text-xs text-foreground">{session.currentTask}</span>
									)}
								</div>
							)}
							<PlanTracker plan={session.planSummary} />
						</div>
					)}

					{/* Timeline */}
					<div className="space-y-3">
						{allEvents.length === 0 ? (
							<p className="text-sm text-muted-foreground text-center py-8">
								Waiting for events...
							</p>
						) : (
							allEvents.map((event) => {
								const prompt = extractPrompt(event);

								if (prompt) {
									return <PromptBubble key={event.id} text={prompt} time={event.createdAt} />;
								}

								if (event.eventType === "SessionStart" || event.eventType === "SessionEnd") {
									return (
										<div key={event.id} className="flex justify-center">
											<span className="text-[10px] text-muted-foreground/50 bg-muted/30 px-3 py-1 rounded-full">
												{event.eventType} -- {formatTimeAgo(event.createdAt)}
											</span>
										</div>
									);
								}

								if (event.eventType === "PostToolUse") {
									return <ToolEvent key={event.id} event={event} />;
								}

								if (event.eventType === "Stop") {
									return (
										<div key={event.id} className="flex justify-center py-1">
											<span className="text-[10px] text-muted-foreground/30">---</span>
										</div>
									);
								}

								if (event.eventType === "TaskCreated" || event.eventType === "TaskCompleted") {
									const raw = event.rawPayload as Record<string, unknown>;
									const subject = typeof raw?.task_subject === "string" ? raw.task_subject : "";
									return (
										<div key={event.id} className="flex justify-center">
											<span className="text-[10px] text-muted-foreground/50 bg-muted/30 px-3 py-1 rounded-full">
												{event.eventType === "TaskCreated" ? "Task:" : "Done:"} {subject || event.eventType}
											</span>
										</div>
									);
								}

								if (event.eventType === "SubagentStart" || event.eventType === "SubagentStop") {
									const raw = event.rawPayload as Record<string, unknown>;
									return (
										<div key={event.id} className="flex justify-center">
											<span className="text-[10px] text-muted-foreground/50 bg-indigo-500/10 text-indigo-400 px-3 py-1 rounded-full">
												{event.eventType === "SubagentStart" ? "Spawned" : "Finished"}{" "}
												{typeof raw?.agent_type === "string" ? raw.agent_type : "agent"}
											</span>
										</div>
									);
								}

								return <ToolEvent key={event.id} event={event} />;
							})
						)}
						<div ref={timelineEndRef} />
					</div>
				</div>
			</div>
		</div>
	);
}
