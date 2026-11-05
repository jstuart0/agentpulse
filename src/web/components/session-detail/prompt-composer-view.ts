/**
 * What the prompt box on the session page offers and says (AGEN-91). Pure functions, so every sentence
 * is tested without rendering. Refusals that come back from the server read through `hostRefusalMessage`
 * (host-control-view.ts); nothing here repeats them.
 */
import { cleanHostText } from "../../../shared/clean-host-text.js";
import {
	CONTROL_TIMEOUT_ERROR,
	HOST_RESTARTED_SYNC_ERROR,
} from "../../../shared/managed-messages.js";
import type { ControlAction, Session } from "../../../shared/types.js";
import { describeApiError } from "../../lib/api-errors.js";
import { ApiError } from "../../lib/api.js";
import { hasPendingCodexApproval } from "../../lib/codex-approval-wait.js";
import { HOST_RESTARTED_PROMPT_COPY, hostNameOf, hostRefusalMessage } from "./host-control-view.js";

export const COMPOSER_BLOCKED_RESTARTED = HOST_RESTARTED_PROMPT_COPY;
export const COMPOSER_BLOCKED_CONNECTION =
	"This session's connection to Codex isn't healthy, so it can't take prompts. Start a new session to keep going.";
export const COMPOSER_BLOCKED_NOT_READY =
	"This session isn't ready for prompts yet. The box opens once Codex has started.";
export const COMPOSER_BLOCKED_NOT_OWNER =
	"Only the owner or an admin can send prompts to this session.";
export const COMPOSER_ENDED =
	"This session has ended, so it can't take prompts. Your text is still here to copy.";
export const COMPOSER_KEEP_TEXT = "Your text is still here to copy.";
export const COMPOSER_UNKNOWN_OUTCOME =
	"No answer from the host yet, so it may still run. Your text is back here. If Control history shows it queued or running, don't send it again yet.";
export const COMPOSER_FAILED_FALLBACK =
	"The host couldn't take the prompt. Your text is back here.";
export const COMPOSER_BUSY =
	"Another action on this session is still going. Your text is here. Send it when that finishes.";
export const COMPOSER_STATUS_WAITING = "Waiting for the host to start this turn.";
export const COMPOSER_STATUS_SENT = "Prompt sent.";
const NOTICE_APPROVAL_FIRST =
	"Answer the approval above first. A prompt sent before the turn ends is refused.";
const NOTICE_TURN_RUNNING =
	"The current turn hasn't ended. If you send now, the host will refuse it and your text will stay here.";
const SENDING_FOLLOW = "Sending…";
const SENDING_POST = "Sending...";

export interface ComposerCopy {
	hint: string;
	placeholder: string;
	button: string;
	side: string;
}

export type ComposerMode =
	| ({ kind: "claude_interactive" | "claude_headless" | "codex" } & ComposerCopy)
	| {
			kind: "blocked";
			reason: string;
			/** The reason ends in "start a new session", so the page offers the way to do it. */
			startNew: boolean;
	  };

type ModeSession = Pick<Session, "agentType" | "managedSession"> &
	Partial<Pick<Session, "hostControl">>;

const CLAUDE_INTERACTIVE: ComposerCopy = {
	hint: "This sends your prompt into the owned interactive Claude session and keeps the terminal and workspace on the same session.",
	placeholder: "What should the interactive Claude session do next?",
	button: "Send to terminal",
	side: "AgentPulse will also log the prompt in the session timeline.",
};
const CLAUDE_HEADLESS: ComposerCopy = {
	hint: "This runs a follow-up headless turn inside the same Claude session and streams the visible output back here.",
	placeholder: "Describe the next task for this headless session.",
	button: "Send task",
	side: "Visible output lands in Activity and Launch.",
};
const CODEX: ComposerCopy = {
	hint: "This starts a new turn in the same Codex thread, under the launch's approval policy and sandbox.",
	placeholder: "What should Codex do next?",
	button: "Send prompt",
	side: "Replies and approval requests appear in this session.",
};

function blocked(reason: string, startNew = false): ComposerMode {
	return { kind: "blocked", reason, startNew };
}

const CODEX_HIDDEN_STATES = new Set(["stopped", "completed", "failed"]);

/** A Codex host that can't be reached has its own sentence: nothing was sent, because nobody sent. */
function codexHostReason(session: ModeSession): string | null {
	const state = session.hostControl?.state;
	if (state === undefined || state === "live") return null;
	if (state === "gone") {
		return "This session's host was removed from AgentPulse, so it can't take prompts. You can archive it.";
	}
	return `${hostNameOf(session)} is offline, so this session can't take prompts until it's back.`;
}

/** The box to show, or null when there should be none. */
export function composerMode(
	session: ModeSession,
	access: { canPrompt: boolean },
): ComposerMode | null {
	const managed = session.managedSession;
	if (!managed) return null;
	if (session.agentType === "codex_cli") {
		if (CODEX_HIDDEN_STATES.has(managed.managedState)) return null;
		if (!access.canPrompt) return blocked(COMPOSER_BLOCKED_NOT_OWNER);
		const hostReason = codexHostReason(session);
		if (hostReason !== null) return blocked(hostReason);
		if (managed.managedState === "managed") return { kind: "codex", ...CODEX };
		if (managed.managedState === "degraded") {
			return managed.providerSyncError === HOST_RESTARTED_SYNC_ERROR
				? blocked(COMPOSER_BLOCKED_RESTARTED, true)
				: blocked(COMPOSER_BLOCKED_CONNECTION, true);
		}
		return blocked(COMPOSER_BLOCKED_NOT_READY);
	}
	if (session.agentType !== "claude_code") return null;
	if (!access.canPrompt) return blocked(COMPOSER_BLOCKED_NOT_OWNER);
	return managed.managedState === "interactive_terminal"
		? { kind: "claude_interactive", ...CLAUDE_INTERACTIVE }
		: { kind: "claude_headless", ...CLAUDE_HEADLESS };
}

/** A warning above the box. It never disables Send: the host is the one authority on "busy". */
export function composerNotice(session: Pick<Session, "isWorking" | "metadata">): string | null {
	if (hasPendingCodexApproval(session)) return NOTICE_APPROVAL_FIRST;
	return session.isWorking ? NOTICE_TURN_RUNNING : null;
}

/**
 * Whether the composer watches the control action after the 202. A Codex prompt and an interactive
 * Claude prompt are done when the host hands them off. A headless Claude action reports only when its
 * monitor resolves, so a healthy long turn would hit the 90 s lock and read as failed.
 */
export function followsAction(mode: ComposerMode | null): boolean {
	return mode?.kind === "codex" || mode?.kind === "claude_interactive";
}

export type SendPhase =
	| { step: "idle" }
	| { step: "following" }
	| { step: "failed"; reason: string; startNew: boolean }
	| { step: "unknown" };

export interface BoxState {
	readOnly: boolean;
	/** Send does nothing (and says so with aria-disabled, so focus stays where it is). */
	sendDisabled: boolean;
	buttonText: string;
	/** The warning or failure under the box; null when there is none. */
	alert: string | null;
	/** The failure ends in "start a new session". */
	startNew: boolean;
}

/** The textarea and button for a mode and where the send is. The empty-draft check stays with the draft. */
export function boxState(
	mode: ComposerMode,
	phase: SendPhase,
	flight: { posting: boolean },
): BoxState {
	const isBlocked = mode.kind === "blocked";
	const following = phase.step === "following";
	const posting = flight.posting;
	const alert =
		phase.step === "failed"
			? phase.reason
			: phase.step === "unknown"
				? COMPOSER_UNKNOWN_OUTCOME
				: null;
	return {
		readOnly: isBlocked || following || (posting && followsAction(mode)),
		sendDisabled: isBlocked || following || posting,
		buttonText: following
			? SENDING_FOLLOW
			: posting
				? SENDING_POST
				: isBlocked
					? CODEX.button
					: mode.button,
		alert,
		startNew: phase.step === "failed" && phase.startNew,
	};
}

/** The live line for a followed send: what to wait for, then (to a screen reader only) that it went. */
export function composerStatus(
	mode: ComposerMode | null,
	phase: SendPhase,
	justSent: boolean,
): { text: string; srOnly: boolean } | null {
	if (!followsAction(mode)) return null;
	if (phase.step === "following") return { text: COMPOSER_STATUS_WAITING, srOnly: false };
	if (justSent) return { text: COMPOSER_STATUS_SENT, srOnly: true };
	return { text: "", srOnly: true };
}

/** A refusal or error from the POST itself, as the sentence to show and whether it ends in "start a new session". */
export function describeSendFailure(
	error: unknown,
	session: Pick<Session, "managedSession">,
): { reason: string; startNew: boolean } {
	const refusal = hostRefusalMessage(error, session);
	if (refusal !== null) {
		const code = error instanceof ApiError ? error.code : null;
		return {
			reason: refusal,
			startNew: code === "managed_state_not_continuable" || code === "host_upgrade_required",
		};
	}
	if (
		error instanceof ApiError &&
		(error.body as { reason?: unknown } | null)?.reason === "control_busy"
	) {
		return { reason: COMPOSER_BUSY, startNew: false };
	}
	return {
		reason: describeApiError(error, "Couldn't send the prompt. Try again."),
		startNew: false,
	};
}

export type FollowOutcome =
	| { outcome: "succeeded" }
	| { outcome: "failed"; error: string | null }
	| { outcome: "unknown" }
	| { outcome: "aborted" };

/** What the box does with a finished follow; null when the follow was abandoned and nothing should change. */
export function settleFollow(
	result: FollowOutcome,
): { phase: SendPhase; clearDraft: boolean } | null {
	switch (result.outcome) {
		case "succeeded":
			return { phase: { step: "idle" }, clearDraft: true };
		case "failed":
			return {
				phase: {
					step: "failed",
					reason: cleanHostText(result.error) ?? COMPOSER_FAILED_FALLBACK,
					startNew: false,
				},
				clearDraft: false,
			};
		case "unknown":
			return { phase: { step: "unknown" }, clearDraft: false };
		case "aborted":
			return null;
	}
}

/** On a touch screen, moving focus back to the box would raise the keyboard over the answer. */
export function shouldRefocusBox(
	matchMedia: ((query: string) => { matches: boolean }) | undefined,
): boolean {
	return !matchMedia?.("(pointer: coarse)").matches;
}

export const FOLLOW_POLL_MS = 1500;
/** The 90 s control lock plus margin. */
export const FOLLOW_DEADLINE_MS = 100_000;

export interface FollowDeps {
	fetchActions: (
		sessionId: string,
		opts: { background: true },
	) => Promise<{ controlActions: ControlAction[] }>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}

/**
 * Polls one control action until it settles. Bound to the session it started with: an action row that
 * belongs to another session is never read. A failed poll is not the action's failure; it is tried again.
 * An action whose lock ran out before the host reported has an unknown outcome (the prompt may have run).
 */
export async function followPromptAction(
	sessionId: string,
	actionId: string,
	deps: FollowDeps,
): Promise<FollowOutcome> {
	const startedAt = deps.now();
	for (;;) {
		if (deps.signal?.aborted) return { outcome: "aborted" };
		try {
			const { controlActions } = await deps.fetchActions(sessionId, { background: true });
			if (deps.signal?.aborted) return { outcome: "aborted" };
			const action = controlActions.find((a) => a.id === actionId && a.sessionId === sessionId);
			if (action?.status === "succeeded") return { outcome: "succeeded" };
			if (action?.status === "failed") {
				return action.error === CONTROL_TIMEOUT_ERROR
					? { outcome: "unknown" }
					: { outcome: "failed", error: action.error };
			}
		} catch {
			// The next poll will say; a dropped request is not the host's answer.
		}
		if (deps.now() - startedAt >= FOLLOW_DEADLINE_MS) return { outcome: "unknown" };
		await deps.sleep(FOLLOW_POLL_MS);
	}
}
