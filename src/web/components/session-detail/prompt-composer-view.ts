import { forkSentenceName } from "../../../shared/claude-fork-copy.js";
/**
 * What the prompt box on the session page offers and says (AGEN-91). Pure functions, so every sentence
 * is tested without rendering. Refusals that come back from the server read through `hostRefusalMessage`
 * (host-control-view.ts); nothing here repeats them.
 */
import { cleanHostText } from "../../../shared/clean-host-text.js";
import {
	CLAUDE_API_ERROR_MESSAGE,
	CLAUDE_FORK_BUSY_ERROR,
	CLAUDE_FORK_CHANGED_SYNC_ERROR,
	CLAUDE_FORK_CHECK_FAILED_ERROR,
	CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR,
	CLAUDE_FORK_NO_RUNTIME_ERROR,
	CLAUDE_FORK_PEER_SYNC_ERROR,
	CLAUDE_FORK_SLASH_MESSAGE,
	CLAUDE_FORK_TERMINAL_FOUND_ERROR,
	CLAUDE_LOGIN_LOST_ERROR,
	CONTROL_TIMEOUT_ERROR,
	HOST_RESTARTED_SYNC_ERROR,
} from "../../../shared/managed-messages.js";
import type { ControlAction, Session } from "../../../shared/types.js";
import { describeApiError } from "../../lib/api-errors.js";
import { ApiError } from "../../lib/api.js";
import { hasPendingCodexApproval } from "../../lib/codex-approval-wait.js";
import {
	type ForkSource,
	continueAgain,
	forkInfo,
	sourceLabel,
	sourceUnavailable,
} from "../../lib/fork-session.js";
import { hostNameOf, hostRefusalMessage } from "./host-control-view.js";
import { bindRefusalMessage, isTakenOver } from "./session-takeover-view.js";

/** Resume isn't offered here (no thread id to resume), so this one doesn't say "Resume it". */
export const COMPOSER_BLOCKED_RESTARTED =
	"This session's process ended when its host restarted, so it can't take more prompts. Start a new session for this work.";
export const COMPOSER_BLOCKED_CONNECTION =
	"This session's connection to Codex isn't healthy, so it can't take prompts. Start a new session to keep going.";
export const COMPOSER_BLOCKED_NOT_READY =
	"This session isn't ready for prompts yet. The box opens once Codex has started.";
export const COMPOSER_BLOCKED_NOT_READY_CLAUDE =
	"This session isn't ready for prompts yet. The box opens once Claude has started.";
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
/** A Claude prompt holds the session's lock for the whole turn (AGEN-117 T12), so the usual "busy" is a turn in progress. */
export const COMPOSER_BUSY_CLAUDE =
	"Claude is still working on this session. Your text is here. Send it when it finishes.";
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

/** What the locked notice offers for a Codex session whose process is gone. Absent: nothing to press. */
export type ResumeOffer =
	| {
			state: "available";
			/** A message from something else stopped the session: ending it comes first, Resume second. */
			afterPeerMessage?: true;
	  }
	| { state: "disabled" }
	| { state: "in_flight" };

export type ComposerMode =
	| ({
			kind: "claude_interactive" | "claude_headless" | "claude_taken_over" | "codex";
	  } & ComposerCopy)
	| {
			kind: "blocked";
			reason: string;
			/** The reason ends in "start a new session", so the page offers the way to do it. */
			startNew: boolean;
			resume?: ResumeOffer;
	  };

type ModeSession = Pick<Session, "agentType" | "managedSession"> &
	Partial<
		Pick<
			Session,
			| "hostControl"
			| "ownerUserId"
			| "forkedFromSessionId"
			| "forkPermissionBranch"
			| "metadata"
			| "continuedFrom"
		>
	>;

export interface ComposerAccess {
	canPrompt: boolean;
	/** `sessionBindAccess`: stricter than prompting (an unowned session is an admin's alone in team mode). */
	canResume: boolean;
	/** A resume of this session is queued or running. */
	resumeInFlight?: boolean;
	/** For a continued Claude session: what the page knows of the session it came from. */
	source?: ForkSource;
}

export const RESUME_BUTTON = "Resume session";
export const END_SESSION_BUTTON = "End session";
export const RESUME_ANYWAY_BUTTON = "Resume anyway";
export const RESUME_ANYWAY_NOTE = "If you resume, Claude will remember that message.";
/** On a phone the box's hint sits behind this, so the timeline keeps its room. */
export const WHAT_WAITS_SUMMARY = "What waits for you";
export const RESUME_BUTTON_BUSY = "Resuming…";
export const RESUME_BUTTON_AGAIN = "Try resuming again";

const RESUME_LEAD_RESTARTED = "This session's process ended when its host restarted.";
const RESUME_LEAD_CONNECTION =
	"This session lost its connection to Codex, so it can't take prompts.";

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
/** A taken-over session was never launched, so its settings are the session's own. */
const CODEX_TAKEN_OVER: ComposerCopy = {
	...CODEX,
	hint: "This starts a new turn in the same Codex thread, under this session's approval policy and sandbox.",
};

/** What each prompt does in a continued Claude session, by the settings it runs under. Neither says "enforced". */
const CLAUDE_FORK_HINT = {
	ask: "Each prompt continues this conversation on {machine}. File changes and most commands wait for your approval here, unless your own Claude settings answer first. You can end this session from here; it can't be continued afterwards.",
	restricted:
		"Each prompt continues this conversation on {machine}. File changes and commands wait for your approval here, except read-only commands. You can end this session from here; it can't be continued afterwards.",
} as const;

function claudeForkCopy(session: ModeSession): ComposerCopy {
	const machine = session.managedSession?.hostName?.trim() || "its machine";
	// A fork that doesn't say its mode gets the wording that promises less.
	const mode = forkInfo(session)?.mode ?? "ask";
	return {
		hint: CLAUDE_FORK_HINT[mode].replace("{machine}", machine),
		placeholder: "What should Claude do next?",
		button: "Send prompt",
		side: "Replies and approval requests appear in this session.",
	};
}

const CLAUDE_FORK_DEGRADED_PEER =
	"Something else on {machine} sent this session a message, so AgentPulse stopped it.";

function blocked(reason: string, startNew = false, resume?: ResumeOffer): ComposerMode {
	return resume
		? { kind: "blocked", reason, startNew, resume }
		: { kind: "blocked", reason, startNew };
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

/**
 * A degraded Codex session whose thread is known can be resumed: its process is gone, the thread isn't. The
 * degraded reading is judged before the host's, so an offline host reaches a disabled Resume that points at
 * the offline sentence instead of hiding it. The old sentences stand for a session with no thread id.
 */
function degradedMode(session: ModeSession, access: ComposerAccess): ComposerMode {
	const managed = session.managedSession as NonNullable<ModeSession["managedSession"]>;
	const restarted = managed.providerSyncError === HOST_RESTARTED_SYNC_ERROR;
	const hostReason = codexHostReason(session);
	if (!managed.providerThreadId) {
		if (hostReason !== null) return blocked(hostReason);
		return restarted
			? blocked(COMPOSER_BLOCKED_RESTARTED, true)
			: blocked(COMPOSER_BLOCKED_CONNECTION, true);
	}
	if (access.resumeInFlight) {
		return blocked(`Asking ${hostNameOf(session)} to resume this session…`, false, {
			state: "in_flight",
		});
	}
	const lead = restarted ? RESUME_LEAD_RESTARTED : RESUME_LEAD_CONNECTION;
	if (!access.canResume) {
		if (hostReason !== null) return blocked(hostReason);
		const who = session.ownerUserId ? "its owner or an admin" : "an admin";
		return blocked(`${lead} Ask ${who} to resume it, or start a new session for this work.`, true);
	}
	if (session.hostControl?.state === "gone") return blocked(hostReason ?? "");
	if (hostReason !== null) {
		return blocked(
			`${hostNameOf(session)} is offline. You can resume this session when it's back.`,
			false,
			{
				state: "disabled",
			},
		);
	}
	return blocked(
		restarted
			? `${lead} Resume it to keep going, or start a new session for this work.`
			: `${lead} Resume it to reconnect, or start a new session to keep going.`,
		true,
		{ state: "available" },
	);
}

/**
 * A continued Claude session whose process is gone. The sentence follows why: a message something else sent
 * it, a change in how Claude was running, or an exit. Resume reopens it under the settings it started with;
 * after a stranger's message the person is offered ending it first, and only they see why.
 */
function degradedForkMode(session: ModeSession, access: ComposerAccess): ComposerMode {
	const managed = session.managedSession as NonNullable<ModeSession["managedSession"]>;
	const machine = managed.hostName?.trim() || "its machine";
	const error = managed.providerSyncError;
	const peer = error === CLAUDE_FORK_PEER_SYNC_ERROR;
	const hostReason = codexHostReason(session);
	if (access.resumeInFlight) {
		return blocked(`Asking ${hostNameOf(session)} to resume this session…`, false, {
			state: "in_flight",
		});
	}
	const source = access.source ?? { state: "unknown" as const };
	const lead = peer
		? CLAUDE_FORK_DEGRADED_PEER.replace("{machine}", machine)
		: error === CLAUDE_FORK_CHANGED_SYNC_ERROR
			? `Claude Code on ${machine} changed how it was running, so AgentPulse stopped it. Its last turn may not all be here.`
			: `Claude stopped running on ${machine}, so this session can't take prompts.`;
	if (!access.canResume) {
		if (hostReason !== null) return blocked(hostReason);
		const who = session.ownerUserId ? "its owner or an admin" : "an admin";
		// After a stranger's message the person to ask should look at it before anything else happens to it.
		return blocked(
			peer
				? `${lead} Ask ${who} to read the message, then end the session or resume it.`
				: `${lead} Ask ${who} to resume it.`,
		);
	}
	if (session.hostControl?.state === "gone") return blocked(hostReason ?? "");
	if (hostReason !== null) {
		return blocked(
			`${hostNameOf(session)} is offline. You can resume this session when it's back.`,
			false,
			{
				state: "disabled",
			},
		);
	}
	if (peer) {
		// The approvals card above says what the message was, when the server kept it; this stands on its own
		// for the person who has only this box: what stopped it, then the way to leave the message behind.
		return blocked(
			`AgentPulse stopped this session because something else on ${machine} sent it a message. To leave it behind, end this session and ${continueAgain(source)}.`,
			false,
			{ state: "available", afterPeerMessage: true },
		);
	}
	const tail =
		error === CLAUDE_FORK_CHANGED_SYNC_ERROR
			? " Resume it to keep going."
			: " Resume it to keep going. A running turn didn't finish, and a request that was waiting didn't run. A command you'd already approved may still be finishing there.";
	return blocked(`${lead}${tail}`, false, { state: "available" });
}

/** A continued Claude session's box: what its state allows (AGEN-117 T16). */
function forkComposerMode(session: ModeSession, access: ComposerAccess): ComposerMode | null {
	const managed = session.managedSession as NonNullable<ModeSession["managedSession"]>;
	if (CODEX_HIDDEN_STATES.has(managed.managedState)) return null;
	if (!access.canPrompt) return blocked(COMPOSER_BLOCKED_NOT_OWNER);
	if (managed.managedState === "degraded") return degradedForkMode(session, access);
	const hostReason = codexHostReason(session);
	if (hostReason !== null) return blocked(hostReason);
	if (managed.managedState === "managed") {
		return { kind: "claude_taken_over", ...claudeForkCopy(session) };
	}
	return blocked(COMPOSER_BLOCKED_NOT_READY_CLAUDE);
}

/** The box to show, or null when there should be none. */
export function composerMode(session: ModeSession, access: ComposerAccess): ComposerMode | null {
	const managed = session.managedSession;
	if (!managed) return null;
	if (session.agentType === "claude_code" && forkInfo(session) !== null) {
		return forkComposerMode(session, access);
	}
	if (session.agentType === "codex_cli") {
		if (CODEX_HIDDEN_STATES.has(managed.managedState)) return null;
		if (!access.canPrompt) return blocked(COMPOSER_BLOCKED_NOT_OWNER);
		if (managed.managedState === "degraded") return degradedMode(session, access);
		const hostReason = codexHostReason(session);
		if (hostReason !== null) return blocked(hostReason);
		if (managed.managedState === "managed") {
			return { kind: "codex", ...(isTakenOver(managed) ? CODEX_TAKEN_OVER : CODEX) };
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
 * How the composer watches the control action after the 202 (AGEN-91, AGEN-117 T16):
 *  - `settle`: until the host says how it ended. A Codex prompt and an interactive Claude prompt are done
 *    when the host hands them off, so "done" is a short wait.
 *  - `accept`: until the host reports it took the prompt on (`metadata.acceptedAt`, stamped only from the host's
 *    own report; a claim reads `running` too), not until the turn ends. A headless Claude action stays
 *    `running` for the whole turn (it reports only when its monitor resolves, and renews its lock), so a
 *    healthy long turn must not be waited out; but the host can refuse a second turn (one already running,
 *    the conversation open elsewhere), and without watching, that refusal would reach only Control history,
 *    collapsed on a phone, after the draft was gone. The box is read-only ("Sending…") until the action
 *    leaves `queued`; `running` clears the draft; `failed` keeps it and says why.
 *  - null: the 202 is the end of it.
 */
export type FollowMode = "settle" | "accept";

export function followModeOf(mode: ComposerMode | null): FollowMode | null {
	if (mode?.kind === "codex" || mode?.kind === "claude_interactive") return "settle";
	if (mode?.kind === "claude_headless" || mode?.kind === "claude_taken_over") return "accept";
	return null;
}

/** Whether the composer watches the control action after the 202 at all. */
export function followsAction(mode: ComposerMode | null): boolean {
	return followModeOf(mode) !== null;
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
	session: Pick<Session, "managedSession"> &
		Partial<Pick<Session, "agentType" | "forkedFromSessionId" | "metadata">>,
): { reason: string; startNew: boolean } {
	const refusal = hostRefusalMessage(error, session);
	if (refusal !== null) {
		const code = error instanceof ApiError ? error.code : null;
		return {
			reason: refusal,
			startNew: code === "managed_state_not_continuable" || code === "host_upgrade_required",
		};
	}
	// The slash refusal's words live with the AI tab's error table, which this page doesn't load: the same
	// sentence the server and the host use is named here.
	if (
		error instanceof ApiError &&
		error.code === "prompt_unsafe" &&
		(error.body as { reason?: unknown } | null)?.reason === "slash_command"
	) {
		return { reason: CLAUDE_FORK_SLASH_MESSAGE, startNew: false };
	}
	if (
		error instanceof ApiError &&
		(error.body as { reason?: unknown } | null)?.reason === "control_busy"
	) {
		return {
			reason:
				session.agentType !== "claude_code"
					? COMPOSER_BUSY
					: forkInfo(session) !== null
						? CLAUDE_FORK_BUSY_ERROR
						: COMPOSER_BUSY_CLAUDE,
			startNew: false,
		};
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

/** Where a continued session runs and what it continued, for the sentences a host can only say generally. */
export interface ForkFailureContext {
	machine: string | null | undefined;
	source: ForkSource;
}

/** The host's fixed sentences that say "this machine", mapped to the words with the machine's own name. */
const HOST_MACHINE_SENTENCES: readonly string[] = [
	CLAUDE_LOGIN_LOST_ERROR,
	CLAUDE_API_ERROR_MESSAGE,
	CLAUDE_FORK_TERMINAL_FOUND_ERROR,
	CLAUDE_FORK_CHECK_FAILED_ERROR,
	CLAUDE_FORK_NO_RUNTIME_ERROR,
];

/**
 * A continued session's failed prompt, worded here with the machine and the original's name. The host can't
 * know either, so it sends fixed sentences that say "this machine" and "the original session"; this keeps the
 * host's own text for anything it doesn't recognise and replaces only the two phrases in the ones it does.
 * A name never carries a backtick into a sentence (the sentence is drawn with its `code` spans).
 */
export function forkFailureSentence(error: string, ctx: ForkFailureContext): string {
	const machine = forkSentenceName(ctx.machine, "this machine");
	if (error === CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR) {
		const head = "Claude didn't start the way AgentPulse expected, so it was stopped.";
		return sourceUnavailable(ctx.source)
			? `${head} Start a new session to try again.`
			: `${head} Continue ${sourceLabel(ctx.source)} in a new session to try again.`;
	}
	if (HOST_MACHINE_SENTENCES.includes(error)) return error.replaceAll("this machine", machine);
	return error;
}

/** What the box does with a finished follow; null when the follow was abandoned and nothing should change. */
export function settleFollow(
	result: FollowOutcome,
	ctx?: ForkFailureContext,
): { phase: SendPhase; clearDraft: boolean } | null {
	switch (result.outcome) {
		case "succeeded":
			return { phase: { step: "idle" }, clearDraft: true };
		case "failed": {
			const host = cleanHostText(result.error);
			return {
				phase: {
					step: "failed",
					reason:
						host === null ? COMPOSER_FAILED_FALLBACK : ctx ? forkFailureSentence(host, ctx) : host,
					startNew: false,
				},
				clearDraft: false,
			};
		}
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

/** Puts focus back in the box after a send settles, except on a touch screen. */
export function focusBoxAfterSettle(
	box: { focus: () => void } | null,
	matchMedia: ((query: string) => { matches: boolean }) | undefined,
): void {
	if (box && shouldRefocusBox(matchMedia)) box.focus();
}

/** The reason to show in place of the box (with the way to a new session, and Resume when it is offered), or null when the box itself shows. */
export function lockedNotice(
	mode: ComposerMode | null,
	hasDraft: boolean,
): { reason: string; startNew: boolean; resume?: ResumeOffer } | null {
	if (mode === null) return hasDraft ? { reason: COMPOSER_ENDED, startNew: false } : null;
	if (mode.kind !== "blocked") return null;
	return mode.resume
		? { reason: mode.reason, startNew: mode.startNew, resume: mode.resume }
		: { reason: mode.reason, startNew: mode.startNew };
}

/**
 * A refusal or failure from POST /resume, as the sentence to show and whether it ends in "start a new
 * session" (the page then offers the way to do it). The wording is the recovery's: it names the session's
 * host and never offers another machine, since a managed session has only the one it ran on.
 */
export function describeResumeFailure(
	error: unknown,
	session: Pick<Session, "managedSession"> & Partial<Pick<Session, "agentType">>,
	opts: { sourceName?: string | null } = {},
): { reason: string; startNew: boolean } {
	const reason = bindRefusalMessage(error, {
		host: session.managedSession?.hostName ?? null,
		kind: "recovery",
		agent: session.agentType === "claude_code" ? "claude_code" : "codex_cli",
		sourceName: opts.sourceName ?? null,
	});
	return { reason, startNew: offersNewSession(reason) };
}

/** Whether a sentence sends the person to a new session, which the page backs with a link to Templates. */
export function offersNewSession(sentence: string): boolean {
	return /start a new session/i.test(sentence);
}

export const FOLLOW_POLL_MS = 1500;
/** The 90 s control lock plus margin. */
export const FOLLOW_DEADLINE_MS = 100_000;

export interface FollowDeps {
	/** `accept` stops at the host taking the action; the default waits for its end. */
	until?: FollowMode;
	fetchActions: (
		sessionId: string,
		opts: { background: true },
	) => Promise<{ controlActions: ControlAction[] }>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}

/**
 * Polls one control action until it settles (or, for `until: "accept"`, until the host has taken it). Bound
 * to the session it started with: an action row that belongs to another session is never read. A failed poll is not the action's failure; it is tried again.
 * An action whose lock ran out before the host reported has an unknown outcome (the prompt may have run).
 */
export async function followPromptAction(
	sessionId: string,
	actionId: string,
	deps: FollowDeps,
): Promise<FollowOutcome> {
	const startedAt = deps.now();
	let lastStatus: ControlAction["status"] | null = null;
	for (;;) {
		if (deps.signal?.aborted) return { outcome: "aborted" };
		try {
			const { controlActions } = await deps.fetchActions(sessionId, { background: true });
			if (deps.signal?.aborted) return { outcome: "aborted" };
			const action = controlActions.find((a) => a.id === actionId && a.sessionId === sessionId);
			if (action?.status === "succeeded") return { outcome: "succeeded" };
			lastStatus = action?.status ?? lastStatus;
			// Taken by the host: its own acceptance report stamps `acceptedAt`. A claim also reads `running`, and a
			// host can still refuse the prompt after it (a turn already going, the conversation open elsewhere),
			// so `running` alone is not acceptance.
			if (
				deps.until === "accept" &&
				action?.status === "running" &&
				typeof (action.metadata as Record<string, unknown> | null)?.acceptedAt === "string"
			) {
				return { outcome: "succeeded" };
			}
			if (action?.status === "failed") {
				return action.error === CONTROL_TIMEOUT_ERROR
					? { outcome: "unknown" }
					: { outcome: "failed", error: action.error };
			}
		} catch {
			// The next poll will say; a dropped request is not the host's answer.
		}
		if (deps.now() - startedAt >= FOLLOW_DEADLINE_MS) {
			// A host that never sends an acceptance (one older than this server) leaves a claimed prompt reading
			// `running`: after the deadline that is taken as the old behaviour, accepted. An action nobody
			// claimed in that time is genuinely unknown.
			return deps.until === "accept" && lastStatus === "running"
				? { outcome: "succeeded" }
				: { outcome: "unknown" };
		}
		await deps.sleep(FOLLOW_POLL_MS);
	}
}
