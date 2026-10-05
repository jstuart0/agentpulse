import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AGENT_METADATA } from "../../shared/constants.js";
import { type OperationalStatus, getOperationalStatus } from "../../shared/session-state.js";
import type { AgentType, ControlAction, Session, SessionEvent } from "../../shared/types.js";
import { ActivityTimeline } from "../components/session-detail/ActivityTimeline.js";
import { AiPanel } from "../components/session-detail/AiPanel.js";
import { ControlHistory } from "../components/session-detail/ControlHistory.js";
import {
	ClaudeMdPanel,
	EmbeddedLaunchPanel,
	NotesPanel,
	SummaryField,
} from "../components/session-detail/Panels.js";
import { SessionHeader } from "../components/session-detail/SessionHeader.js";
import { SessionOwnerDialog } from "../components/session-detail/SessionOwnerDialog.js";
import { SessionPromptComposer } from "../components/session-detail/SessionPromptComposer.js";
import { SessionSummaryTab } from "../components/session-detail/SessionSummaryTab.js";
import {
	AgentObserveOnlyHint,
	CodexStatusHint,
	ManagedClaudeStatus,
	ManagedCodexStatus,
	selectStatusHint,
} from "../components/session-detail/StatusHints.js";
import { SummaryFellBackNotice } from "../components/session-detail/SummaryFellBackNotice.js";
import {
	type TimelineMode,
	getVisibleEvents,
	mergeSessionEvents,
} from "../components/session-detail/TimelineView.js";
import { useDirectoryInitials } from "../hooks/useDirectoryInitials.js";
import { useOwnershipUi, useViewerIsAdmin } from "../hooks/useOwnershipUi.js";
import { useSessionSummary } from "../hooks/useSessionSummary.js";
import {
	reloadSummaryAvailability,
	useSummaryAvailability,
	useSummaryUnavailableReason,
} from "../hooks/useSummaryAvailable.js";
import { describeApiError } from "../lib/api-errors.js";
import { api } from "../lib/api.js";
import { applyManualRename } from "../lib/name-source.js";
import { ownerChip } from "../lib/owner-chip.js";
import { ownerLabel, sessionOwnerText } from "../lib/owner-label.js";
import { NOTES_BLOCKED_REASON, sessionActionAccess } from "../lib/ownership-ui.js";
import { assignablePeople, withCurrentOwner } from "../lib/people.js";
import { sessionHostLabel } from "../lib/session-host.js";
import { type WorkspaceTabId, resolveWorkspaceTab, tabBadge } from "../lib/session-summary-view.js";
import { canAcknowledgeSession, explicitAckAccess } from "../lib/utils.js";
import { useEventStore } from "../stores/event-store.js";
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

	// The tab is the URL's, resolved against what exists right now: a Summary link waits while
	// availability loads and falls to Activity (with a line saying why) if the tab isn't there.
	const summaryAvailability = useSummaryAvailability();
	const resolvedTab = resolveWorkspaceTab(
		searchParams.get("tab"),
		summaryAvailability,
		useSummaryUnavailableReason(),
	);
	const workspaceTab: WorkspaceTabId | null = resolvedTab.kind === "tab" ? resolvedTab.tab : null;
	const fellBack = resolvedTab.kind === "tab" && resolvedTab.fellBack ? resolvedTab : null;
	const summaryAvailable = summaryAvailability === "available";

	const [loadingContext, setLoadingContext] = useState(false);
	const [contextNotFound, setContextNotFound] = useState(false);

	// AGEN: the auto-acknowledge effect's only visible side effect used to be
	// the badge quietly flipping from WAITING to IDLE -- nothing told a
	// screen-reader user it happened, and a sighted user who looked away for
	// a moment had no way to undo it. Announced via this live region and a
	// toast with its own Undo (see the auto-ack effect below).
	const [liveAnnouncement, setLiveAnnouncement] = useState("");

	// AGEN-69: the summary's state lives here, not in its tab, so a generation survives a tab
	// switch; it reads once per page view and polls only while one runs.
	const summary = useSessionSummary(sessionId, summaryAvailable);
	const summaryAnnouncement = summary.announcement;
	useEffect(() => {
		if (summaryAnnouncement) setLiveAnnouncement(summaryAnnouncement);
	}, [summaryAnnouncement]);
	useEffect(() => {
		void reloadSummaryAvailability();
	}, []);

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
	const notesReadOnlyReason =
		session &&
		!sessionActionAccess(ownershipFlags, session, {
			userId: viewerUserId,
			effectiveRole: isAdmin ? "admin" : "member",
		}).canEditNotes
			? NOTES_BLOCKED_REASON
			: null;
	const [ownerDialogOpen, setOwnerDialogOpen] = useState(false);
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
	const [launchedById, setLaunchedById] = useState<string | null>(null);
	useEffect(() => {
		setLaunchedById(null);
		if (!showOwnerFields || !launchRequestId) return;
		let cancelled = false;
		api
			.getLaunch(launchRequestId)
			.then((res) => {
				if (!cancelled) setLaunchedById(res.launchRequest.requestedByUserId ?? null);
			})
			.catch(() => {
				// No launch details: the field simply isn't shown.
			});
		return () => {
			cancelled = true;
		};
	}, [showOwnerFields, launchRequestId]);
	useEffect(() => {
		if (showOwnerFields) noteUnknownUser(launchedById);
	}, [showOwnerFields, launchedById, noteUnknownUser]);

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
			<div className="flex items-center justify-center p-6 min-h-[40vh]">
				<div className="rounded-lg border border-border bg-card p-8 max-w-sm w-full text-center space-y-4">
					<div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
						<svg
							aria-hidden="true"
							className="w-6 h-6 text-muted-foreground"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth={1.5}
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
							/>
						</svg>
					</div>
					<div>
						<h2 className="text-base font-semibold text-foreground">Session not found</h2>
						<p className="text-xs text-muted-foreground mt-1">
							This session may have been deleted, or the link is incorrect.
						</p>
					</div>
					<div className="flex flex-col gap-2">
						<button
							type="button"
							onClick={() => navigate("/")}
							className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
						>
							Back to dashboard
						</button>
						<button
							type="button"
							onClick={() => navigate("/search")}
							className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
						>
							Search sessions
						</button>
					</div>
				</div>
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
			toast.error(describeApiError(error, "Couldn't stop the session."));
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
		<div className="flex flex-col h-full">
			<div aria-live="polite" className="sr-only">
				{liveAnnouncement}
			</div>
			<SessionHeader
				session={session}
				displayName={displayName}
				allEvents={allEvents}
				workspaceTab={workspaceTab}
				onSelectTab={selectWorkspaceTab}
				summaryAvailable={summaryAvailable}
				summaryBadge={tabBadge({
					generating: summary.generating,
					newResult: false,
					tabActive: workspaceTab === "summary",
				})}
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
				onRename={(name) => setSession(applyManualRename(session, name))}
				onRefresh={loadSessionWorkspace}
				onStop={handleStop}
				ackAction={ackAction}
				headerRef={headerRef}
				permissionWaitNote={ackDerivation.permissionWaitNote}
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

			{(() => {
				const sel = selectStatusHint(session, displayName);
				switch (sel.component) {
					case "ManagedCodexStatus":
						return <ManagedCodexStatus managedSession={sel.managedSession} />;
					case "ManagedClaudeStatus":
						return <ManagedClaudeStatus managedSession={sel.managedSession} />;
					case "CodexStatusHint":
						return <CodexStatusHint displayName={sel.displayName} />;
					case "AgentObserveOnlyHint":
						return <AgentObserveOnlyHint agentType={sel.agentType} />;
				}
			})()}

			<ControlHistory actions={controlActions} />

			<div className="flex-1 min-h-0">
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
						{showOwnerFields && launchedById && (
							<SummaryField
								label="Launched by"
								value={ownerLabel(directory[launchedById], launchedById, {
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
					<SessionSummaryTab
						sessionId={session.sessionId}
						agentType={session.agentType}
						summary={summary}
					/>
				) : workspaceTab === "activity" ? (
					<>
						{fellBack ? (
							<SummaryFellBackNotice
								reason={fellBack.reason}
								onRetry={() => void reloadSummaryAvailability()}
							/>
						) : null}
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
					<NotesPanel
						sessionId={session.sessionId}
						initialNotes={session.notes || ""}
						readOnlyReason={notesReadOnlyReason}
					/>
				) : workspaceTab === "instructions" ? (
					<ClaudeMdPanel session={session} readOnlyReason={notesReadOnlyReason} />
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
							applySessionUpdate(updated);
						}
					}}
				/>
			)}
			{session.agentType === "claude_code" && session.managedSession ? (
				<SessionPromptComposer session={session} onSubmitted={loadSessionWorkspace} />
			) : null}
		</div>
	);
}
