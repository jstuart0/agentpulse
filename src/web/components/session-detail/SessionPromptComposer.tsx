import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Session } from "../../../shared/types.js";
import { useOwnershipUi, useViewerIsAdmin } from "../../hooks/useOwnershipUi.js";
import { api } from "../../lib/api.js";
import { sessionActionAccess } from "../../lib/session-action-access.js";
import { useUserStore } from "../../stores/user-store.js";
import { controlBlockedReason } from "./host-control-view.js";
import {
	COMPOSER_ENDED,
	COMPOSER_KEEP_TEXT,
	type ComposerMode,
	type SendPhase,
	boxState,
	composerMode,
	composerNotice,
	composerStatus,
	focusBoxAfterSettle,
	lockedNotice,
} from "./prompt-composer-view.js";
import { usePromptComposer } from "./usePromptComposer.js";

/**
 * The prompt box for a managed session, or nothing. It is keyed by session, so a draft, a send in
 * progress or a restored prompt can't appear in another session's box when the page moves between
 * sessions. It stays mounted while the session's state changes (and after the session ends, while
 * there is text in it), so a draft survives a move to degraded or to completed.
 */
export function SessionComposerSlot({
	session,
	onSubmitted,
}: {
	session: Session;
	onSubmitted: () => Promise<void>;
}) {
	const ui = useOwnershipUi();
	const userId = useUserStore((s) => s.userId);
	const isAdmin = useViewerIsAdmin();
	const { canPrompt } = sessionActionAccess(ui, session, {
		userId,
		effectiveRole: isAdmin ? "admin" : "member",
	});
	const mode = composerMode(session, { canPrompt });
	return (
		<SessionPromptComposer
			key={session.sessionId}
			session={session}
			mode={mode}
			onSubmitted={onSubmitted}
		/>
	);
}

export function SessionPromptComposer({
	session,
	mode,
	onSubmitted,
}: {
	session: Session;
	mode: ComposerMode | null;
	onSubmitted: () => Promise<void>;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
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

	const hasDraft = prompt.trim() !== "";
	const locked = lockedNotice(mode, hasDraft);
	if (locked !== null) {
		return (
			<LockedDraft
				reason={locked.reason}
				showDraft={hasDraft}
				draft={prompt}
				startNew={locked.startNew}
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
			notice={mode.kind === "codex" ? composerNotice(session) : null}
			sideText={hostBlockedReason ?? interactiveControlReason ?? mode.side}
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
}: {
	reason: string;
	showDraft: boolean;
	draft: string;
	startNew: boolean;
}) {
	const reasonId = useId();
	const textareaId = useId();
	return (
		<div className="border-t border-border bg-card/80 px-3 py-3 md:px-6">
			<div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
				<p id={reasonId} className="text-[11px] leading-relaxed text-foreground">
					{reason}
					{startNew ? <StartNewLink /> : null}
				</p>
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
	unavailable,
	textareaRef,
	onEdit,
	onSubmit,
}: ComposerBodyProps) {
	const textareaId = useId();
	const hintId = useId();
	const noticeId = useId();
	const alertId = useId();
	const box = boxState(mode, phase, { posting });
	const status = composerStatus(mode, phase, justSent);
	const shownNotice = phase.step === "idle" ? notice : null;
	const codex = mode.kind === "codex";
	const describedBy =
		[hintId, shownNotice ? noticeId : null, box.alert ? alertId : null].filter(Boolean).join(" ") ||
		undefined;

	return (
		<div className="border-t border-border bg-card/80 px-3 py-3 md:px-6">
			<div className="flex flex-col gap-3">
				<div
					id={hintId}
					className={`text-[11px] text-muted-foreground${codex ? " hidden md:block" : ""}`}
				>
					{mode.hint}
				</div>
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
						readOnly={box.readOnly}
						aria-describedby={describedBy}
						disabled={unavailable}
						className="min-h-20 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground read-only:opacity-80"
					/>
					<div className="flex flex-col gap-2 md:w-40">
						<button
							type="button"
							onClick={onSubmit}
							aria-disabled={box.sendDisabled || undefined}
							disabled={!prompt.trim() || unavailable}
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
						{box.alert}
						{box.startNew ? <StartNewLink /> : null}
					</div>
				) : null}
			</div>
		</div>
	);
}
