import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Session } from "../../../shared/types.js";
import { useOwnershipUi, useViewerIsAdmin } from "../../hooks/useOwnershipUi.js";
import { api } from "../../lib/api.js";
import { forkSourceOf } from "../../lib/fork-session.js";
import { sessionActionAccess } from "../../lib/session-action-access.js";
import { sessionBindAccess } from "../../lib/session-bind-access.js";
import { useUserStore } from "../../stores/user-store.js";
import { HostSentence } from "./HostSentence.js";
import { controlBlockedReason } from "./host-control-view.js";
import {
	COMPOSER_ENDED,
	COMPOSER_KEEP_TEXT,
	type ComposerMode,
	END_SESSION_BUTTON,
	RESUME_ANYWAY_BUTTON,
	RESUME_ANYWAY_NOTE,
	RESUME_BUTTON,
	RESUME_BUTTON_AGAIN,
	RESUME_BUTTON_BUSY,
	type ResumeOffer,
	type SendPhase,
	WHAT_WAITS_SUMMARY,
	boxState,
	composerMode,
	composerNotice,
	composerStatus,
	describeResumeFailure,
	focusBoxAfterSettle,
	lockedNotice,
	offersNewSession,
} from "./prompt-composer-view.js";
import type { TakeoverAttempt } from "./session-takeover-view.js";
import { usePromptComposer } from "./usePromptComposer.js";

/** Keeps a long name or sentence inside a phone's width. */
const WRAP = "[overflow-wrap:anywhere]";
const NO_ATTEMPT: TakeoverAttempt = { state: "none" };

/**
 * The prompt box for a managed session, or nothing. It is keyed by session, so a draft, a send in
 * progress or a restored prompt can't appear in another session's box when the page moves between
 * sessions. It stays mounted while the session's state changes (and after the session ends, while
 * there is text in it), so a draft survives a move to degraded or to completed.
 */
export function SessionComposerSlot({
	session,
	attempt = NO_ATTEMPT,
	onSubmitted,
	focusToken = 0,
	stoppingText = null,
	onEnd,
}: {
	session: Session;
	/** Where a resume of this session stands, derived from its control actions by the page. */
	attempt?: TakeoverAttempt;
	onSubmitted: () => Promise<void>;
	/** Raised by the page when a take-over or resume has just worked: the box takes focus once it appears. */
	focusToken?: number;
	/** A stop is queued or running (AGEN-110): the box is read-only and says why. */
	stoppingText?: string | null;
	/** Opens the End confirmation: offered first when a stranger's message stopped a continued session. */
	onEnd?: () => void;
}) {
	const ui = useOwnershipUi();
	const userId = useUserStore((s) => s.userId);
	const isAdmin = useViewerIsAdmin();
	const viewer = { userId, effectiveRole: isAdmin ? ("admin" as const) : ("member" as const) };
	const { canPrompt } = sessionActionAccess(ui, session, viewer);
	const mode = composerMode(session, {
		canPrompt,
		canResume: sessionBindAccess(ui, session, viewer),
		resumeInFlight: attempt.state === "in_flight" && attempt.kind === "recovery",
		source: forkSourceOf(session),
	});
	return (
		<SessionPromptComposer
			key={session.sessionId}
			session={session}
			mode={mode}
			attempt={attempt}
			onSubmitted={onSubmitted}
			focusToken={focusToken}
			stoppingText={stoppingText}
			onEnd={onEnd}
		/>
	);
}

export function SessionPromptComposer({
	session,
	mode,
	attempt = NO_ATTEMPT,
	onSubmitted,
	focusToken = 0,
	stoppingText = null,
	onEnd,
}: {
	session: Session;
	mode: ComposerMode | null;
	attempt?: TakeoverAttempt;
	onSubmitted: () => Promise<void>;
	focusToken?: number;
	stoppingText?: string | null;
	onEnd?: () => void;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const focusedFor = useRef(0);
	const boxShown = mode !== null && mode.kind !== "blocked";
	useEffect(() => {
		if (!boxShown || focusToken <= focusedFor.current) return;
		focusedFor.current = focusToken;
		const matchMedia = typeof window === "undefined" ? undefined : window.matchMedia;
		focusBoxAfterSettle(textareaRef.current, matchMedia?.bind(window));
	}, [boxShown, focusToken]);
	const [resumePosting, setResumePosting] = useState(false);
	const [resumeRefusal, setResumeRefusal] = useState<{ reason: string; startNew: boolean } | null>(
		null,
	);
	const { prompt, edit, phase, posting, justSent, submit } = usePromptComposer({
		session,
		mode,
		onSubmitted,
		onSettled: () => {
			const matchMedia = typeof window === "undefined" ? undefined : window.matchMedia;
			focusBoxAfterSettle(textareaRef.current, matchMedia?.bind(window));
		},
	});
	const [interactiveControlState, setInteractiveControlState] = useState<{
		available: boolean;
		reason: string | null;
	} | null>(null);
	const isClaude = session.agentType === "claude_code";
	const interactive = isClaude && session.managedSession?.managedState === "interactive_terminal";

	useEffect(() => {
		if (!interactive || !session.managedSession?.supervisorId) return;
		let cancelled = false;
		void api
			.getSupervisor(session.managedSession.supervisorId)
			.then((result) => {
				const supervisor = result.supervisor;
				if (cancelled) return;
				setInteractiveControlState(
					supervisor?.capabilities?.interactiveTerminalControl
						? {
								available: supervisor.capabilities.interactiveTerminalControl.available,
								reason: supervisor.capabilities.interactiveTerminalControl.reason,
							}
						: null,
				);
			})
			.catch(() => {
				if (!cancelled) setInteractiveControlState(null);
			});
		return () => {
			cancelled = true;
		};
	}, [interactive, session.managedSession?.supervisorId]);

	async function resume() {
		if (resumePosting) return;
		setResumePosting(true);
		setResumeRefusal(null);
		try {
			await api.resumeSession(session.sessionId);
		} catch (error) {
			setResumeRefusal(
				describeResumeFailure(error, session, {
					sourceName:
						forkSourceOf(session).state === "named" ? (session.continuedFrom?.name ?? null) : null,
				}),
			);
			setResumePosting(false);
			return;
		}
		try {
			await onSubmitted();
		} catch (error) {
			console.error("Failed to refresh the session after a resume", error);
		} finally {
			setResumePosting(false);
		}
	}

	const hasDraft = prompt.trim() !== "";
	const locked = lockedNotice(mode, hasDraft);
	if (locked !== null) {
		const failed =
			attempt.state === "failed" && attempt.kind === "recovery"
				? { reason: attempt.reason, startNew: offersNewSession(attempt.reason) }
				: null;
		return (
			<LockedDraft
				reason={locked.reason}
				showDraft={hasDraft}
				draft={prompt}
				startNew={locked.startNew}
				resume={
					locked.resume
						? {
								offer: locked.resume,
								posting: resumePosting,
								onResume: () => void resume(),
								onEnd:
									onEnd && locked.resume.state === "available" && locked.resume.afterPeerMessage
										? onEnd
										: undefined,
								alert: resumeRefusal ?? failed,
							}
						: undefined
				}
			/>
		);
	}
	if (mode === null || mode.kind === "blocked") return null;

	const capabilitySnapshot =
		session.managedSession?.providerCapabilitySnapshot &&
		typeof session.managedSession.providerCapabilitySnapshot === "object" &&
		!Array.isArray(session.managedSession.providerCapabilitySnapshot)
			? (session.managedSession.providerCapabilitySnapshot as {
					interactiveTerminalControl?: { available: boolean; reason: string | null };
				})
			: null;
	const interactiveControlReady = interactive
		? (interactiveControlState?.available ??
				capabilitySnapshot?.interactiveTerminalControl?.available) !== false
		: true;
	const interactiveControlReason =
		interactive && !interactiveControlReady
			? interactiveControlState?.reason ||
				capabilitySnapshot?.interactiveTerminalControl?.reason ||
				"This host can launch the interactive session, but AgentPulse cannot hand prompts into the terminal yet."
			: null;
	const hostBlockedReason = controlBlockedReason(session);
	const hostBlocked = hostBlockedReason !== null;

	return (
		<ComposerBody
			mode={mode}
			phase={phase}
			posting={posting}
			justSent={justSent}
			prompt={prompt}
			notice={
				mode.kind === "codex" || mode.kind === "claude_taken_over" ? composerNotice(session) : null
			}
			sideText={hostBlockedReason ?? interactiveControlReason ?? mode.side}
			stoppingNotice={stoppingText}
			unavailable={!interactiveControlReady || hostBlocked}
			textareaRef={textareaRef}
			onEdit={edit}
			onSubmit={() => void submit()}
		/>
	);
}

/** The reason, in the same amber box the page's host notice uses, and the draft (if any) to copy from. */
export function LockedDraft({
	reason,
	showDraft,
	draft,
	startNew,
	resume,
}: {
	reason: string;
	showDraft: boolean;
	draft: string;
	startNew: boolean;
	resume?: {
		offer: ResumeOffer;
		posting: boolean;
		onResume: () => void;
		/** After a stranger's message: ends the session. Offered before Resume. */
		onEnd?: () => void;
		alert: { reason: string; startNew: boolean } | null;
	};
}) {
	const reasonId = useId();
	const textareaId = useId();
	const busy = resume !== undefined && (resume.posting || resume.offer.state === "in_flight");
	// A failure that ends in "start a new session" leads: the "Resume it" lead above it would contradict it.
	const retryFirst = resume?.alert?.startNew === true && resume.offer.state === "available";
	return (
		<div className="border-t border-border bg-card/80 px-3 py-3 md:px-6">
			<div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
				{retryFirst ? null : (
					<p
						id={reasonId}
						role={resume?.offer.state === "in_flight" ? "status" : undefined}
						className="text-[11px] leading-relaxed text-foreground"
					>
						{reason}
						{startNew ? <StartNewLink /> : null}
					</p>
				)}
				{resume?.alert && retryFirst ? (
					<p role="alert" className={`text-sm text-red-700 dark:text-red-400 ${WRAP}`}>
						<HostSentence text={resume.alert.reason} /> <StartNewLink />
					</p>
				) : null}
				{resume ? (
					<div className="flex flex-col gap-2 md:flex-row md:items-center">
						{resume.onEnd ? (
							<button
								type="button"
								onClick={resume.onEnd}
								className="min-h-[44px] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 md:min-h-0"
							>
								{END_SESSION_BUTTON}
							</button>
						) : null}
						<button
							type="button"
							onClick={resume.onResume}
							disabled={busy || resume.offer.state === "disabled"}
							aria-describedby={retryFirst ? undefined : reasonId}
							className={`min-h-[44px] rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0 ${
								retryFirst || resume.onEnd
									? "border border-border text-foreground hover:bg-accent"
									: "bg-primary text-primary-foreground hover:bg-primary/90"
							}`}
						>
							{busy
								? RESUME_BUTTON_BUSY
								: retryFirst
									? RESUME_BUTTON_AGAIN
									: resume.onEnd
										? RESUME_ANYWAY_BUTTON
										: RESUME_BUTTON}
						</button>
						{resume.onEnd ? (
							<p className="text-[11px] text-muted-foreground">{RESUME_ANYWAY_NOTE}</p>
						) : null}
						{resume.alert && !retryFirst ? (
							<p role="alert" className={`text-sm text-red-700 dark:text-red-400 ${WRAP}`}>
								<HostSentence text={resume.alert.reason} />
							</p>
						) : null}
					</div>
				) : null}
				{showDraft ? (
					<>
						<label htmlFor={textareaId} className="sr-only">
							Your unsent prompt
						</label>
						<textarea
							id={textareaId}
							value={draft}
							readOnly
							aria-describedby={reasonId}
							className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
						/>
						{reason === COMPOSER_ENDED ? null : (
							<p className="text-[11px] text-muted-foreground">{COMPOSER_KEEP_TEXT}</p>
						)}
					</>
				) : null}
			</div>
		</div>
	);
}

function StartNewLink() {
	return (
		<>
			{" "}
			<Link to="/templates" className="underline underline-offset-2">
				Go to Templates
			</Link>
		</>
	);
}

export interface ComposerBodyProps {
	mode: Exclude<ComposerMode, { kind: "blocked" }>;
	phase: SendPhase;
	posting: boolean;
	justSent: boolean;
	prompt: string;
	notice: string | null;
	sideText: string | null;
	/**
	 * A stop is on its way (AGEN-110): said in place of the usual notice, at every width, and the box stays
	 * selectable (so the draft can be copied) but takes no more typing and can't send.
	 */
	stoppingNotice?: string | null;
	/** The host or the terminal can't take a prompt right now; the box is off and the side text says why. */
	unavailable: boolean;
	textareaRef?: RefObject<HTMLTextAreaElement | null>;
	onEdit: (text: string) => void;
	onSubmit: () => void;
}

/** The box itself, from its state alone, so each state's markup can be rendered and checked. */
export function ComposerBody({
	mode,
	phase,
	posting,
	justSent,
	prompt,
	notice,
	sideText,
	stoppingNotice = null,
	unavailable,
	textareaRef,
	onEdit,
	onSubmit,
}: ComposerBodyProps) {
	const textareaId = useId();
	const hintId = useId();
	const noticeId = useId();
	const alertId = useId();
	const phoneHintId = useId();
	const box = boxState(mode, phase, { posting });
	const status = composerStatus(mode, phase, justSent);
	const stopping = stoppingNotice !== null;
	const shownNotice = stopping ? stoppingNotice : phase.step === "idle" ? notice : null;
	const codex = mode.kind === "codex" || mode.kind === "claude_taken_over";
	const fork = mode.kind === "claude_taken_over";
	const describedBy =
		[hintId, fork ? phoneHintId : null, shownNotice ? noticeId : null, box.alert ? alertId : null]
			.filter(Boolean)
			.join(" ") || undefined;

	return (
		<div className="border-t border-border bg-card/80 px-3 py-3 md:px-6">
			<div className="flex flex-col gap-3">
				<div
					id={hintId}
					className={`text-[11px] text-muted-foreground${codex ? " hidden md:block" : ""}`}
				>
					{mode.hint}
				</div>
				{fork ? (
					<details className="text-[11px] text-muted-foreground md:hidden">
						<summary className="flex min-h-[44px] cursor-pointer items-center">
							{WHAT_WAITS_SUMMARY}
						</summary>
						<p id={phoneHintId}>{mode.hint}</p>
					</details>
				) : null}
				{shownNotice ? (
					<div id={noticeId} className="text-[11px] text-amber-700 dark:text-amber-400">
						{shownNotice}
					</div>
				) : null}
				<div className="flex flex-col gap-2 md:flex-row">
					<label htmlFor={textareaId} className="sr-only">
						Prompt for this session
					</label>
					<textarea
						id={textareaId}
						ref={textareaRef}
						value={prompt}
						onChange={(e) => onEdit(e.target.value)}
						placeholder={mode.placeholder}
						readOnly={box.readOnly || stopping}
						aria-describedby={describedBy}
						disabled={unavailable}
						className="min-h-20 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground read-only:opacity-80"
					/>
					<div className="flex flex-col gap-2 md:w-40">
						<button
							type="button"
							onClick={onSubmit}
							aria-disabled={box.sendDisabled || undefined}
							disabled={!prompt.trim() || unavailable || stopping}
							className={`rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 aria-disabled:opacity-50${
								codex ? " min-h-[44px] md:min-h-0" : ""
							}`}
						>
							{box.buttonText}
						</button>
						{sideText ? (
							<div
								className={`text-[11px] text-muted-foreground${codex ? " hidden md:block" : ""}`}
							>
								{sideText}
							</div>
						) : null}
					</div>
				</div>
				{status ? (
					<output className={status.srOnly ? "sr-only" : "block text-[11px] text-muted-foreground"}>
						{status.text}
					</output>
				) : null}
				{box.alert ? (
					<div id={alertId} role="alert" className="text-xs text-red-600 dark:text-red-400">
						<HostSentence text={box.alert} />
						{box.startNew ? <StartNewLink /> : null}
					</div>
				) : null}
			</div>
		</div>
	);
}
