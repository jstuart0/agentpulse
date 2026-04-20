import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge.js";
import { AgentTypeBadge } from "../components/AgentTypeBadge.js";
import { formatDuration } from "../lib/utils.js";
import { api } from "../lib/api.js";
import type { ControlAction, EventCategory, LaunchRequest, Session, SessionEvent } from "../../shared/types.js";
import { useEventStore } from "../stores/event-store.js";
import { useTabsStore } from "../stores/tabs-store.js";
import { NotesPanel, ClaudeMdPanel, EmbeddedLaunchPanel, SummaryField } from "../components/session-detail/Panels.js";
import { ScrollJumpControls, ModeButton, FilterToggle, WorkspaceTabButton } from "../components/session-detail/SharedControls.js";
import { SessionPromptComposer } from "../components/session-detail/SessionPromptComposer.js";
import {
	PromptBubble,
	AssistantBubble,
	TimelineCard,
	type TimelineMode,
	eventLabel,
	getVisibleEvents,
	eventKey,
	mergeSessionEvents,
} from "../components/session-detail/TimelineView.js";
import { CodexStatusHint, ManagedCodexStatus, ManagedClaudeStatus } from "../components/session-detail/StatusHints.js";

type WorkspaceTab = "overview" | "activity" | "notes" | "instructions" | "launch";

function buildExportMarkdown(displayName: string, session: Session, allEvents: SessionEvent[]) {
	const transcript = allEvents
		.map((event) => {
			if (event.category === "prompt" && event.content) {
				return `## Prompt\n\n${event.content}`;
			}
			if (event.category === "assistant_message" && event.content) {
				return `## Response\n\n${event.content}`;
			}
			if (
				(event.category === "progress_update" ||
					event.category === "plan_update" ||
					event.category === "status_update") &&
				event.content
			) {
				return `## Progress\n\n${event.content}`;
			}
			return null;
		})
		.filter(Boolean)
		.join("\n\n");

	return `# ${displayName}

**Project:** ${session.cwd}
**Agent:** ${session.agentType}
**Started:** ${session.startedAt}
**Tools:** ${session.totalToolUses}
${session.gitBranch ? `**Branch:** ${session.gitBranch}\n` : ""}${session.notes ? `## Notes

${session.notes}

` : ""}${transcript ? `## Timeline

${transcript}
` : ""}`;
}

function InlineRename({ sessionId, currentName, onRenamed }: { sessionId: string; currentName: string; onRenamed: (name: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(currentName);

	async function save() {
		if (!value.trim()) { setEditing(false); return; }
		await api.renameSession(sessionId, value.trim());
		onRenamed(value.trim());
		setEditing(false);
	}

	if (editing) {
		return (
			<input
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
				className="font-mono font-bold text-sm bg-background border border-primary/30 rounded px-2.5 py-1 w-40 focus:outline-none focus:ring-1 focus:ring-primary"
			/>
		);
	}

	return (
		<span
			onClick={() => { setEditing(true); setValue(currentName); }}
			title="Click to rename"
			className="font-mono font-bold text-sm text-primary bg-primary/10 border border-primary/20 rounded px-2.5 py-1 cursor-pointer hover:bg-primary/20 transition-colors"
		>
			{currentName}
		</span>
	);
}

export function SessionDetailPage() {
	const { sessionId } = useParams<{ sessionId: string }>();
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const [session, setSession] = useState<Session | null>(null);
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [controlActions, setControlActions] = useState<ControlAction[]>([]);
	const [loading, setLoading] = useState(true);
	const [mode, setMode] = useState<TimelineMode>("progress");
	const [showTools, setShowTools] = useState(false);
	const [showNoisyTools, setShowNoisyTools] = useState(false);
	const [showSystem, setShowSystem] = useState(true);
	const requestedTab = searchParams.get("tab") as WorkspaceTab | null;
	const initialWorkspaceTab: WorkspaceTab =
		requestedTab && ["overview", "activity", "notes", "instructions", "launch"].includes(requestedTab)
			? requestedTab
			: "activity";
	const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(initialWorkspaceTab);
	const timelineContainerRef = useRef<HTMLDivElement>(null);
	const timelineEndRef = useRef<HTMLDivElement>(null);
	const shouldFollowTimelineRef = useRef(true);
	const previousEventCountRef = useRef(0);
	const liveEventsMap = useEventStore((s) => s.liveEvents);
	const clearLiveEvents = useEventStore((s) => s.clearSession);

	const loadSessionWorkspace = useCallback(async () => {
		if (!sessionId) return;
		try {
			const data = await api.getSession(sessionId);
			setSession(data.session as Session);
			setEvents(data.events as SessionEvent[]);
			setControlActions((data.controlActions as ControlAction[]) || []);
		} catch (err) {
			console.error("Failed to fetch session:", err);
		} finally {
			setLoading(false);
		}
	}, [sessionId]);

	// Removed live event merging -- just use DB events with fast polling

	useEffect(() => {
		if (!sessionId) return;
		loadSessionWorkspace();
		const interval = setInterval(loadSessionWorkspace, 10_000);
		return () => {
			clearInterval(interval);
			clearLiveEvents(sessionId);
		};
	}, [sessionId, clearLiveEvents, loadSessionWorkspace]);

	const openTab = useTabsStore((s) => s.open);
	useEffect(() => {
		if (!session) return;
		openTab({
			sessionId: session.sessionId,
			displayName: session.displayName ?? session.sessionId.slice(0, 8),
			agentType: session.agentType,
			managedState: session.managedSession?.managedState ?? null,
		});
	}, [session, openTab]);

	const liveEvents = ((sessionId && liveEventsMap.get(sessionId)) || []) as SessionEvent[];
	const allEvents = mergeSessionEvents([...events].reverse(), liveEvents);
	const visibleEvents = getVisibleEvents(allEvents, mode, showTools || mode === "debug", showNoisyTools, showSystem);

	useEffect(() => {
		const requested = searchParams.get("tab");
		if (requested && ["overview", "activity", "notes", "instructions", "launch"].includes(requested)) {
			setWorkspaceTab(requested as WorkspaceTab);
		}
	}, [searchParams]);

	useEffect(() => {
		const hasNewEvents = allEvents.length > previousEventCountRef.current;
		const behavior = previousEventCountRef.current === 0 ? "auto" : "smooth";

		if (hasNewEvents && shouldFollowTimelineRef.current) {
			timelineEndRef.current?.scrollIntoView({ behavior });
		}

		previousEventCountRef.current = allEvents.length;
	}, [allEvents.length]);

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
	const canStop = session.agentType === "codex_cli" && session.managedSession?.managedState === "managed";

	async function handleStop() {
		if (!sessionId) return;
		try {
			await api.stopSession(sessionId);
			await loadSessionWorkspace();
		} catch (error) {
			console.error("Failed to stop session:", error);
		}
	}

	function handleTimelineScroll() {
		const container = timelineContainerRef.current;
		if (!container) return;

		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		shouldFollowTimelineRef.current = distanceFromBottom < 96;
	}

	function jumpTimelineTop() {
		timelineContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
		shouldFollowTimelineRef.current = false;
	}

	function jumpTimelineBottom() {
		timelineContainerRef.current?.scrollTo({
			top: timelineContainerRef.current.scrollHeight,
			behavior: "smooth",
		});
		shouldFollowTimelineRef.current = true;
	}

	function selectWorkspaceTab(tab: WorkspaceTab) {
		setWorkspaceTab(tab);
		const next = new URLSearchParams(searchParams);
		next.set("tab", tab);
		setSearchParams(next, { replace: true });
	}

	return (
		<div className="flex flex-col h-full">
			{/* Sticky session name bar */}
			<div className="sticky top-0 z-10 bg-background border-b border-border flex-shrink-0">
				<div className="px-3 md:px-6 py-2.5 flex flex-wrap items-center gap-2 md:gap-3">
					<button
						onClick={() => navigate("/")}
						className="text-muted-foreground hover:text-foreground transition-colors"
					>
						<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
						</svg>
					</button>
					<InlineRename
						sessionId={session.sessionId}
						currentName={displayName}
						onRenamed={(name) => setSession({ ...session, displayName: name })}
					/>
					{session.isWorking && (
						<span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
							<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
							working
						</span>
					)}
					<span className="text-xs text-muted-foreground truncate">
						{session.cwd?.split("/").pop()}
					</span>
					<span className="text-xs text-muted-foreground">
						{formatDuration(session.startedAt)}
					</span>
					{session.gitBranch && (
						<span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">
							{session.gitBranch}
						</span>
					)}
					<div className="flex items-center gap-2 md:ml-auto">
						<ScrollJumpControls onTop={jumpTimelineTop} onBottom={jumpTimelineBottom} />
						{session.managedSession?.launchRequestId && (
							<button
								onClick={() => navigate(`/launches/${session.managedSession?.launchRequestId}`)}
								className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent transition-colors"
							>
								View launch
							</button>
						)}
						{canStop && (
							<button
								onClick={handleStop}
								className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/20 transition-colors"
							>
								Stop
							</button>
						)}
						<button
							onClick={(e) => {
								e.stopPropagation();
								navigator.clipboard.writeText(buildExportMarkdown(displayName, session, allEvents));
							}}
							title="Export as Markdown"
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
						>
							<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
							</svg>
						</button>
						<span className="text-xs text-muted-foreground">{session.totalToolUses} tools</span>
						<AgentTypeBadge agentType={session.agentType} />
						<StatusBadge status={session.status} />
					</div>
				</div>
				<div className="px-3 md:px-6 py-2 border-t border-border/70 flex flex-col items-start gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-3">
					<div className="flex flex-wrap items-center gap-2">
						<WorkspaceTabButton
							active={workspaceTab === "overview"}
							label="Overview"
							onClick={() => selectWorkspaceTab("overview")}
						/>
						<WorkspaceTabButton
							active={workspaceTab === "activity"}
							label="Activity"
							badge={session.isWorking ? "Working" : null}
							onClick={() => selectWorkspaceTab("activity")}
						/>
						<WorkspaceTabButton
							active={workspaceTab === "notes"}
							label="Notes"
							onClick={() => selectWorkspaceTab("notes")}
						/>
						<WorkspaceTabButton
							active={workspaceTab === "instructions"}
							label={session.agentType === "codex_cli" ? "AGENTS.md" : "CLAUDE.md"}
							onClick={() => selectWorkspaceTab("instructions")}
						/>
						{session.managedSession?.launchRequestId && (
							<WorkspaceTabButton
								active={workspaceTab === "launch"}
								label="Launch"
								onClick={() => selectWorkspaceTab("launch")}
							/>
						)}
					</div>
					{workspaceTab === "activity" && (
						<div className="flex flex-wrap items-center gap-2">
							<ModeButton active={mode === "prompts"} label="Prompts" onClick={() => setMode("prompts")} />
							<ModeButton active={mode === "conversation"} label="Conversation" onClick={() => setMode("conversation")} />
							<ModeButton active={mode === "progress"} label="Progress" onClick={() => setMode("progress")} />
							<ModeButton active={mode === "debug"} label="Debug" onClick={() => setMode("debug")} />
							<FilterToggle
								active={showSystem}
								label="System"
								onClick={() => setShowSystem((value) => !value)}
								disabled={mode === "prompts" || mode === "conversation"}
							/>
							<FilterToggle
								active={showTools || mode === "debug"}
								label="Tools"
								onClick={() => setShowTools((value) => !value)}
							/>
							<FilterToggle
								active={showNoisyTools}
								label="Noisy"
								onClick={() => setShowNoisyTools((value) => !value)}
								disabled={!(showTools || mode === "debug")}
							/>
						</div>
					)}
				</div>
			</div>

			{session.agentType === "codex_cli" && session.managedSession ? (
				<ManagedCodexStatus managedSession={session.managedSession} />
			) : session.agentType === "claude_code" && session.managedSession ? (
				<ManagedClaudeStatus managedSession={session.managedSession} />
			) : session.agentType === "codex_cli" ? (
				<CodexStatusHint displayName={displayName} />
			) : null}

			{controlActions.length > 0 && (
				<div className="mx-6 mt-3 rounded-lg border border-border bg-card px-3 py-2.5">
					<div className="text-xs font-medium text-foreground">Control History</div>
					<div className="mt-2 space-y-1.5">
						{controlActions.slice(-5).reverse().map((action) => (
							<div key={action.id} className="flex items-center justify-between gap-3 text-[11px]">
								<span className="text-muted-foreground">
									{action.actionType}
									{action.error ? `: ${action.error}` : ""}
								</span>
								<span className="font-mono text-foreground">{action.status}</span>
							</div>
						))}
					</div>
				</div>
			)}

			<div className="flex-1 min-h-0">
				{workspaceTab === "overview" ? (
					<div className="grid gap-4 p-3 md:p-6 md:grid-cols-2 xl:grid-cols-4">
						<SummaryField label="Project" value={session.cwd} mono />
						<SummaryField label="Agent" value={session.agentType} />
						<SummaryField label="Started" value={session.startedAt} />
						<SummaryField label="Status" value={session.status} />
						<SummaryField label="Model" value={session.model} />
						<SummaryField label="Branch" value={session.gitBranch} mono />
						<SummaryField label="Current task" value={session.currentTask} />
						<SummaryField label="Tools" value={String(session.totalToolUses)} />
						{session.managedSession?.hostName ? (
							<SummaryField label="Host" value={session.managedSession.hostName} mono />
						) : null}
						{session.managedSession?.launchRequestId ? (
							<SummaryField label="Launch request" value={session.managedSession.launchRequestId} mono />
						) : null}
					</div>
				) : workspaceTab === "activity" ? (
					<div
						ref={timelineContainerRef}
						onScroll={handleTimelineScroll}
						className="h-full overflow-auto p-3 md:p-6"
					>
						<div className="space-y-3">
							{visibleEvents.length === 0 ? (
								<p className="text-sm text-muted-foreground text-center py-8">
									No events match this view yet.
								</p>
							) : (
								visibleEvents.map((event) => {
									if (event.category === "prompt" && event.content) {
										return (
											<PromptBubble
												key={eventKey(event)}
												text={event.content}
												time={event.createdAt}
												source={mode === "debug" ? event.source : undefined}
											/>
										);
									}
									if (event.category === "assistant_message" && event.content) {
										return (
											<AssistantBubble
												key={eventKey(event)}
												text={event.content}
												time={event.createdAt}
												source={mode === "debug" ? event.source : undefined}
											/>
										);
									}
									if (event.category === "tool_event") {
										const detail = event.content || event.toolName || event.eventType;
										return (
											<TimelineCard
												key={eventKey(event)}
												label={eventLabel(event.category)}
												text={detail}
												time={event.createdAt}
												tone={event.isNoise ? "muted" : "amber"}
												source={mode === "debug" ? event.source : undefined}
											/>
										);
									}
									if (!event.content) return null;
									return (
										<TimelineCard
											key={eventKey(event)}
											label={eventLabel(event.category)}
											text={event.content}
											time={event.createdAt}
											tone={event.category === "status_update" ? "emerald" : "default"}
											source={mode === "debug" ? event.source : undefined}
										/>
									);
								})
							)}
							<div ref={timelineEndRef} />
						</div>
					</div>
				) : workspaceTab === "notes" ? (
					<NotesPanel sessionId={session.sessionId} initialNotes={session.notes || ""} />
				) : workspaceTab === "instructions" ? (
					<ClaudeMdPanel session={session} />
				) : session.managedSession?.launchRequestId ? (
					<EmbeddedLaunchPanel launchId={session.managedSession.launchRequestId} />
				) : (
					<div className="p-6 text-sm text-muted-foreground">No linked launch for this session.</div>
				)}
			</div>
			{session.agentType === "claude_code" && session.managedSession ? (
				<SessionPromptComposer session={session} onSubmitted={loadSessionWorkspace} />
			) : null}
		</div>
	);
}
