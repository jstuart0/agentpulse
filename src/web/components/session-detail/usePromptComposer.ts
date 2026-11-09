import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Session } from "../../../shared/types.js";
import { api } from "../../lib/api.js";
import { forkInfo, forkSourceOf } from "../../lib/fork-session.js";
import { type SendOutcome, usePromptDraftStore } from "../../stores/prompt-draft-store.js";
import {
	type ComposerMode,
	type SendPhase,
	describeSendFailure,
	followModeOf,
	followPromptAction,
	followsAction,
	settleFollow,
	withoutTextBack,
} from "./prompt-composer-view.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const IDLE: SendPhase = { step: "idle" };
const FOLLOWING: SendPhase = { step: "following" };

export interface PromptComposerOptions {
	session: Pick<Session, "sessionId" | "isWorking" | "managedSession"> &
		Partial<
			Pick<
				Session,
				"agentType" | "forkedFromSessionId" | "forkPermissionBranch" | "metadata" | "continuedFrom"
			>
		>;
	mode: ComposerMode | null;
	/** Refreshes the page's view of the session; may reject, which never reaches the person. */
	onSubmitted: () => Promise<void>;
	/** A followed send has settled (sent, failed or unknown): the page can put focus back in the box. */
	onSettled?: () => void;
}

/**
 * The prompt box's state and its one action. The text is a per-viewer draft kept by the draft store, so it
 * survives a switch of session and a reload. The send is a POST that answers 202 with the control action;
 * the draft is given up at the 202 (only if unchanged) and a "sending" marker in the store keeps the text
 * on screen, read-only, in every box for the session until the host says what happened. Where
 * `followsAction`, the mounted box watches the action; a box that is mounted again mid-send resumes that
 * watch on the same action. A failed or unknown outcome puts the text back.
 */
export function usePromptComposer({
	session,
	mode,
	onSubmitted,
	onSettled,
}: PromptComposerOptions) {
	const sessionId = session.sessionId;
	const draftText = usePromptDraftStore((s) => s.drafts[sessionId]?.text ?? "");
	const marker = usePromptDraftStore((s) => s.sending[sessionId]);
	const restoredAt = usePromptDraftStore((s) => {
		const draft = s.drafts[sessionId];
		return draft?.restored && !s.sending[sessionId] ? draft.savedAt : null;
	});
	const sending = marker !== undefined;
	const markerActionId = marker?.actionId ?? null;
	const prompt = marker?.text ?? draftText;

	const [posting, setPosting] = useState(false);
	const [localPhase, setPhase] = useState<SendPhase>(IDLE);
	const [justSent, setJustSent] = useState(false);
	const alive = useRef(true);
	const inFlight = useRef(false);
	const wasWorking = useRef(session.isWorking);
	const latest = useRef({ session, mode, onSubmitted, onSettled });
	latest.current = { session, mode, onSubmitted, onSettled };

	// A marker with no action yet, in a box that isn't the one posting, is a send another box started.
	const phase: SendPhase =
		sending && (markerActionId !== null || !posting) ? FOLLOWING : localPhase;

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			usePromptDraftStore.getState().flush(sessionId);
		};
	}, [sessionId]);

	// A failure that was about a turn still running is old news once that turn ends.
	useEffect(() => {
		if (wasWorking.current && !session.isWorking) {
			setPhase((current) => (current.step === "failed" ? IDLE : current));
		}
		wasWorking.current = session.isWorking;
	}, [session.isWorking]);

	async function refresh() {
		try {
			await latest.current.onSubmitted();
		} catch (error) {
			console.error("Failed to refresh the session after a prompt", error);
		}
	}

	// Following starts here, from the marker, so a box mounted again mid-send picks the action up.
	// biome-ignore lint/correctness/useExhaustiveDependencies: restarts only when the marker's action changes
	useEffect(() => {
		const current = usePromptDraftStore.getState().sending[sessionId];
		if (!current || current.actionId === null) return;
		const { ticket, text, actionId } = current;
		const controller = new AbortController();
		void (async () => {
			const { session: s, mode: m } = latest.current;
			const result = await followPromptAction(sessionId, actionId, {
				fetchActions: api.getSessionControlActions,
				now: Date.now,
				sleep,
				signal: controller.signal,
				until: followModeOf(m) ?? "settle",
			});
			const settled = settleFollow(
				result,
				forkInfo(s) ? { machine: s.managedSession?.hostName, source: forkSourceOf(s) } : undefined,
			);
			if (settled === null) return;
			const restored = usePromptDraftStore
				.getState()
				.sendSettled(ticket, result.outcome as SendOutcome, text);
			if (!alive.current) return;
			const needsText = result.outcome !== "succeeded";
			setPhase(needsText && !restored ? withoutTextBack(settled.phase) : settled.phase);
			if (settled.clearDraft) setJustSent(true);
			latest.current.onSettled?.();
			await refresh();
		})();
		return () => controller.abort();
	}, [sessionId, markerActionId]);

	function edit(text: string) {
		usePromptDraftStore.getState().edit(sessionId, text);
		setJustSent(false);
		setPhase((current) => (current.step === "failed" ? IDLE : current));
	}

	/** Removes the draft; an Undo in the toast puts it back (it does nothing once a send has started). */
	function discard() {
		const store = usePromptDraftStore.getState();
		const removed = store.discard(sessionId);
		if (!removed) return;
		toast("Draft discarded", {
			action: {
				label: "Undo",
				onClick: () => void usePromptDraftStore.getState().undoDiscard(sessionId, removed),
			},
		});
	}

	async function submit() {
		const clean = prompt.trim();
		if (!clean || inFlight.current || sending || mode === null || mode.kind === "blocked") return;
		const ticket = usePromptDraftStore.getState().beginSend(sessionId, prompt, () => {
			// No answer in 30 s: the store has put the text back; say that it may have been sent.
			if (alive.current) {
				setPhase({ step: "unknown" });
				setPosting(false);
			}
		});
		if (!ticket) return;
		inFlight.current = true;
		setPosting(true);
		setPhase(IDLE);
		setJustSent(false);
		try {
			const { action } = await api.sendSessionPrompt(sessionId, clean);
			const follows = followsAction(mode);
			usePromptDraftStore.getState().sendAccepted(ticket, action.id, follows);
			if (!alive.current) return;
			if (follows) {
				setPosting(false);
				void refresh();
			} else {
				await refresh();
			}
		} catch (error) {
			usePromptDraftStore.getState().sendRefused(ticket);
			if (!alive.current) return;
			console.error("Failed to send prompt", error);
			const { reason, startNew } = describeSendFailure(error, session);
			if (followsAction(mode)) setPhase({ step: "failed", reason, startNew });
			else toast.error(reason);
			onSettled?.();
		} finally {
			inFlight.current = false;
			if (alive.current) setPosting(false);
		}
	}

	return { prompt, edit, discard, phase, posting, justSent, submit, sending, restoredAt };
}
