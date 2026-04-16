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
					<span className="text-xs text-muted-foreground">{event.eventType}</span>
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

function SystemEvent({ event }: { event: SessionEvent }) {
	return (
		<div className="flex justify-center">
			<span className="text-[10px] text-muted-foreground/50 bg-muted/30 px-3 py-1 rounded-full">
				{event.eventType} -- {formatTimeAgo(event.createdAt)}
			</span>
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

	// Live events from WebSocket
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
		// Refresh from API every 10 seconds to pick up events that arrived before WS connected
		const interval = setInterval(fetchData, 10_000);
		return () => clearInterval(interval);
	}, [sessionId]);

	// Auto-scroll to bottom when new events arrive
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
				<button
					onClick={() => navigate("/")}
					className="mt-2 text-primary hover:underline text-sm"
				>
					Back to dashboard
				</button>
			</div>
		);
	}

	// Merge DB events with live WS events, deduplicate by checking if a live event
	// is already in the DB events (by matching eventType + close timestamp)
	const dbEventIds = new Set(events.map((e) => e.id));
	const allEvents = [...events].reverse(); // Chronological order (oldest first)

	// Append any live events that aren't already in DB
	for (const le of liveEvents) {
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

	// Classify events
	const systemEvents = ["SessionStart", "SessionEnd"];
	const toolEvents = ["PreToolUse", "PostToolUse"];

	return (
		<div className="p-6 h-full flex flex-col max-w-4xl">
			{/* Back button */}
			<button
				onClick={() => navigate("/")}
				className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors"
			>
				<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M15 19l-7-7 7-7"
					/>
				</svg>
				Back
			</button>

			{/* Session header */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4 flex-shrink-0">
				<div className="flex items-start justify-between mb-3">
					<div>
						<h1 className="text-lg font-bold text-foreground">
							{session.cwd?.split("/").pop() || "Session"}
						</h1>
						<p className="text-xs text-muted-foreground">{session.cwd}</p>
					</div>
					<div className="flex items-center gap-2">
						<AgentTypeBadge agentType={session.agentType} />
						<StatusBadge status={session.status} />
					</div>
				</div>

				<div className="grid grid-cols-4 gap-3 text-sm">
					<div>
						<p className="text-muted-foreground text-xs">Duration</p>
						<p className="font-medium text-sm">{formatDuration(session.startedAt)}</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">Tool Uses</p>
						<p className="font-medium text-sm">{session.totalToolUses}</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">Model</p>
						<p className="font-medium text-sm">{session.model || "Unknown"}</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">Last Activity</p>
						<p className="font-medium text-sm">{formatTimeAgo(session.lastActivityAt)}</p>
					</div>
				</div>

				{session.semanticStatus && (
					<div className="mt-3 pt-3 border-t border-border">
						<div className="flex items-center gap-2 mb-1">
							<StatusBadge status={session.semanticStatus} variant="semantic" />
							{session.currentTask && (
								<span className="text-xs text-foreground">{session.currentTask}</span>
							)}
						</div>
						<PlanTracker plan={session.planSummary} />
					</div>
				)}
			</div>

			{/* Timeline - chat style */}
			<div className="flex-1 min-h-0 overflow-auto border border-border bg-card/50 rounded-lg">
				<div className="p-4 space-y-3">
					{allEvents.length === 0 ? (
						<p className="text-sm text-muted-foreground text-center py-8">
							Waiting for events...
						</p>
					) : (
						allEvents.map((event, i) => {
							const prompt = extractPrompt(event);

							if (prompt) {
								return <PromptBubble key={event.id} text={prompt} time={event.createdAt} />;
							}

							if (systemEvents.includes(event.eventType)) {
								return <SystemEvent key={event.id} event={event} />;
							}

							// Collapse consecutive PreToolUse/PostToolUse for same tool into one line
							if (event.eventType === "PreToolUse") {
								// Skip PreToolUse if the next event is PostToolUse for the same tool
								const next = allEvents[i + 1];
								if (
									next?.eventType === "PostToolUse" &&
									next?.toolName === event.toolName
								) {
									return null; // PostToolUse will render instead
								}
							}

							if (
								event.eventType === "PostToolUse" ||
								event.eventType === "PreToolUse"
							) {
								return <ToolEvent key={event.id} event={event} />;
							}

							// Stop, SubagentStart/Stop, TaskCreated/Completed
							if (event.eventType === "Stop") {
								return (
									<div key={event.id} className="flex justify-center">
										<span className="text-[10px] text-muted-foreground/40 px-2">
											---
										</span>
									</div>
								);
							}

							if (
								event.eventType === "TaskCreated" ||
								event.eventType === "TaskCompleted"
							) {
								const raw = event.rawPayload as Record<string, unknown>;
								const subject =
									typeof raw?.task_subject === "string" ? raw.task_subject : "";
								return (
									<div key={event.id} className="flex justify-center">
										<span className="text-[10px] text-muted-foreground/50 bg-muted/30 px-3 py-1 rounded-full">
											{event.eventType === "TaskCreated" ? "Task:" : "Done:"}{" "}
											{subject || event.eventType}
										</span>
									</div>
								);
							}

							// Subagent events
							if (
								event.eventType === "SubagentStart" ||
								event.eventType === "SubagentStop"
							) {
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

							// Fallback
							return <ToolEvent key={event.id} event={event} />;
						})
					)}
					<div ref={timelineEndRef} />
				</div>
			</div>
		</div>
	);
}
