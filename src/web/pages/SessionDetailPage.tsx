import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ControlAction, Session, SessionEvent } from "../../shared/types.js";
import { ActivityTimeline } from "../components/session-detail/ActivityTimeline.js";
import { AiPanel } from "../components/session-detail/AiPanel.js";
import { ControlHistory } from "../components/session-detail/ControlHistory.js";
import {
	ClaudeMdPanel,
	EmbeddedLaunchPanel,
	NotesPanel,
	SummaryField,
} from "../components/session-detail/Panels.js";
import {
	SessionHeader,
	WORKSPACE_TABS,
	type WorkspaceTab,
} from "../components/session-detail/SessionHeader.js";
import { SessionPromptComposer } from "../components/session-detail/SessionPromptComposer.js";
import {
	CodexStatusHint,
	ManagedClaudeStatus,
	ManagedCodexStatus,
} from "../components/session-detail/StatusHints.js";
import {
	type TimelineMode,
	getVisibleEvents,
	mergeSessionEvents,
} from "../components/session-detail/TimelineView.js";
import { api } from "../lib/api.js";
import { useEventStore } from "../stores/event-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useTabsStore } from "../stores/tabs-store.js";

/** Merge new events into the existing persisted events array, de-duped by id, sorted asc. */
function insertEvents(existing: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
	const byId = new Map<number, SessionEvent>();
	for (const e of existing) byId.set(e.id, e);
	for (const e of incoming) byId.set(e.id, e);
	return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Session detail page — after WS5 decomposition this file is pure
 * orchestration: data loading, polling, scroll coordination, and
 * passing props to extracted subcomponents (SessionHeader,
 * ActivityTimeline, NotesPanel, ClaudeMdPanel, AiPanel, etc.).
 */
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
		requestedTab && WORKSPACE_TABS.includes(requestedTab) ? requestedTab : "activity";
	const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(initialWorkspaceTab);

	const [loadingContext, setLoadingContext] = useState(false);
	const [contextNotFound, setContextNotFound] = useState(false);

	const timelineContainerRef = useRef<HTMLDivElement>(null);
	const timelineEndRef = useRef<HTMLDivElement>(null);
	const shouldFollowTimelineRef = useRef(true);
	const previousEventCountRef = useRef(0);
	const liveEventsMap = useEventStore((s) => s.liveEvents);
	const clearLiveEvents = useEventStore((s) => s.clearSession);

	// Tracks which (sessionId, eventId) combo has already been flashed so that
	// incoming WebSocket events don't re-trigger the scroll/flash.
	const flashedRef = useRef<{ sessionId: string | null; eventId: string | null }>({
		sessionId: null,
		eventId: null,
	});

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

	// Warm the header from the cached dashboard list so switching tabs feels instant.
	useEffect(() => {
		if (!sessionId) return;
		const cached = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
		setSession(cached ?? null);
		setEvents([]);
		setControlActions([]);
		setLoading(!cached);
	}, [sessionId]);

	useEffect(() => {
		if (!sessionId) return;
		loadSessionWorkspace();
		const interval = setInterval(loadSessionWorkspace, 10_000);
		return () => {
			clearInterval(interval);
			clearLiveEvents(sessionId);
		};
	}, [sessionId, clearLiveEvents, loadSessionWorkspace]);

	// Reset the flash guard whenever we navigate to a different session so that
	// back-and-forth navigation re-runs the scroll/flash for each destination.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger, not a value read inside the callback
	useEffect(() => {
		flashedRef.current = { sessionId: null, eventId: null };
	}, [sessionId]);

	// Read the URL hash and scroll-and-flash the matching event once it appears
	// in the DOM. Depends on both sessionId and events.length:
	// - sessionId: re-arms on navigation
	// - events.length: retries when the event list grows (async load / WS events)
	// The ref guard ensures exactly one flash per (sessionId, eventId) pair.
	useEffect(() => {
		if (workspaceTab !== "activity") return;
		if (!session) return;
		const hash = window.location.hash;
		const m = hash.match(/^#event-(\d+)$/);
		if (!m) return;
		const eventId = m[1];
		if (flashedRef.current.sessionId === sessionId && flashedRef.current.eventId === eventId) {
			return;
		}
		const el = document.getElementById(`event-${eventId}`);
		if (el) {
			flashedRef.current = { sessionId: sessionId ?? null, eventId };
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			el.classList.add("event-flash");
			const t = setTimeout(() => el.classList.remove("event-flash"), 2200);
			return () => clearTimeout(t);
		}
		// Element not in DOM yet. If the events list has loaded (length > 0) and
		// we still can't find it, the event is outside the loaded window — fetch
		// the context window from the server and splice it in.
		if (events.length === 0) return;
		if (loadingContext) return;
		setLoadingContext(true);
		setContextNotFound(false);
		api
			.getEventContext(sessionId ?? "", Number(eventId))
			.then((res) => {
				setEvents((prev) => insertEvents(prev, res.events as SessionEvent[]));
			})
			.catch(() => {
				flashedRef.current = { sessionId: sessionId ?? null, eventId };
				setContextNotFound(true);
			})
			.finally(() => {
				setLoadingContext(false);
			});
		// Why both deps: events.length re-triggers after context splice so the
		// flash runs once the DOM has the newly inserted event.
	}, [workspaceTab, sessionId, session, events.length, loadingContext]);

	const openTab = useTabsStore((s) => s.open);
	useEffect(() => {
		if (!session) return;
		openTab({
			sessionId: session.sessionId,
			displayName: session.displayName ?? session.sessionId.slice(0, 8),
			agentType: session.agentType,
			managedState: session.managedSession?.managedState ?? null,
			cwd: session.cwd ?? null,
		});
	}, [session, openTab]);

	const liveEvents = ((sessionId && liveEventsMap.get(sessionId)) || []) as SessionEvent[];
	const allEvents = mergeSessionEvents([...events].reverse(), liveEvents);
	const visibleEvents = getVisibleEvents(
		allEvents,
		mode,
		showTools || mode === "debug" || mode === "terminal",
		showNoisyTools,
		showSystem,
	);

	useEffect(() => {
		const requested = searchParams.get("tab") as WorkspaceTab | null;
		if (requested && WORKSPACE_TABS.includes(requested)) {
			setWorkspaceTab(requested);
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
				<button
					type="button"
					onClick={() => navigate("/")}
					className="mt-2 text-primary hover:underline text-sm"
				>
					Back to dashboard
				</button>
			</div>
		);
	}

	const displayName = session.displayName || session.sessionId.slice(0, 8);

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
			<SessionHeader
				session={session}
				displayName={displayName}
				allEvents={allEvents}
				workspaceTab={workspaceTab}
				onSelectTab={selectWorkspaceTab}
				mode={mode}
				onModeChange={setMode}
				showTools={showTools}
				onToggleTools={() => setShowTools((v) => !v)}
				showNoisyTools={showNoisyTools}
				onToggleNoisyTools={() => setShowNoisyTools((v) => !v)}
				showSystem={showSystem}
				onToggleSystem={() => setShowSystem((v) => !v)}
				onJumpTop={jumpTimelineTop}
				onJumpBottom={jumpTimelineBottom}
				onRename={(name) => setSession({ ...session, displayName: name })}
				onStop={handleStop}
			/>

			{session.agentType === "codex_cli" && session.managedSession ? (
				<ManagedCodexStatus managedSession={session.managedSession} />
			) : session.agentType === "claude_code" && session.managedSession ? (
				<ManagedClaudeStatus managedSession={session.managedSession} />
			) : session.agentType === "codex_cli" ? (
				<CodexStatusHint displayName={displayName} />
			) : null}

			<ControlHistory actions={controlActions} />

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
							<SummaryField
								label="Launch request"
								value={session.managedSession.launchRequestId}
								mono
							/>
						) : null}
					</div>
				) : workspaceTab === "activity" ? (
					<>
						{contextNotFound ? (
							<div className="px-4 pt-2">
								<p className="text-xs text-amber-500/80 text-center">
									The linked event could not be found — it may have been deleted.
								</p>
							</div>
						) : null}
						<ActivityTimeline
							ref={timelineContainerRef}
							endRef={timelineEndRef}
							visibleEvents={visibleEvents}
							mode={mode}
							onScroll={handleTimelineScroll}
							loadingContext={loadingContext}
						/>
					</>
				) : workspaceTab === "notes" ? (
					<NotesPanel sessionId={session.sessionId} initialNotes={session.notes || ""} />
				) : workspaceTab === "instructions" ? (
					<ClaudeMdPanel session={session} />
				) : workspaceTab === "ai" ? (
					<AiPanel
						sessionId={session.sessionId}
						sessionIsManaged={Boolean(session.managedSession)}
					/>
				) : session.managedSession?.launchRequestId ? (
					<EmbeddedLaunchPanel launchId={session.managedSession.launchRequestId} />
				) : (
					<div className="p-6 text-sm text-muted-foreground">
						No linked launch for this session.
					</div>
				)}
			</div>
			{session.agentType === "claude_code" && session.managedSession ? (
				<SessionPromptComposer session={session} onSubmitted={loadSessionWorkspace} />
			) : null}
		</div>
	);
}
