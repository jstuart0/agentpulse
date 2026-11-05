import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Session } from "../../../shared/types.js";
import { api } from "../../lib/api.js";
import {
	type ComposerMode,
	type SendPhase,
	describeSendFailure,
	followPromptAction,
	followsAction,
	settleFollow,
} from "./prompt-composer-view.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const IDLE: SendPhase = { step: "idle" };

export interface PromptComposerOptions {
	session: Pick<Session, "sessionId" | "isWorking" | "managedSession">;
	mode: ComposerMode | null;
	/** Refreshes the page's view of the session; may reject, which never reaches the person. */
	onSubmitted: () => Promise<void>;
	/** A followed send has settled (sent, failed or unknown): the page can put focus back in the box. */
	onSettled?: () => void;
}

/**
 * The prompt box's state and its one action. The send is a POST that answers 202 with the control
 * action; where `followsAction`, the box then watches that action (read-only, "Sending…") until the
 * host says what happened, so a failure comes back to the person with their text. Everything it
 * starts stops with the component: a send or a follow that finishes after unmount applies nothing.
 */
export function usePromptComposer({
	session,
	mode,
	onSubmitted,
	onSettled,
}: PromptComposerOptions) {
	const [prompt, setPrompt] = useState("");
	const [posting, setPosting] = useState(false);
	const [phase, setPhase] = useState<SendPhase>(IDLE);
	const [justSent, setJustSent] = useState(false);
	const follow = useRef<AbortController | null>(null);
	const alive = useRef(true);
	const inFlight = useRef(false);
	const wasWorking = useRef(session.isWorking);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			follow.current?.abort();
		};
	}, []);

	// A failure that was about a turn still running is old news once that turn ends.
	useEffect(() => {
		if (wasWorking.current && !session.isWorking) {
			setPhase((current) => (current.step === "failed" ? IDLE : current));
		}
		wasWorking.current = session.isWorking;
	}, [session.isWorking]);

	function edit(text: string) {
		setPrompt(text);
		setJustSent(false);
		setPhase((current) => (current.step === "failed" ? IDLE : current));
	}

	async function refresh() {
		try {
			await onSubmitted();
		} catch (error) {
			console.error("Failed to refresh the session after a prompt", error);
		}
	}

	async function submit() {
		const clean = prompt.trim();
		if (!clean || inFlight.current || mode === null || mode.kind === "blocked") return;
		inFlight.current = true;
		setPosting(true);
		setPhase(IDLE);
		setJustSent(false);
		try {
			const { action } = await api.sendSessionPrompt(session.sessionId, clean);
			if (!alive.current) return;
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
			if (!alive.current || settled === null) return;
			setPhase(settled.phase);
			if (settled.clearDraft) {
				setPrompt("");
				setJustSent(true);
			}
			onSettled?.();
			await refresh();
		} catch (error) {
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

	return { prompt, edit, phase, posting, justSent, submit };
}
