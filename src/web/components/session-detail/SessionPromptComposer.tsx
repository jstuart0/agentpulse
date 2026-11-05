import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { Session } from "../../../shared/types.js";
import { useOwnershipUi, useViewerIsAdmin } from "../../hooks/useOwnershipUi.js";
import { describeApiError } from "../../lib/api-errors.js";
import { api } from "../../lib/api.js";
import { sessionActionAccess } from "../../lib/session-action-access.js";
import { useUserStore } from "../../stores/user-store.js";
import { controlBlockedReason, hostRefusalMessage } from "./host-control-view.js";
import {
	type ComposerMode,
	type SendPhase,
	boxState,
	composerMode,
	composerNotice,
	followPromptAction,
	followsAction,
	settleFollow,
} from "./prompt-composer-view.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The prompt box for a managed session, or nothing. It is keyed by session, so a draft, a send in
 * progress or a restored prompt can't appear in another session's box when the page moves between
 * sessions. It stays mounted while the session's state changes, so a draft survives a move to degraded.
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
	if (mode === null) return null;
	return (
		<SessionPromptComposer
			key={session.sessionId}
			session={session}
			mode={mode}
			onSubmitted={onSubmitted}
		/>
	);
}

function SessionPromptComposer({
	session,
	mode,
	onSubmitted,
}: {
	session: Session;
	mode: ComposerMode;
	onSubmitted: () => Promise<void>;
}) {
	const [prompt, setPrompt] = useState("");
	const [posting, setPosting] = useState(false);
	const [phase, setPhase] = useState<SendPhase>({ step: "idle" });
	const [interactiveControlState, setInteractiveControlState] = useState<{
		available: boolean;
		reason: string | null;
	} | null>(null);
	const follow = useRef<AbortController | null>(null);
	const textareaId = useId();
	const hintId = useId();
	const noticeId = useId();
	const alertId = useId();
	const isClaude = session.agentType === "claude_code";
	const interactive = isClaude && session.managedSession?.managedState === "interactive_terminal";
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
	const notice = mode.kind === "codex" ? composerNotice(session) : null;
	const box = boxState(mode, phase, { posting });

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

	useEffect(() => () => follow.current?.abort(), []);

	async function refresh() {
		try {
			await onSubmitted();
		} catch (error) {
			console.error("Failed to refresh the session after a prompt", error);
		}
	}

	async function submit() {
		const clean = prompt.trim();
		if (!clean) return;
		setPosting(true);
		setPhase({ step: "idle" });
		try {
			const { action } = await api.sendSessionPrompt(session.sessionId, clean);
			if (!followsAction(mode)) {
				setPrompt("");
				await refresh();
				return;
			}
			const controller = new AbortController();
			follow.current = controller;
			setPhase({ step: "following" });
			setPosting(false);
			void refresh();
			const result = await followPromptAction(session.sessionId, action.id, {
				fetchActions: api.getSessionControlActions,
				now: Date.now,
				sleep,
				signal: controller.signal,
			});
			const settled = settleFollow(result);
			if (controller.signal.aborted || settled === null) return;
			setPhase(settled.phase);
			if (settled.clearDraft) setPrompt("");
			await refresh();
		} catch (error) {
			console.error("Failed to send prompt", error);
			const refusal = hostRefusalMessage(error, session);
			if (refusal) setPhase({ step: "failed", reason: refusal });
			else toast.error(describeApiError(error, "Couldn't send the prompt. Try again."));
		} finally {
			setPosting(false);
		}
	}

	const describedBy =
		[hintId, notice ? noticeId : null, box.alert ? alertId : null].filter(Boolean).join(" ") ||
		undefined;
	const sideText = hostBlockedReason ?? interactiveControlReason ?? mode.side;

	return (
		<div className="border-t border-border bg-card/80 px-3 py-3 md:px-6">
			<div className="flex flex-col gap-3">
				<div id={hintId} className="text-[11px] text-muted-foreground">
					{mode.hint}
				</div>
				{notice ? (
					<div id={noticeId} className="text-[11px] text-amber-600 dark:text-amber-400">
						{notice}
					</div>
				) : null}
				<div className="flex flex-col gap-2 md:flex-row">
					<label htmlFor={textareaId} className="sr-only">
						Prompt for this session
					</label>
					<textarea
						id={textareaId}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder={mode.placeholder}
						readOnly={box.readOnly}
						aria-describedby={describedBy}
						disabled={!interactiveControlReady || hostBlockedReason !== null}
						className="min-h-20 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground read-only:opacity-80"
					/>
					<div className="flex flex-col gap-2 md:w-40">
						<button
							type="button"
							onClick={submit}
							disabled={
								box.sendDisabled ||
								!prompt.trim() ||
								!interactiveControlReady ||
								hostBlockedReason !== null
							}
							className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
						>
							{box.buttonText}
						</button>
						{sideText ? <div className="text-[11px] text-muted-foreground">{sideText}</div> : null}
					</div>
				</div>
				{box.alert ? (
					<div id={alertId} role="alert" className="text-xs text-red-600 dark:text-red-400">
						{box.alert}
					</div>
				) : null}
			</div>
		</div>
	);
}
