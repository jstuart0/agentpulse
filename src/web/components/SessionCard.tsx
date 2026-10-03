import { AlertTriangle, Check, Info, Undo2, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { getOperationalStatus } from "../../shared/session-state.js";
import type { Session } from "../../shared/types.js";
import { useOwnershipUi } from "../hooks/useOwnershipUi.js";
import { describeApiError } from "../lib/api-errors.js";
import { type SessionIntelligence, api } from "../lib/api.js";
import type { OwnerChipModel } from "../lib/owner-chip.js";
import { sessionActionAccess } from "../lib/ownership-ui.js";
import {
	canAcknowledgeSession,
	extractProjectName,
	formatDuration,
	getSessionMode,
	projectColor,
} from "../lib/utils.js";
import {
	UNDO_WINDOW_MS,
	ackActionLabel,
	classifyAckResponse,
	deriveCardAckAction,
	nextAckState,
	rollbackAckState,
	shouldRaiseDismissToast,
} from "../pages/dashboard-view-state.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useProjectsStore } from "../stores/projects-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useTabsStore } from "../stores/tabs-store.js";
import { useUiPrefsStore } from "../stores/ui-prefs-store.js";
import { useUserStore } from "../stores/user-store.js";
import { AgentTypeBadge } from "./AgentTypeBadge.js";
import { IntelligenceBadge } from "./IntelligenceBadge.js";
import { OwnerChip } from "./OwnerChip.js";
import { StatusBadge } from "./StatusBadge.js";

interface SessionCardProps {
	session: Session;
	intelligence?: SessionIntelligence | null;
	/** Team mode: who owns it. Absent where the cards are already about one owner, and in solo. */
	ownerChip?: OwnerChipModel | null;
}

export function SessionCard({ session, intelligence, ownerChip }: SessionCardProps) {
	const intelligenceEnabled = useLabsStore((s) => s.isEnabled("intelligenceBadges"));
	const navigate = useNavigate();
	const removeSession = useSessionStore((s) => s.removeSession);
	const updateSession = useSessionStore((s) => s.updateSession);
	const closeTab = useTabsStore((s) => s.close);
	const [renaming, setRenaming] = useState(false);
	const [newName, setNewName] = useState(session.displayName || "");
	const [confirming, setConfirming] = useState(false);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const nameSpanRef = useRef<HTMLAnchorElement>(null);
	const undoButtonRef = useRef<HTMLButtonElement>(null);
	// Transient post-action banner ("Marked as seen · Undo" / "Error
	// dismissed · Undo"). Cleared on a timer, on unmount, or by Undo itself.
	const [ackBanner, setAckBanner] = useState<"seen" | "dismissed" | null>(null);
	const ackBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (ackBannerTimerRef.current) clearTimeout(ackBannerTimerRef.current);
		};
	}, []);

	// AGEN: while the banner shows, focus moves to its Undo button so a
	// keyboard user lands on the one action that matters right after theirs.
	useEffect(() => {
		if (ackBanner) undoButtonRef.current?.focus();
	}, [ackBanner]);

	// Dismisses the ack banner (timer expiry or an explicit Undo click) and,
	// only when focus was actually on the Undo button at that moment, moves
	// it to this card's own primary action (the name link) once the button
	// has left the DOM — never steals focus from somewhere else the person
	// has already moved to.
	function dismissAckBanner() {
		const hadFocus = document.activeElement === undoButtonRef.current;
		setAckBanner(null);
		if (hadFocus) {
			requestAnimationFrame(() => nameSpanRef.current?.focus());
		}
	}

	// Click-outside and Escape cancel the inline delete confirm (C8 / S-28).
	useEffect(() => {
		if (!confirming) return;

		// Auto-focus Cancel button when confirm UI reveals.
		cancelRef.current?.focus();

		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") setConfirming(false);
		}
		function onPointerDown(e: PointerEvent) {
			if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
				setConfirming(false);
			}
		}
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [confirming]);

	const projectName = extractProjectName(session.cwd);
	const name = session.displayName || session.sessionId?.slice(0, 8) || "session";
	const linkedProject = useProjectsStore((s) => s.getById(session.projectId));
	const isScratch = (linkedProject?.tags ?? []).includes("scratch");
	const opStatus = getOperationalStatus(session);
	// Dimmed (60% opacity) treatment is for operationally COMPLETED sessions
	// (including an acknowledged failure) and archived ones — never for an
	// unacknowledged failure (ERROR), which still needs attention and must
	// render at full strength. This is deliberately NOT the same predicate
	// as "may be archived/deleted" below: a failed-but-unacknowledged
	// session is still manageable even though it isn't dimmed.
	const isDimmed = opStatus === "completed" || session.isArchived;
	// Archive/delete affordance: unchanged from the original lifecycle-based
	// rule (completed, failed, or archived) regardless of acknowledgement.
	const isManageable =
		session.status === "completed" || session.status === "failed" || session.isArchived;
	// The badge shows FAILED (not a generic COMPLETED grey) for an
	// acknowledged failure so "this session errored, then got dismissed"
	// stays visible under the Completed tab — ERROR itself (unacknowledged)
	// still renders as opStatus="error" via the branch below.
	const badgeStatus = session.isArchived
		? "archived"
		: session.status === "failed" && opStatus === "completed"
			? "failed"
			: opStatus;
	const viewerUserId = useUserStore((s) => s.userId);
	const effectiveRole = useUserStore((s) => s.effectiveRole);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const ownership = useOwnershipUi();
	// In team mode rename, pin, archive and delete belong to the owner or an
	// admin: on someone else's session they aren't offered at all.
	const access = sessionActionAccess(ownership, session, { userId: viewerUserId, effectiveRole });
	// Only what the viewer can act on: another person's session carries no
	// acknowledge control on its card (the status badge and owner chip say whose
	// turn it is); an admin's override lives on the session's own page.
	const ackAction = deriveCardAckAction(
		session,
		canAcknowledgeSession(session, viewerUserId, disableAuth),
	);
	const modeStyle = getSessionMode(session);
	const projectColorsEnabled = useUiPrefsStore((s) => s.projectColors);
	// Deterministic tint per project so sessions in the same repo
	// group visually on the grid and tab bar. Pinned sessions keep
	// their amber theme — don't double-color them. Skips entirely
	// when the user has disabled colors in Settings.
	const color = projectColorsEnabled ? projectColor(session.cwd) : null;

	async function handleRename() {
		if (!newName.trim()) {
			setRenaming(false);
			// Return focus to name span so keyboard users aren't stranded.
			requestAnimationFrame(() => nameSpanRef.current?.focus());
			return;
		}
		try {
			await api.renameSession(session.sessionId, newName.trim());
			updateSession({ ...session, displayName: newName.trim() });
		} catch (err) {
			toast.error(describeApiError(err, "Couldn't rename the session."));
			setNewName(session.displayName || "");
		}
		setRenaming(false);
		// Shift focus to the resulting name span so blur doesn't leave the
		// user without a focus target (U-L4).
		requestAnimationFrame(() => nameSpanRef.current?.focus());
	}

	async function handlePin(e: React.MouseEvent) {
		e.stopPropagation();
		const pinned = !session.isPinned;
		try {
			await api.updateSessionPin(session.sessionId, pinned);
			updateSession({ ...session, isPinned: pinned });
		} catch (err) {
			toast.error(describeApiError(err, `Couldn't ${pinned ? "pin" : "unpin"} the session.`));
		}
	}

	async function handleArchive(e: React.MouseEvent) {
		e.stopPropagation();
		try {
			await api.archiveSession(session.sessionId);
			// Slice G: mirror the server's actual write (isArchived=true, status unchanged).
			// The previous status:'archived' write was poisoning the Zustand store with a
			// value that the server never persists; the next poll overwrote it anyway.
			updateSession({ ...session, isArchived: true });
		} catch (err) {
			toast.error(describeApiError(err, "Couldn't archive the session."));
		}
	}

	// AGEN: optimistic — stamp lastUserAcknowledgedAt locally so the card
	// flips out of WAITING/ERROR immediately, then roll back to the
	// pre-call session if the request fails or the server says the viewer
	// doesn't own it (a stale permission check racing an ownership change).
	// `variant` only decides which banner/source to use afterward — WAITING
	// ("seen") and ERROR ("dismissed") both call the same endpoint.
	async function handleAcknowledge(e: React.MouseEvent, variant: "seen" | "dismissed") {
		e.stopPropagation();
		const previous = session;
		updateSession(nextAckState(session, "acknowledge", new Date().toISOString()));
		try {
			const result = await api.acknowledgeSession(
				session.sessionId,
				variant === "dismissed" ? "dismiss-error" : undefined,
			);
			const outcome = classifyAckResponse(result);
			if (outcome === "applied") {
				setAckBanner(variant);
				if (ackBannerTimerRef.current) clearTimeout(ackBannerTimerRef.current);
				ackBannerTimerRef.current = setTimeout(dismissAckBanner, UNDO_WINDOW_MS);
				// AGEN: the card can unmount (status flips out of the active
				// grid) before anyone sees the inline banner's Undo -- a toast
				// lives outside the card's own render tree, so "Dismiss error"
				// always gets a durable Undo surface regardless of which view
				// triggered it. "Mark as seen" keeps the card mounted either
				// way, so the banner alone is enough there.
				if (shouldRaiseDismissToast(variant)) {
					toast.success("Error dismissed", {
						action: { label: "Undo", onClick: () => runAckUndo() },
						duration: UNDO_WINDOW_MS,
					});
				}
				return;
			}
			updateSession(rollbackAckState(previous));
			const failureMessage =
				variant === "dismissed" ? "Couldn't dismiss the error" : "Couldn't mark as seen";
			toast.error(
				outcome === "not_owner"
					? `Only the owner or an admin can ${variant === "dismissed" ? "dismiss this error" : "mark this as seen"}`
					: failureMessage,
			);
		} catch {
			updateSession(rollbackAckState(previous));
			toast.error(variant === "dismissed" ? "Couldn't dismiss the error" : "Couldn't mark as seen");
		}
	}

	// AGEN: the reverse of a dismissed error ("Restore error") — a plain
	// unacknowledge with a distinct source token so the timeline/toast
	// vocabulary says "Error restored" rather than the generic "Marked as
	// unseen" (see userAckLabel in TimelineView.tsx).
	async function handleRestoreError(e: React.MouseEvent) {
		e.stopPropagation();
		const previous = session;
		updateSession(nextAckState(session, "unacknowledge", new Date().toISOString()));
		try {
			const result = await api.unacknowledgeSession(session.sessionId, "restore-error");
			const outcome = classifyAckResponse(result);
			if (outcome === "applied") {
				toast.success("Error restored");
				return;
			}
			updateSession(rollbackAckState(previous));
			toast.error(
				outcome === "not_owner"
					? "Only the owner or an admin can restore this"
					: "Couldn't restore",
			);
		} catch {
			updateSession(rollbackAckState(previous));
			toast.error("Couldn't restore");
		}
	}

	// Shared by the inline banner's Undo button and the dismiss toast's Undo
	// action (AGEN) -- the toast has no DOM event to stopPropagation on, so
	// the event-handling and the actual undo call are split.
	async function runAckUndo() {
		if (ackBannerTimerRef.current) clearTimeout(ackBannerTimerRef.current);
		dismissAckBanner();
		const previous = session;
		updateSession(nextAckState(session, "unacknowledge", new Date().toISOString()));
		try {
			const result = await api.unacknowledgeSession(session.sessionId);
			const outcome = classifyAckResponse(result);
			if (outcome !== "applied") {
				updateSession(rollbackAckState(previous));
				if (outcome === "not_owner") toast.error("Only the owner or an admin can undo this");
			}
		} catch {
			updateSession(rollbackAckState(previous));
			toast.error("Couldn't undo");
		}
	}

	function handleAckUndo(e: React.MouseEvent) {
		e.stopPropagation();
		void runAckUndo();
	}

	function handleDeleteRequest(e: React.MouseEvent) {
		e.stopPropagation();
		setConfirming(true);
	}

	async function handleDeleteConfirm(e: React.MouseEvent) {
		e.stopPropagation();
		setConfirming(false);
		try {
			await api.deleteSession(session.sessionId);
			removeSession(session.sessionId);
			closeTab(session.sessionId);
			toast.success("Session deleted");
		} catch (err) {
			toast.error(describeApiError(err, "Couldn't delete the session."));
		}
	}

	function handleDeleteCancel(e: React.MouseEvent) {
		e.stopPropagation();
		setConfirming(false);
	}

	return (
		<div
			ref={cardRef}
			onClick={() => navigate(`/sessions/${session.sessionId}`)}
			// Inline style carries the per-project hue. Replaces bg-card
			// with a dark-pastel tint tuned to read as "same repo" at a
			// glance. Pinned sessions keep their amber treatment.
			style={
				!session.isPinned && color
					? { backgroundColor: color.bg, borderColor: color.border }
					: undefined
			}
			className={`group relative cursor-pointer overflow-hidden rounded-lg border bg-card p-3 md:p-4 pl-4 md:pl-5 transition-all hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 ${
				session.isPinned ? "border-amber-500/30 bg-amber-500/[0.02]" : "border-border"
			} ${isScratch ? "border-dashed" : ""} ${isDimmed ? "opacity-60 hover:opacity-100" : ""}`}
		>
			{/* Mode accent bar -- ERROR overrides it to a solid red regardless
			    of the project tint (AGEN), so an unacknowledged failure reads
			    as an error at a glance even inside a strongly-tinted project. */}
			<div
				aria-hidden="true"
				className={`absolute left-0 top-0 bottom-0 w-1 ${opStatus === "error" ? "bg-red-500" : modeStyle.barClass}`}
			/>
			{/* Top row: name + working + status + actions */}
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2 min-w-0">
					{session.isPinned && (
						<span className="text-amber-500 text-xs flex-shrink-0">&#9733;</span>
					)}
					{renaming ? (
						<input
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onBlur={handleRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleRename();
								if (e.key === "Escape") setRenaming(false);
							}}
							onClick={(e) => e.stopPropagation()}
							className="text-xs font-mono font-bold bg-background border border-primary/30 rounded px-2 py-0.5 w-32 focus:outline-none focus:ring-1 focus:ring-primary"
						/>
					) : (
						// A real link, not a click handler on a span: focusable by
						// keyboard, opens in a new tab on middle/ctrl/cmd-click, and
						// still triggers the card's own onClick navigation for an
						// ordinary left-click anywhere else on the card.
						<Link
							to={`/sessions/${session.sessionId}`}
							ref={nameSpanRef}
							onClick={(e) => e.stopPropagation()}
							className="text-xs font-mono font-bold text-[hsl(var(--primary-on-tint))] dark:text-primary bg-primary/10 border border-primary/20 rounded px-2 py-0.5 truncate max-w-[10rem] md:max-w-none inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
							title={
								session.metadata?.aiInitiated === true
									? "Launched from Ask — open conversation"
									: name.length > 14
										? name
										: undefined
							}
						>
							{session.metadata?.aiInitiated === true && (
								<Wand2 className="w-3 h-3 flex-shrink-0" aria-label="Launched from Ask" />
							)}
							{name}
						</Link>
					)}
				</div>
				<div className="flex items-center gap-1 flex-shrink-0">
					{/* Mobile action row (U-H5): rename, pin, archive (if inactive),
					    delete (if inactive). All targets are ≥44×44 px per WCAG 2.5.5.
					    Delete is red at rest (mobile has no hover to reveal danger). */}
					<div className="flex md:hidden items-center gap-0.5">
						{access.canRename && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									setRenaming(true);
									setNewName(name);
								}}
								title="Rename"
								className="rounded min-w-[44px] min-h-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
									/>
								</svg>
							</button>
						)}
						{access.canPin && (
							<button
								type="button"
								onClick={handlePin}
								title={session.isPinned ? "Unpin" : "Pin"}
								className="rounded min-w-[44px] min-h-[44px] flex items-center justify-center text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
							>
								<svg
									className="w-3 h-3"
									fill={session.isPinned ? "currentColor" : "none"}
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
									/>
								</svg>
							</button>
						)}
						{isManageable && access.canArchive && !session.isArchived && (
							<button
								type="button"
								onClick={handleArchive}
								title="Archive"
								className="rounded min-w-[44px] min-h-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
									/>
								</svg>
							</button>
						)}
						{isManageable && access.canDelete && (
							<button
								type="button"
								onClick={handleDeleteRequest}
								title="Delete"
								className="rounded min-w-[44px] min-h-[44px] flex items-center justify-center text-red-500 hover:bg-red-500/10 transition-colors"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
									/>
								</svg>
							</button>
						)}
					</div>
					<div className="hidden md:group-hover:flex md:group-focus-within:flex items-center gap-0.5">
						{access.canRename && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									setRenaming(true);
									setNewName(name);
								}}
								title="Rename"
								className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
									/>
								</svg>
							</button>
						)}
						{access.canPin && (
							<button
								type="button"
								onClick={handlePin}
								title={session.isPinned ? "Unpin" : "Pin"}
								className="rounded p-1 text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
							>
								<svg
									className="w-3 h-3"
									fill={session.isPinned ? "currentColor" : "none"}
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
									/>
								</svg>
							</button>
						)}
						{isManageable && access.canArchive && !session.isArchived && (
							<button
								type="button"
								onClick={handleArchive}
								title="Archive"
								className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
									/>
								</svg>
							</button>
						)}
						{isManageable && access.canDelete && (
							<button
								type="button"
								onClick={handleDeleteRequest}
								title="Delete"
								className="rounded p-1 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
									/>
								</svg>
							</button>
						)}
					</div>
					{/* Operational status (WAITING / WORKING / IDLE / ERROR), FAILED for
					    a dismissed error, or ARCHIVED — see badgeStatus above. */}
					<StatusBadge status={badgeStatus} />
				</div>
			</div>

			{/* Inline delete confirm (C8 / S-28) — two-button reveal,
			    no modal: Cancel (autofocused) + Confirm delete (red).
			    Escape and outside-click cancel via the useEffect above.
			    <fieldset> gives us role="group" natively + aria-label support. */}
			{confirming && (
				<fieldset
					aria-label="Confirm session deletion"
					className="mb-2 flex items-center gap-2 border-0 p-0 m-0"
					onClick={(e) => e.stopPropagation()}
				>
					<button
						ref={cancelRef}
						type="button"
						onClick={handleDeleteCancel}
						onKeyDown={(e) => {
							if (e.key === "Escape") setConfirming(false);
						}}
						className="rounded px-2 py-1 text-xs text-muted-foreground border border-border hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleDeleteConfirm}
						onKeyDown={(e) => {
							if (e.key === "Escape") setConfirming(false);
						}}
						className="rounded px-2 py-1 text-xs text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
					>
						Confirm delete
					</button>
				</fieldset>
			)}

			{/* WAITING / ERROR action — a real, visible-at-rest button with a
			    text label (not an icon that only reveals on hover), so the
			    action is discoverable on both touch and keyboard. Replaced by
			    the "Marked as seen / Error dismissed · Undo" banner for a few
			    seconds right after acting. A session blocked on an outstanding
			    permission prompt, or one the viewer doesn't own, gets a plain
			    explanatory note in this slot instead of a button that would
			    either do nothing or always fail (AGEN). */}
			{ackBanner ? (
				<div
					className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"
					onClick={(e) => e.stopPropagation()}
				>
					<Check
						className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400"
						aria-hidden="true"
					/>
					<span>{ackBanner === "seen" ? "Marked as seen" : "Error dismissed"}</span>
					<button
						ref={undoButtonRef}
						type="button"
						onClick={handleAckUndo}
						className="min-h-[44px] md:min-h-0 font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
					>
						Undo
					</button>
				</div>
			) : ackAction.kind === "mark_seen" ? (
				<button
					type="button"
					onClick={(e) => handleAcknowledge(e, "seen")}
					aria-label={`Mark ${name} as seen`}
					className="mb-2 inline-flex min-h-[44px] md:min-h-0 items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Check className="w-3.5 h-3.5" aria-hidden="true" />
					{ackActionLabel("mark_seen")}
				</button>
			) : ackAction.kind === "dismiss_error" ? (
				<button
					type="button"
					onClick={(e) => handleAcknowledge(e, "dismissed")}
					aria-label={`Dismiss error for ${name}`}
					className="mb-2 inline-flex min-h-[44px] md:min-h-0 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-500/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
					{ackActionLabel("dismiss_error")}
				</button>
			) : ackAction.kind === "restore_error" ? (
				<button
					type="button"
					onClick={handleRestoreError}
					aria-label={`Restore error for ${name}`}
					className="mb-2 inline-flex min-h-[44px] md:min-h-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
					Restore error
				</button>
			) : ackAction.permissionWaitNote ? (
				<p
					className="mb-2 inline-flex items-center gap-1.5 text-xs text-foreground"
					onClick={(e) => e.stopPropagation()}
				>
					<Info className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
					{ackAction.permissionWaitNote}
				</p>
			) : null}

			{/* Project + branch */}
			<div className="mb-2">
				<div className="flex items-center justify-between gap-2">
					<h3
						className="min-w-0 text-sm font-semibold truncate text-foreground group-hover:text-primary transition-colors"
						title={projectName.length > 24 ? projectName : undefined}
					>
						{projectName}
					</h3>
					{ownerChip && <OwnerChip chip={ownerChip} />}
				</div>
				<div className="flex flex-wrap items-center gap-2 mt-0.5">
					{/* On mobile the project heading above already shows the folder name;
					    the full path is too long for small screens. Show it on md+. */}
					<p
						className="hidden md:block text-xs text-muted-foreground truncate"
						title={session.cwd || ""}
					>
						{session.cwd}
					</p>
					{session.gitBranch && (
						<span className="flex-shrink-0 text-[10px] font-mono text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0">
							{session.gitBranch}
						</span>
					)}
					{linkedProject && (
						<span className="flex-shrink-0 text-[10px] font-medium text-blue-700 dark:text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1.5 py-0">
							{linkedProject.name}
						</span>
					)}
					{isScratch && (
						<span
							title="Scratch workspace — created by AgentPulse for an Ask task"
							className="flex-shrink-0 text-[10px] font-medium text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0"
						>
							scratch
						</span>
					)}
				</div>
			</div>

			{/* Agent type + mode + intelligence + duration + tools */}
			<div className="flex items-center gap-2">
				<AgentTypeBadge agentType={session.agentType} />
				<span
					title={`Session mode: ${modeStyle.label}`}
					className={`flex-shrink-0 text-[10px] font-mono rounded border px-1.5 py-0 ${modeStyle.chipClass}`}
				>
					{modeStyle.label}
				</span>
				{intelligenceEnabled && intelligence && <IntelligenceBadge intelligence={intelligence} />}
				<span
					className="text-xs text-muted-foreground"
					title={`Last activity ${session.lastActivityAt} · started ${session.startedAt}`}
				>
					{formatDuration(session.lastActivityAt)} ago
				</span>
				<span className="text-xs text-muted-foreground ml-auto">{session.totalToolUses} tools</span>
			</div>

			{/* Current task */}
			{session.currentTask && (
				<p className="text-xs text-foreground/70 truncate mt-2">{session.currentTask}</p>
			)}
		</div>
	);
}
