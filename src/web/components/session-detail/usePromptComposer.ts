import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Session } from "../../../shared/types.js";
import { api } from "../../lib/api.js";
import { forkInfo, forkSourceOf } from "../../lib/fork-session.js";
import {
	type Draft,
	type SendOutcome,
	type SendTicket,
	usePromptDraftStore,
} from "../../stores/prompt-draft-store.js";
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
/** How long the "Draft discarded. Undo" row stays. */
export const UNDO_ROW_MS = 10_000;

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
	const note = usePromptDraftStore((s) => s.outcomes[sessionId]);
	const sending = marker !== undefined;
	const markerActionId = marker?.actionId ?? null;
	const prompt = marker?.text ?? draftText;

	const [posting, setPosting] = useState(false);
	const [justSent, setJustSent] = useState(false);
	/** The draft just discarded, for the inline Undo row. */
	const [discarded, setDiscarded] = useState<Draft | null>(null);
	const active = useRef<SendTicket | null>(null);
	const alive = useRef(true);
	const inFlight = useRef(false);
	const wasWorking = useRef(session.isWorking);
	const latest = useRef({ session, mode, onSubmitted, onSettled });
	latest.current = { session, mode, onSubmitted, onSettled };

	// A marker with no action yet, in a box that isn't the one posting, is a send another box started.
	// How the last send ended is the store's, so a box mounted again after the answer still shows it.
	const phase: SendPhase =
		sending && (markerActionId !== null || !posting) ? FOLLOWING : (note ?? IDLE);

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
			usePromptDraftStore.getState().clearOutcome(sessionId, true);
		}
		wasWorking.current = session.isWorking;
	}, [session.isWorking, sessionId]);

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
			const store = usePromptDraftStore.getState();
			const restored = store.sendSettled(ticket, result.outcome as SendOutcome, text);
			if (result.outcome !== "succeeded") {
				const final = restored ? settled.phase : withoutTextBack(settled.phase);
				if (final.step === "failed" || final.step === "unknown") store.noteOutcome(ticket, final);
			}
			if (!alive.current) return;
			if (settled.clearDraft) setJustSent(true);
			latest.current.onSettled?.();
			await refresh();
		})();
		return () => controller.abort();
	}, [sessionId, markerActionId]);

	function edit(text: string) {
		usePromptDraftStore.getState().edit(sessionId, text);
		setJustSent(false);
		setDiscarded(null);
	}

	/** Removes the draft and shows the inline Undo row (it does nothing once a send has started). */
	function discard() {
		const removed = usePromptDraftStore.getState().discard(sessionId);
		if (removed) setDiscarded(removed);
	}

	function dismissDiscarded() {
		setDiscarded(null);
	}

	function undoDiscard() {
		if (discarded) usePromptDraftStore.getState().undoDiscard(sessionId, discarded);
		setDiscarded(null);
	}

	async function submit() {
		const clean = prompt.trim();
		if (!clean || inFlight.current || sending || mode === null || mode.kind === "blocked") return;
		const ticket = usePromptDraftStore.getState().beginSend(sessionId, prompt, () => {
			// No answer in 30 s: the store has put the text back and noted that it may have been sent. The
			// hung POST no longer holds the box; its ticket makes a late answer harmless.
			if (active.current !== ticket) return;
			active.current = null;
			inFlight.current = false;
			if (alive.current) setPosting(false);
		});
		if (!ticket) return;
		active.current = ticket;
		inFlight.current = true;
		setPosting(true);
		setJustSent(false);
		setDiscarded(null);
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
			const { reason, startNew } = describeSendFailure(error, session);
			const follows = followsAction(mode);
			usePromptDraftStore
				.getState()
				.sendRefused(ticket, follows ? { step: "failed", reason, startNew } : undefined);
			if (!alive.current) return;
			console.error("Failed to send prompt", error);
			if (!follows) toast.error(reason);
			onSettled?.();
		} finally {
			if (active.current === ticket) {
				active.current = null;
				inFlight.current = false;
				if (alive.current) setPosting(false);
			}
		}
	}

	return {
		prompt,
		edit,
		discard,
		discarded,
		dismissDiscarded,
		undoDiscard,
		phase,
		posting,
		justSent,
		submit,
		sending,
		restoredAt,
	};
}
