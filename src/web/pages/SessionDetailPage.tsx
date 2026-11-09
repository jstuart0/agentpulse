import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AGENT_METADATA } from "../../shared/constants.js";
import { type OperationalStatus, getOperationalStatus } from "../../shared/session-state.js";
import type { AgentType, ControlAction, Session, SessionEvent } from "../../shared/types.js";
import { ActivityTimeline } from "../components/session-detail/ActivityTimeline.js";
import { ControlHistory } from "../components/session-detail/ControlHistory.js";
import {
	ClaudeMdPanel,
	EmbeddedLaunchPanel,
	NotesPanel,
	SummaryField,
} from "../components/session-detail/Panels.js";
import { SessionGoneCard } from "../components/session-detail/SessionGoneCard.js";
import { SessionHeader } from "../components/session-detail/SessionHeader.js";
import { SessionOwnerDialog } from "../components/session-detail/SessionOwnerDialog.js";
import { SessionComposerSlot } from "../components/session-detail/SessionPromptComposer.js";
import {
	AgentObserveOnlyHint,
	CodexStatusHint,
	HostControlHint,
	ManagedClaudeStatus,
	ManagedCodexStatus,
	ManagedForkStatus,
	selectStatusHint,
} from "../components/session-detail/StatusHints.js";
import { StopConfirmDialog } from "../components/session-detail/StopConfirmDialog.js";
import { StopFailureAlert } from "../components/session-detail/StopFailureAlert.js";
import { SummaryFellBackNotice } from "../components/session-detail/SummaryFellBackNotice.js";
import {
	type TimelineMode,
	getVisibleEvents,
	mergeSessionEvents,
} from "../components/session-detail/TimelineView.js";
import { FORK_CLAUDE_MD_NOT_LOADED } from "../components/session-detail/fork-status-view.js";
import {
	showProviderSyncError,
	showProviderSyncState,
} from "../components/session-detail/host-control-view.js";
import {
	type ContinuedArrival,
	bottomSlot,
	canOfferTakeover,
	continuedArrivalAnnouncement,
	continuedNavigation,
	isTakenOver,
	overviewOriginField,
	showsStatusHint,
} from "../components/session-detail/session-takeover-view.js";
import {
	STOP_TURN_ANNOUNCE_START,
	canStopSession,
	canStopTurn,
	stopRequestFailure,
	stopTurnRequestFailure,
	stoppingText,
} from "../components/session-detail/stop-view.js";
import { useDirectoryInitials } from "../hooks/useDirectoryInitials.js";
import { useEventReveal } from "../hooks/useEventReveal.js";
import { useOwnershipUi, useViewerIsAdmin } from "../hooks/useOwnershipUi.js";
import { useResumeAttempt } from "../hooks/useResumeAttempt.js";
import { useSessionSummaryPage } from "../hooks/useSessionSummaryPage.js";
import { useSessionWorkspaceLoad } from "../hooks/useSessionWorkspaceLoad.js";
import { useStopConfirm } from "../hooks/useStopConfirm.js";
import { useStopFollow, useStopTurnFollow } from "../hooks/useStopFollow.js";
import { api } from "../lib/api.js";
import {
	chunkLoadFailedCopy,
	hasPendingCodexApproval,
	showsApprovalCard,
} from "../lib/codex-approval-wait.js";
import { EVENT_LOAD_FAILED_COPY } from "../lib/event-deep-link.js";
import { focusLandingAfterRender } from "../lib/focus-landing.js";
import { forkInfo, forkSourceOf } from "../lib/fork-session.js";
import { applyManualRename } from "../lib/name-source.js";
import { ownerChip } from "../lib/owner-chip.js";
import { ownerLabel, sessionOwnerText } from "../lib/owner-label.js";
import { assignablePeople, withCurrentOwner } from "../lib/people.js";
import { NOTES_BLOCKED_REASON, sessionActionAccess } from "../lib/session-action-access.js";
import { sessionHostLabel } from "../lib/session-host.js";
import type { WorkspaceTabId } from "../lib/session-summary-core.js";
import { canAcknowledgeSession, explicitAckAccess } from "../lib/utils.js";
import { useEventStore } from "../stores/event-store.js";
import { handleGoneSession } from "../stores/forget-gone-sessions.js";
import { mergeSessionIntoDetail, useSessionStore } from "../stores/session-store.js";
import { useTabsStore } from "../stores/tabs-store.js";
import { useUserStore } from "../stores/user-store.js";
import { useUsersStore } from "../stores/users-store.js";
import {
	AUTO_ACK_DWELL_MS,
	UNDO_WINDOW_MS,
	ackToastText,
	classifyAckResponse,
	deriveAckActionForViewer,
	shouldAutoAcknowledge,
} from "./dashboard-view-state.js";

// The Summary panel is behind a Labs flag that is off by default: it loads when the tab opens.
const SessionSummaryTab = lazy(() =>
	import("../components/session-detail/SessionSummaryTab.js").then((m) => ({
		default: m.SessionSummaryTab,
	})),
);

// The AI tab (watcher modes, reports, approval cards) loads when the tab opens: most visits never use it.
const AiPanel = lazy(() =>
	import("../components/session-detail/AiPanel.js").then((m) => ({ default: m.AiPanel })),
);

// The take-over card and its dialog: a separate chunk, so a session nobody can take over never pays for it.
// If the chunk can't load, say so: nothing else on the page offers the way in.
function TakeoverChunkFailed() {
	return (
		<div
			role="alert"
			className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-3 md:px-6"
		>
			<p className="text-sm text-foreground">
				This part of the page didn't load. Reload to take this session over.
			</p>
			<button
				type="button"
				onClick={() => window.location.reload()}
				className="min-h-[44px] rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-accent"
			>
				Reload
			</button>
		</div>
	);
}
const takeoverChunk = () => import("../components/session-detail/SessionTakeoverCard.js");
const SessionTakeoverCard = lazy(() =>
	takeoverChunk()
		.then((m) => ({ default: m.SessionTakeoverCard }))
		.catch(() => ({ default: TakeoverChunkFailed })),
);
const SessionTakeoverProgress = lazy(() =>
	takeoverChunk()
		.then((m) => ({ default: m.SessionTakeoverProgress }))
		.catch(() => ({ default: TakeoverChunkFailed })),
);

// The approval card for a managed Codex session: a separate chunk, so no other session pays for it.
// If the chunk can't load while Codex is asking, say so, because nothing else on the page can answer.
const CodexApprovalCard = lazy(() =>
	import("../components/session-detail/CodexApprovalCard.js")
		.then((m) => ({ default: m.CodexApprovalCard }))
		.catch(() => ({
			default: ({ session }: { session: Session }) =>
				hasPendingCodexApproval(session) ? (
					<div role="alert" className="mx-3 mt-2 flex flex-wrap items-center gap-2 md:mx-6">
						<p className="text-sm text-foreground">{chunkLoadFailedCopy(session.agentType)}</p>
						<button
							type="button"
							onClick={() => window.location.reload()}
							className="min-h-[44px] rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-accent"
						>
							Reload
						</button>
					</div>
				) : (
					<></>
				),
		})),
);

/** Scrolls to an event's element and flashes it; false while it isn't in the DOM yet. */
function flashEvent(eventId: number): boolean {
	const el = document.getElementById(`event-${eventId}`);
	if (!el) return false;
	el.scrollIntoView({ behavior: "smooth", block: "center" });
	el.classList.add("event-flash");
	setTimeout(() => el.classList.remove("event-flash"), 2200);
	return true;
}

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

	const [eventsLoaded, setEventsLoaded] = useState(false);

	// AGEN: the auto-acknowledge effect's only visible side effect used to be
	// the badge quietly flipping from WAITING to IDLE -- nothing told a
	// screen-reader user it happened, and a sighted user who looked away for
	// a moment had no way to undo it. Announced via this live region and a
	// toast with its own Undo (see the auto-ack effect below).
	const [liveAnnouncement, setLiveAnnouncement] = useState("");

	// AGEN-69: the summary's state lives here, not in its tab, so a generation survives a tab switch.
	const {
		route: { workspaceTab, fellBack },
		summary,
		badge: summaryBadge,
		retryAvailability,
	} = useSessionSummaryPage({
		sessionId,
		tabParam: searchParams.get("tab"),
		announce: setLiveAnnouncement,
	});

	const timelineContainerRef = useRef<HTMLDivElement>(null);
	const timelineEndRef = useRef<HTMLDivElement>(null);
	const headerRef = useRef<HTMLDivElement>(null);
	const shouldFollowTimelineRef = useRef(true);
	const previousEventCountRef = useRef(0);
	const liveEventsMap = useEventStore((s) => s.liveEvents);
	const clearLiveEvents = useEventStore((s) => s.clearSession);
	const watchSession = useEventStore((s) => s.watch);
	// While this page is open its session's live events are kept even if the
	// dashboard doesn't hold the session (someone else's, under Mine).
	useEffect(() => {
		watchSession(sessionId ?? null);
		return () => watchSession(null);
	}, [sessionId, watchSession]);

	// The sessions this page has shown, and the one (if any) the server has said is gone. Both are per session:
	// the page stays mounted across session changes, so `gone` is read only for the session on screen.
	const shownSessionIds = useRef(new Set<string>());
	const [gone, setGone] = useState<{ sessionId: string; notice: boolean } | null>(null);
	const goneHeadingRef = useRef<HTMLHeadingElement>(null);
	const goneNotice = gone !== null && gone.sessionId === sessionId && gone.notice;
	useEffect(() => {
		if (goneNotice) goneHeadingRef.current?.focus();
	}, [goneNotice]);

	// The loader drops an answer for a session no longer shown, or older than one already applied or than
	// a write this page made itself (see useSessionWorkspaceLoad).
	const workspace = useSessionWorkspaceLoad(sessionId, {
		loaded: (data) => {
			shownSessionIds.current.add(sessionId as string);
			setGone(null);
			setSession(data.session as Session);
			setEvents(data.events as SessionEvent[]);
			setEventsLoaded(true);
			setControlActions((data.controlActions as ControlAction[]) || []);
		},
		gone: (id) => {
			setSession(null);
			setEvents([]);
			setControlActions([]);
			const { notice } = handleGoneSession(id, shownSessionIds.current.has(id));
			// A later poll's 404 never takes back a notice already given for this session.
			setGone((prev) => ({
				sessionId: id,
				notice: notice || (prev?.sessionId === id && prev.notice),
			}));
		},
		failed: (err) => console.error("Failed to fetch session:", err),
		settled: () => setLoading(false),
	});
	const loadSessionWorkspace = workspace.load;

	// Where a take-over or resume stands, derived from the session's control actions, so it survives a
	// reload, a poll that lands mid-attempt and another tab. It also polls while one is in flight and
	// speaks the outcome through the live region.
	const { attempt, focusToken } = useResumeAttempt({
		sessionId,
		controlActions,
		hostName: session?.managedSession?.hostName ?? null,
		reload: loadSessionWorkspace,
		announce: setLiveAnnouncement,
	});

	// A continued Claude session has just been set up: move to it, and say so there (AGEN-117). The attempt
	// ends and the session's `continuedIn` arrive in one refresh, so the page never moves on a stale read.
	const previousAttempt = useRef(attempt);
	useEffect(() => {
		const move = continuedNavigation(previousAttempt.current, attempt, session);
		previousAttempt.current = attempt;
		if (move) navigate(move.to, { state: { continuedArrival: move.arrival } });
	}, [attempt, session, navigate]);
	const location = useLocation();
	const [arrivalToken, setArrivalToken] = useState(0);
	const arrival = (location.state as { continuedArrival?: ContinuedArrival } | null)
		?.continuedArrival;
	useEffect(() => {
		if (!arrival || !session || session.sessionId !== sessionId) return;
		setLiveAnnouncement(
			continuedArrivalAnnouncement(arrival, session.managedSession?.managedState === "managed"),
		);
		setArrivalToken((token) => token + 1);
		navigate(location.pathname + location.search, { replace: true, state: null });
	}, [arrival, session, sessionId, navigate, location.pathname, location.search]);

	// A stop in flight refreshes the session every couple of seconds; one that fails stays on the page.
	const stopFollow = useStopFollow({
		sessionId,
		session,
		controlActions,
		reload: loadSessionWorkspace,
		announce: setLiveAnnouncement,
	});

	// A Stop turn in flight is followed the same way; one that fails stays on the page, and one that works puts
	// focus back in the prompt box.
	const stopTurnFollow = useStopTurnFollow({
		sessionId,
		controlActions,
		reload: loadSessionWorkspace,
		announce: setLiveAnnouncement,
	});
	// The last refusal of a Stop turn, kept with the session it was about so another session never shows it.
	const [refused, setRefused] = useState<{ sessionId: string; text: string } | null>(null);
	const interruptRefusal =
		refused !== null && refused.sessionId === sessionId ? refused.text : null;

	// Warm the header from the cached dashboard list so switching tabs feels instant.
	useEffect(() => {
		if (!sessionId) return;
		const cached = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
		setSession(cached ?? null);
		setEvents([]);
		setEventsLoaded(false);
		setControlActions([]);
		setLoading(!cached);
		setGone(null);
	}, [sessionId]);

	// F95: apply live WebSocket session updates (renames, resets, status) as
	// they land in the store, instead of waiting for the 10 s poll.
	const storeSession = useSessionStore((s) => s.sessions.find((x) => x.sessionId === sessionId));
	useEffect(() => {
		setSession((current) => mergeSessionIntoDetail(current, storeSession));
	}, [storeSession]);

	// AGEN: opening a session's detail page marks it seen — but only when
	// EVERY condition in shouldAutoAcknowledge holds: WAITING (never
	// ERROR — that needs an explicit Dismiss error), the viewer may
	// acknowledge it, the tab is actually visible, and it has stayed open
	// and visible for AUTO_ACK_DWELL_MS. A background or restored
	// (not-yet-visible) tab must not fire until it becomes visible.
	// ackedTurnKeyRef guards against re-firing for the same finished turn
	// while the page stays open (keyed on sessionId + the turn timestamp,
	// not just sessionId, so a NEW finished turn after a prior
	// auto-acknowledge gets its own 2s dwell).
	const viewerUserId = useUserStore((s) => s.userId);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const ownershipFlags = useOwnershipUi();
	const { adminMayClearOthersAttention, ownerGatesSessionActions, showOwnerFields } =
		ownershipFlags;
	const directory = useUsersStore((s) => s.byId);
	const initialsById = useDirectoryInitials(directory);
	const isAdmin = useViewerIsAdmin();
	const access = session
		? sessionActionAccess(ownershipFlags, session, {
				userId: viewerUserId,
				effectiveRole: isAdmin ? "admin" : "member",
			})
		: null;
	const notesReadOnlyReason = access && !access.canEditNotes ? NOTES_BLOCKED_REASON : null;
	// Stop is owner-checked on the server like a prompt, so the composer's rule decides whether it is offered.
	const mayChangeSession = access?.canPrompt ?? true;
	const [ownerDialogOpen, setOwnerDialogOpen] = useState(false);
	const stopConfirm = useStopConfirm(sessionId, focusLandingAfterRender);
	// The session stopped being one Stop applies to (it ended, the host changed): the dialog goes with it.
	const stopApplies = session !== null && canStopSession(session);
	useEffect(() => {
		if (!stopApplies && stopConfirm.open) {
			stopConfirm.cancel();
			focusLandingAfterRender();
		}
	}, [stopApplies, stopConfirm.open, stopConfirm.cancel]);
	// Stop turn replaces Send in the prompt box while a continued session's turn runs (AGEN-119). The server
	// advertises it as `claudeStopTurn`; this page is served by that server, so it is always there.
	const stopTurnAvailable =
		session !== null &&
		(stopTurnFollow.stoppingTurn ||
			canStopTurn(session, controlActions, { mayChange: mayChangeSession, advertised: true }));
	const noteUnknownUser = useUsersStore((s) => s.noteUnknown);
	const applySessionUpdate = useSessionStore((s) => s.applySessionUpdate);
	const ackedTurnKeyRef = useRef<string | null>(null);
	const sessionRef = useRef<Session | null>(session);
	useEffect(() => {
		sessionRef.current = session;
	}, [session]);
	const opStatus = session ? getOperationalStatus(session) : null;
	const turnKey = session?.lastAgentTurnCompletedAt ?? null;
	const canAck = session ? canAcknowledgeSession(session, viewerUserId, disableAuth) : false;
	const sessionOwnerId = session?.ownerUserId ?? null;
	useEffect(() => {
		if (showOwnerFields) noteUnknownUser(sessionOwnerId);
	}, [showOwnerFields, sessionOwnerId, noteUnknownUser]);

	// Who launched it, for a session launched from the dashboard: the launch
	// request knows; the session itself doesn't.
	const launchRequestId = session?.managedSession?.launchRequestId ?? null;
	const takenOver = isTakenOver(session?.managedSession);
	const agentType = session?.agentType;
	const [origin, setOrigin] = useState<ReturnType<typeof overviewOriginField>>(null);
	useEffect(() => {
		setOrigin(null);
		if (!showOwnerFields || !launchRequestId) return;
		let cancelled = false;
		api
			.getLaunch(launchRequestId)
			.then((res) => {
				if (!cancelled) setOrigin(overviewOriginField(takenOver, res.launchRequest, agentType));
			})
			.catch(() => {
				// No launch details: the field simply isn't shown.
			});
		return () => {
			cancelled = true;
		};
	}, [showOwnerFields, launchRequestId, takenOver, agentType]);
	const originUserId = origin?.userId ?? null;
	useEffect(() => {
		if (showOwnerFields) noteUnknownUser(originUserId);
	}, [showOwnerFields, originUserId, noteUnknownUser]);

	// AGEN: the auto-ack toast's Undo action. Deliberately does NOT clear
	// ackedTurnKeyRef -- the auto-ack effect's alreadyAckedThisTurn guard
	// must keep this turn suppressed after an Undo, or the effect would
	// immediately re-fire the moment lastUserAcknowledgedAt goes back to
	// null (the session is still WAITING, still visible, still past dwell).
	async function undoAutoAck() {
		if (!sessionId) return;
		try {
			const result = await api.unacknowledgeSession(sessionId);
			if (classifyAckResponse(result) !== "applied") {
				toast.error("Couldn't undo");
				return;
			}
			const current = sessionRef.current;
			if (current && current.sessionId === sessionId) {
				const stamped = { ...current, lastUserAcknowledgedAt: null };
				setSession(stamped);
				workspace.markApplied();
				applySessionUpdate(stamped);
			}
			setLiveAnnouncement("Marked as unseen");
		} catch {
			toast.error("Couldn't undo");
		}
	}

	// AGEN: the gate itself is shouldAutoAcknowledge (dashboard-view-state.ts,
	// tested) — this effect only measures real dwell time (how long the tab
	// has been open AND visible, continuously) and schedules a re-evaluation
	// at the moment that measurement would cross AUTO_ACK_DWELL_MS. No
	// second copy of the WAITING/ownership/visibility/dwell/already-acked
	// rule lives here.
	useEffect(() => {
		if (!sessionId || !opStatus) return;
		const ackKey = `${sessionId}:${turnKey ?? "none"}`;
		let dwellStartMs: number | null = document.visibilityState === "visible" ? Date.now() : null;
		let timer: ReturnType<typeof setTimeout> | null = null;

		function fire() {
			ackedTurnKeyRef.current = ackKey;
			api
				.acknowledgeSession(sessionId as string)
				.then((result) => {
					if (classifyAckResponse(result) !== "applied") return;
					const now = new Date().toISOString();
					const current = sessionRef.current;
					if (!current || current.sessionId !== sessionId) return;
					const stamped = { ...current, lastUserAcknowledgedAt: now };
					setSession(stamped);
					workspace.markApplied();
					applySessionUpdate(stamped);
					setLiveAnnouncement("Marked as seen");
					toast.success("Marked as seen", {
						action: { label: "Undo", onClick: () => void undoAutoAck() },
						duration: UNDO_WINDOW_MS,
					});
				})
				.catch(() => {
					if (ackedTurnKeyRef.current === ackKey) ackedTurnKeyRef.current = null;
				});
		}

		function evaluate() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			const dwellMs = dwellStartMs != null ? Date.now() - dwellStartMs : 0;
			const tabVisible = document.visibilityState === "visible";
			const should = shouldAutoAcknowledge({
				operationalStatus: opStatus as OperationalStatus,
				canAcknowledge: canAck,
				tabVisible,
				dwellMs,
				alreadyAckedThisTurn: ackedTurnKeyRef.current === ackKey,
			});
			if (should) {
				fire();
				return;
			}
			// Still visible and not yet past the dwell threshold -- schedule
			// exactly one re-check at the moment it would be.
			if (tabVisible && dwellStartMs != null && dwellMs < AUTO_ACK_DWELL_MS) {
				timer = setTimeout(evaluate, AUTO_ACK_DWELL_MS - dwellMs + 1);
			}
		}

		function onVisibility() {
			if (document.visibilityState === "visible") {
				dwellStartMs = Date.now();
			} else {
				dwellStartMs = null;
			}
			evaluate();
		}

		evaluate();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			if (timer) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [sessionId, opStatus, turnKey, canAck, applySessionUpdate]);

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
			cwd: session.cwd ?? null,
		});
	}, [session, openTab]);

	const liveEvents = ((sessionId && liveEventsMap.get(sessionId)) || []) as SessionEvent[];
	const allEvents = mergeSessionEvents([...events].reverse(), liveEvents);
	const eventHash = /^#event-(\d+)$/.exec(location.hash);
	const reveal = useEventReveal({
		sessionId,
		tab: workspaceTab,
		eventId: eventHash ? Number(eventHash[1]) : null,
		events: allEvents,
		eventsLoaded,
		mode,
		filters: { showTools, showNoisyTools, showSystem },
		apply: {
			setMode,
			setFilters: (f) => {
				if (f.showTools) setShowTools(true);
				if (f.showNoisyTools) setShowNoisyTools(true);
				if (f.showSystem) setShowSystem(true);
			},
		},
		fetchContext: async (id) => {
			const res = await api.getEventContext(sessionId ?? "", id);
			setEvents((prev) => insertEvents(prev, res.events as SessionEvent[]));
		},
		flash: flashEvent,
		announce: setLiveAnnouncement,
	});
	const visibleEvents = getVisibleEvents(
		allEvents,
		mode,
		showTools || mode === "debug" || mode === "terminal",
		showNoisyTools,
		showSystem,
	);

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
			<SessionGoneCard
				deleted={goneNotice}
				headingRef={goneHeadingRef}
				onDashboard={() => navigate("/")}
				onSearch={() => navigate("/search")}
			/>
		);
	}

	const displayName = session.displayName || session.sessionId.slice(0, 8);
	const stoppable = session;

	/** Queues the stop. Resolves to the reason it couldn't be, or null once it is queued. */
	async function performStop(isCurrent: () => boolean): Promise<string | null> {
		if (!sessionId) return "Couldn't stop the session.";
		try {
			await api.stopSession(sessionId);
		} catch (error) {
			console.error("Failed to stop session:", error);
			return stopRequestFailure(error, stoppable);
		}
		// The person left this session before the answer came: nothing below is about the one on screen.
		if (!isCurrent()) return null;
		setLiveAnnouncement("Stopping…");
		try {
			await loadSessionWorkspace();
		} catch (error) {
			console.error("Failed to refresh the session after a stop:", error);
		}
		return null;
	}

	/** Queues the Stop turn. A refusal is shown beside the prompt box; no dialog first (F12: it keeps the session). */
	async function performInterrupt(): Promise<void> {
		if (!sessionId || stopTurnFollow.stoppingTurn) return;
		setRefused(null);
		setLiveAnnouncement(STOP_TURN_ANNOUNCE_START);
		try {
			await api.interruptSession(sessionId);
		} catch (error) {
			console.error("Failed to stop the turn:", error);
			const reason = stopTurnRequestFailure(error, stoppable);
			setRefused({ sessionId, text: reason });
			setLiveAnnouncement(reason);
			return;
		}
		try {
			await loadSessionWorkspace();
		} catch (error) {
			console.error("Failed to refresh the session after a Stop turn:", error);
		}
	}

	// Manual acknowledge actions for the header. Unlike the auto-acknowledge
	// effect above, these are explicit — in particular ERROR is NEVER
	// cleared automatically; only handleDismissError (via "dismiss-error")
	// does that.
	async function runAckAction(
		action: () => Promise<{ acknowledged?: boolean; unacknowledged?: boolean; reason?: string }>,
		nextLastUserAcknowledgedAt: string | null,
		failureMessage: string,
		onApplied?: () => void,
	) {
		try {
			const result = await action();
			const outcome = classifyAckResponse(result);
			if (outcome === "applied") {
				setSession((current) =>
					current ? { ...current, lastUserAcknowledgedAt: nextLastUserAcknowledgedAt } : current,
				);
				workspace.markApplied();
				const current = sessionRef.current;
				if (current)
					applySessionUpdate({ ...current, lastUserAcknowledgedAt: nextLastUserAcknowledgedAt });
				onApplied?.();
				return;
			}
			if (outcome === "not_owner") toast.error("Only the owner or an admin can do this");
			else toast.error(failureMessage);
		} catch {
			toast.error(failureMessage);
		}
	}

	// After an explicit acknowledge: the same toast-with-Undo the card gives, and
	// focus on the header. The button that was clicked changes or vanishes (an
	// admin acting for the owner can't act again), which would drop focus to the
	// page.
	function afterExplicitAck(kind: "mark_seen" | "dismiss_error", forOwnerName: string | null) {
		const text = ackToastText(kind, forOwnerName);
		if (text) {
			setLiveAnnouncement(text);
			toast.success(text, {
				action: {
					label: "Undo",
					onClick: () => void (kind === "mark_seen" ? undoAutoAck() : handleRestoreError()),
				},
				duration: UNDO_WINDOW_MS,
			});
		}
		requestAnimationFrame(() => headerRef.current?.focus());
	}

	function handleMarkSeen(forOwnerName: string | null) {
		if (!sessionId) return;
		return runAckAction(
			() => api.acknowledgeSession(sessionId),
			new Date().toISOString(),
			"Couldn't mark as seen",
			() => afterExplicitAck("mark_seen", forOwnerName),
		);
	}

	function handleDismissError(forOwnerName: string | null) {
		if (!sessionId) return;
		return runAckAction(
			() => api.acknowledgeSession(sessionId, "dismiss-error"),
			new Date().toISOString(),
			"Couldn't dismiss the error",
			() => afterExplicitAck("dismiss_error", forOwnerName),
		);
	}

	function handleMarkUnseen() {
		if (!sessionId) return;
		return runAckAction(() => api.unacknowledgeSession(sessionId), null, "Couldn't mark as unseen");
	}

	// AGEN: the reverse of a dismissed error ("Restore error") — a distinct
	// source token so the timeline/toast vocabulary says "Error restored"
	// rather than the generic "Marked as unseen" (see userAckLabel in
	// TimelineView.tsx).
	function handleRestoreError() {
		if (!sessionId) return;
		return runAckAction(
			() => api.unacknowledgeSession(sessionId, "restore-error"),
			null,
			"Couldn't restore",
		);
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

	function selectWorkspaceTab(tab: WorkspaceTabId) {
		const next = new URLSearchParams(searchParams);
		next.set("tab", tab);
		setSearchParams(next, { replace: true });
	}

	// Detail-header action: the same derivation the session card uses (AGEN)
	// — mark_seen / dismiss_error / restore_error / mark_unseen, or a
	// permission-wait / not-owner note instead of a button. No second copy
	// of the precedence rule lives here; only the kind -> handler mapping
	// does.
	const detailAckAccess = explicitAckAccess(
		session,
		viewerUserId,
		disableAuth,
		adminMayClearOthersAttention,
	);
	const ackDerivation = deriveAckActionForViewer(session, {
		isOwnerOrUnowned: canAcknowledgeSession(session, viewerUserId, disableAuth),
		teamMode: ownerGatesSessionActions,
		adminForOwnerName: detailAckAccess.forOwnerId
			? ownerLabel(directory[detailAckAccess.forOwnerId], detailAckAccess.forOwnerId, {
					selfId: viewerUserId,
				})
			: null,
	});
	const ackActionHandlers: Record<(typeof ackDerivation)["kind"] & string, () => void> = {
		mark_seen: () => handleMarkSeen(ackDerivation.forOwnerName),
		dismiss_error: () => handleDismissError(ackDerivation.forOwnerName),
		restore_error: handleRestoreError,
		mark_unseen: handleMarkUnseen,
	};
	const ackAction = ackDerivation.kind
		? {
				kind: ackDerivation.kind,
				forOwnerName: ackDerivation.forOwnerName,
				onClick: ackActionHandlers[ackDerivation.kind],
			}
		: null;
	const hostLabel = sessionHostLabel(session);

	return (
		<div className="flex flex-col h-full [&:has([data-codex-approval])>[data-tab-panel]]:min-h-[24rem]">
			<div aria-live="polite" className="sr-only">
				{liveAnnouncement}
			</div>
			<SessionHeader
				session={session}
				displayName={displayName}
				allEvents={allEvents}
				workspaceTab={workspaceTab}
				onSelectTab={selectWorkspaceTab}
				summaryBadge={summaryBadge}
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
				onRename={(name) => {
					setSession(applyManualRename(session, name));
					workspace.markApplied();
				}}
				onRefresh={loadSessionWorkspace}
				onStop={stopConfirm.request}
				stopping={stopFollow.stopping}
				stopTurn={{
					available: stopTurnAvailable,
					inFlight: stopTurnFollow.stoppingTurn,
					onStop: () => void performInterrupt(),
				}}
				mayStop={mayChangeSession}
				ackAction={ackAction}
				headerRef={headerRef}
				permissionWaitNote={
					hasPendingCodexApproval(session) ? null : ackDerivation.permissionWaitNote
				}
				notOwnerNote={ackDerivation.notOwnerNote}
				ownerChip={
					showOwnerFields
						? ownerChip(session, {
								viewerUserId,
								lookup: (id) => directory[id],
								initialsById,
							})
						: null
				}
			/>

			{showsStatusHint(attempt)
				? (() => {
						const sel = selectStatusHint(session, displayName);
						switch (sel.component) {
							case "ManagedCodexStatus":
								return (
									<ManagedCodexStatus
										managedSession={sel.managedSession}
										showSyncState={showProviderSyncState(session)}
										showSyncError={showProviderSyncError(session)}
									/>
								);
							case "ManagedClaudeStatus":
								return <ManagedClaudeStatus managedSession={sel.managedSession} />;
							case "ManagedForkStatus":
								return <ManagedForkStatus key={session.sessionId} session={session} />;
							case "CodexStatusHint":
								return <CodexStatusHint displayName={sel.displayName} />;
							case "AgentObserveOnlyHint":
								return <AgentObserveOnlyHint agentType={sel.agentType} />;
						}
					})()
				: null}

			<HostControlHint session={session} />

			{showsApprovalCard(session) ? (
				<Suspense fallback={null}>
					<CodexApprovalCard session={session} announce={setLiveAnnouncement} />
				</Suspense>
			) : null}

			<ControlHistory actions={controlActions} />

			{workspaceTab === "activity" && reveal.notice ? (
				<p className="flex flex-shrink-0 flex-wrap items-center gap-2 px-3 pt-2 text-xs text-muted-foreground md:px-6">
					{reveal.notice}
					{reveal.notice === EVENT_LOAD_FAILED_COPY ? (
						<button
							type="button"
							onClick={reveal.retry}
							className="min-h-[44px] rounded-md border border-border px-3 py-1.5 font-medium text-foreground hover:bg-accent md:min-h-0"
						>
							Try again
						</button>
					) : null}
				</p>
			) : null}

			{fellBack ? (
				<div className="flex-shrink-0 pb-1">
					<SummaryFellBackNotice reason={fellBack.reason} onRetry={retryAvailability} />
				</div>
			) : null}

			<div className="flex-1 min-h-0" data-tab-panel="">
				{workspaceTab === null ? (
					<div aria-busy="true" className="space-y-3 p-6">
						<div className="h-4 w-1/3 rounded bg-muted motion-safe:animate-pulse" />
						<div className="h-4 w-1/2 rounded bg-muted motion-safe:animate-pulse" />
					</div>
				) : workspaceTab === "overview" ? (
					<div className="grid gap-4 p-3 md:p-6 md:grid-cols-2 xl:grid-cols-4">
						<SummaryField label="Project" value={session.cwd} mono />
						<SummaryField
							label="Agent"
							value={AGENT_METADATA[session.agentType as AgentType]?.label ?? session.agentType}
						/>
						<SummaryField label="Started" value={session.startedAt} />
						<SummaryField label="Status" value={session.status} />
						{showOwnerFields && (
							<SummaryField
								label="Owner"
								value={sessionOwnerText(session, (id) => directory[id], viewerUserId)}
								action={
									isAdmin ? (
										<button
											type="button"
											onClick={() => setOwnerDialogOpen(true)}
											aria-label={`Change owner of ${displayName}`}
											className="mt-1 min-h-[44px] rounded-md px-1 text-xs font-medium text-primary underline underline-offset-2 hover:text-foreground md:min-h-0"
										>
											Change owner
										</button>
									) : undefined
								}
							/>
						)}
						{showOwnerFields && origin && (
							<SummaryField
								label={origin.label}
								value={ownerLabel(directory[origin.userId], origin.userId, {
									selfId: viewerUserId,
									style: "you",
								})}
							/>
						)}
						<SummaryField label="Model" value={session.model} />
						<SummaryField label="Branch" value={session.gitBranch} mono />
						<SummaryField label="Current task" value={session.currentTask} />
						<SummaryField label="Tools" value={String(session.totalToolUses)} />
						{hostLabel ? (
							<SummaryField label={hostLabel.fieldLabel} value={hostLabel.name} mono />
						) : null}
						{session.managedSession?.launchRequestId ? (
							<SummaryField
								label="Launch request"
								value={session.managedSession.launchRequestId}
								mono
							/>
						) : null}
					</div>
				) : workspaceTab === "summary" ? (
					<Suspense
						fallback={
							<div aria-busy="true" className="p-6 text-sm text-muted-foreground">
								Loading…
							</div>
						}
					>
						<SessionSummaryTab
							sessionId={session.sessionId}
							agentType={session.agentType}
							continued={forkInfo(session) !== null}
							summary={summary}
							meta={{
								name: displayName,
								branch: session.gitBranch ?? null,
								cwd: session.cwd ?? null,
							}}
							announce={setLiveAnnouncement}
						/>
					</Suspense>
				) : workspaceTab === "activity" ? (
					<>
						<ActivityTimeline
							ref={timelineContainerRef}
							endRef={timelineEndRef}
							visibleEvents={visibleEvents}
							mode={mode}
							onScroll={handleTimelineScroll}
							loadingContext={reveal.loadingContext}
							session={session}
							allEvents={allEvents}
						/>
					</>
				) : workspaceTab === "notes" ? (
					<NotesPanel
						sessionId={session.sessionId}
						initialNotes={session.notes || ""}
						readOnlyReason={notesReadOnlyReason}
					/>
				) : workspaceTab === "instructions" ? (
					forkInfo(session) ? (
						<p className="p-4 text-sm text-muted-foreground md:p-6">{FORK_CLAUDE_MD_NOT_LOADED}</p>
					) : (
						<ClaudeMdPanel session={session} readOnlyReason={notesReadOnlyReason} />
					)
				) : workspaceTab === "ai" ? (
					<Suspense
						fallback={
							<div aria-busy="true" className="p-6 text-sm text-muted-foreground">
								Loading…
							</div>
						}
					>
						<AiPanel
							sessionId={session.sessionId}
							agentType={session.agentType}
							fork={forkInfo(session) !== null}
						/>
					</Suspense>
				) : session.managedSession?.launchRequestId ? (
					<EmbeddedLaunchPanel
						launchId={session.managedSession.launchRequestId}
						takenOver={takenOver}
						agentType={session.agentType}
					/>
				) : (
					<div className="p-6 text-sm text-muted-foreground">
						No linked launch for this session.
					</div>
				)}
			</div>
			{stopConfirm.open && (
				<StopConfirmDialog
					session={session}
					fork={
						forkInfo(session) ? { name: displayName, source: forkSourceOf(session) } : undefined
					}
					busy={stopConfirm.busy}
					error={stopConfirm.error}
					onConfirm={() => void stopConfirm.confirm(performStop)}
					onCancel={stopConfirm.cancel}
				/>
			)}
			{ownerDialogOpen && (
				<SessionOwnerDialog
					sessionId={session.sessionId}
					sessionName={displayName}
					currentOwnerId={session.ownerUserId ?? null}
					people={withCurrentOwner(
						assignablePeople(Object.values(directory), viewerUserId),
						session.ownerUserId,
						directory[session.ownerUserId ?? ""],
						viewerUserId,
					)}
					onClose={() => setOwnerDialogOpen(false)}
					onChanged={(updated) => {
						setOwnerDialogOpen(false);
						if (updated) {
							setSession(updated);
							workspace.markApplied();
							applySessionUpdate(updated);
						}
					}}
				/>
			)}
			{stopFollow.failure !== null && <StopFailureAlert text={stopFollow.failure} />}
			{(interruptRefusal ?? stopTurnFollow.failure) !== null && (
				<StopFailureAlert text={(interruptRefusal ?? stopTurnFollow.failure) as string} />
			)}
			{(() => {
				switch (bottomSlot(session, attempt)) {
					case "takeover_progress":
						return attempt.state === "in_flight" ? (
							<Suspense fallback={null}>
								<SessionTakeoverProgress session={session} attempt={attempt} />
							</Suspense>
						) : null;
					case "composer":
						return (
							<SessionComposerSlot
								session={session}
								attempt={attempt}
								focusToken={focusToken + arrivalToken + stopTurnFollow.succeeded}
								onSubmitted={loadSessionWorkspace}
								stoppingText={stopFollow.stopping ? stoppingText(session) : null}
								onEnd={stopConfirm.request}
								stopTurn={{
									available: stopTurnAvailable,
									inFlight: stopTurnFollow.stoppingTurn,
									onStop: () => void performInterrupt(),
								}}
							/>
						);
					case "takeover":
						return canOfferTakeover(session.agentType) ? (
							<Suspense fallback={null}>
								<SessionTakeoverCard
									key={session.sessionId}
									session={session}
									sessionName={displayName}
									attempt={attempt}
									onChanged={loadSessionWorkspace}
								/>
							</Suspense>
						) : null;
				}
			})()}
		</div>
	);
}
