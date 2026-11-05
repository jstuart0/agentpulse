/**
 * What the prompt box on the session page offers and says (AGEN-91). Pure functions, so every sentence
 * is tested without rendering. Refusals that come back from the server read through `hostRefusalMessage`
 * (host-control-view.ts); nothing here repeats them.
 */
import type { ControlAction, Session } from "../../../shared/types.js";
import { hasPendingCodexApproval } from "../../lib/codex-approval-wait.js";

export const COMPOSER_BLOCKED_CONNECTION =
	"This session's connection to Codex isn't healthy, so it can't take prompts.";
export const COMPOSER_BLOCKED_NOT_READY = "This session isn't ready for prompts yet.";
export const COMPOSER_BLOCKED_NOT_OWNER =
	"Only the owner or an admin can send prompts to this session.";
export const COMPOSER_UNKNOWN_OUTCOME =
	"No answer from the host yet, so it may still run. Your text is back here. Check Control history before sending again.";
export const COMPOSER_FAILED_FALLBACK =
	"The host couldn't take the prompt. Your text is back here.";
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
	| ({ kind: "blocked"; reason: string } & ComposerCopy);

type ModeSession = Pick<Session, "agentType" | "managedSession">;

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

function blocked(reason: string): ComposerMode {
	return {
		kind: "blocked",
		reason,
		hint: reason,
		placeholder: "Prompts can't be sent to this session right now.",
		button: CODEX.button,
		side: "",
	};
}

const CODEX_HIDDEN_STATES = new Set(["stopped", "completed", "failed"]);

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
		if (managed.managedState === "managed") return { kind: "codex", ...CODEX };
		return blocked(
			managed.managedState === "degraded"
				? COMPOSER_BLOCKED_CONNECTION
				: COMPOSER_BLOCKED_NOT_READY,
		);
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
	| { step: "failed"; reason: string }
	| { step: "unknown" };

export interface BoxState {
	readOnly: boolean;
	sendDisabled: boolean;
	buttonText: string;
	alert: string | null;
}

/** The textarea and button for a mode and where the send is. The empty-draft check stays with the draft. */
export function boxState(
	mode: ComposerMode,
	phase: SendPhase,
	flight: { posting: boolean },
): BoxState {
	const isBlocked = mode.kind === "blocked";
	const following = phase.step === "following";
	const alert =
		phase.step === "failed"
			? phase.reason
			: phase.step === "unknown"
				? COMPOSER_UNKNOWN_OUTCOME
				: null;
	return {
		readOnly: isBlocked || following || flight.posting,
		sendDisabled: isBlocked || following || flight.posting,
		buttonText: following ? SENDING_FOLLOW : flight.posting ? SENDING_POST : mode.button,
		alert,
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
				phase: { step: "failed", reason: result.error?.trim() || COMPOSER_FAILED_FALLBACK },
				clearDraft: false,
			};
		case "unknown":
			return { phase: { step: "unknown" }, clearDraft: false };
		case "aborted":
			return null;
	}
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
			if (action?.status === "failed") return { outcome: "failed", error: action.error };
		} catch {
			// The next poll will say; a dropped request is not the host's answer.
		}
		if (deps.now() - startedAt >= FOLLOW_DEADLINE_MS) return { outcome: "unknown" };
		await deps.sleep(FOLLOW_POLL_MS);
	}
}
