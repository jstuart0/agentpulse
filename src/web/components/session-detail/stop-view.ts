/**
 * What Stop means on the session page (AGEN-110): which sessions offer it, what the confirmation says, and
 * when a stop is already on its way. Pure functions, so every rule is tested without rendering. Display only:
 * the server queues the stop, the host decides whether it can run it, and a terminal launch is refused there.
 *
 * Stop ends different things. A Codex session's stop closes its thread, and a launched Claude session's stop
 * ends the turn it is running (the next prompt starts a new process), so the words differ.
 */
import { forkSentenceName } from "../../../shared/claude-fork-copy.js";
import { cleanHostText } from "../../../shared/clean-host-text.js";
import { CONTROL_TIMEOUT_ERROR } from "../../../shared/managed-messages.js";
import { STOP_NOT_SUPPORTED, STOP_NOT_SUPPORTED_MESSAGE } from "../../../shared/stop-runtime.js";
import { SESSION_ENDED_FIRST, TURN_ALREADY_ENDED } from "../../../shared/stop-turn.js";
import type { ControlAction, Session } from "../../../shared/types.js";
import { describeApiError } from "../../lib/api-errors.js";
import { ApiError } from "../../lib/api.js";
import {
	type ForkSource,
	KEEP_WORKING_GONE,
	continueAgain,
	isFork,
	sourceUnavailable,
} from "../../lib/fork-session.js";
import { parseDate } from "../../lib/utils.js";
import { hostNameOf, hostRefusalMessage } from "./host-control-view.js";

/** Claude states with a process this host can stop. A terminal launch has none, so it offers no button. */
const CLAUDE_STOPPABLE_STATES: ReadonlySet<string> = new Set(["headless", "managed"]);

type ForkAware = Partial<Pick<Session, "forkedFromSessionId" | "metadata">>;

export function canStopSession(
	session: Pick<Session, "agentType" | "managedSession"> & ForkAware,
): boolean {
	const state = session.managedSession?.managedState;
	if (state === undefined) return false;
	if (session.agentType === "codex_cli") return state === "managed";
	if (session.agentType === "claude_code") {
		// A continued session can be ended while its process is gone too: the host checks nothing still runs.
		if (state === "degraded" && isFork(session)) return true;
		return CLAUDE_STOPPABLE_STATES.has(state);
	}
	return false;
}

export interface StopConfirmCopy {
	title: string;
	body: string;
	confirmLabel: string;
}

const CLAUDE_LAUNCHED_COPY: StopConfirmCopy = {
	title: "Stop this turn?",
	body: "Claude stops now. Anything it left running in the background may keep running. Files already changed stay changed. You can send another prompt to carry on.",
	confirmLabel: "Stop turn",
};

const CODEX_COPY: StopConfirmCopy = {
	title: "Stop this session?",
	body: "Codex stops now and this session can't take more prompts. To keep working, start a new session. Anything it left running in the background may keep running. Files already changed stay changed.",
	confirmLabel: "Stop session",
};

/**
 * A launched Claude with no turn running: Stop is still offered (it repairs a session whose final report
 * was lost, and ends anything left running for it), but "this turn" would be a lie, so the words don't say it.
 */
const CLAUDE_IDLE_COPY: StopConfirmCopy = {
	title: "Stop Claude?",
	body: "Claude isn't working on anything right now. Stopping ends any Claude process still running for this session and clears a status that may be out of date. Programs it started in the background may keep running, and files it changed stay changed. You can send another prompt to carry on.",
	confirmLabel: "Stop",
};

/** Ending a continued session: it can't be continued afterwards, and the original is how to carry on. */
function forkEndCopy(name: string, source: ForkSource): StopConfirmCopy {
	const carryOn = sourceUnavailable(source)
		? KEEP_WORKING_GONE
		: `To keep working, ${continueAgain(source).replace(/ again$/, "")}; that starts from your terminal's conversation and won't include what happened here.`;
	return {
		title: `End ${forkSentenceName(name, "this session")}?`,
		body: `Claude stops now and this session can't be continued. Anything it left running in the background may keep running. Files already changed stay changed. ${carryOn}`,
		confirmLabel: "End session",
	};
}

export function stopConfirmCopy(
	session: Pick<Session, "agentType"> & Partial<Pick<Session, "isWorking">> & ForkAware,
	fork?: { name: string; source: ForkSource },
): StopConfirmCopy {
	if (session.agentType === "claude_code" && isFork(session)) {
		return forkEndCopy(fork?.name ?? "this session", fork?.source ?? { state: "unknown" });
	}
	if (session.agentType !== "claude_code") return CODEX_COPY;
	return session.isWorking === false ? CLAUDE_IDLE_COPY : CLAUDE_LAUNCHED_COPY;
}

/** True while a stop is queued or running: the server's own record, so it survives a reload. */
export function stopInFlight(
	actions: readonly Pick<ControlAction, "actionType" | "status">[],
): boolean {
	return actions.some(
		(action) =>
			action.actionType === "stop" && (action.status === "queued" || action.status === "running"),
	);
}

/** The name of the agent a stop is about, for sentences. */
function agentName(session: Pick<Session, "agentType">): string {
	return session.agentType === "claude_code" ? "Claude" : "Codex";
}

/** The label of the stop control where there's no room for a sentence (the overflow menu). */
export function stopControlLabel(session: Pick<Session, "agentType"> & ForkAware): string {
	if (session.agentType === "claude_code") return isFork(session) ? "End session" : "Stop turn";
	return "Stop session";
}

/** The host's name as the host reported it, or null when it is blank (no "on ..." is better than a made-up one). */
function reportedHostName(session: Pick<Session, "managedSession">): string | null {
	return session.managedSession?.hostName?.trim() || null;
}

/** The line shown while a stop is in flight; the box and the Stop button are off meanwhile. */
export function stoppingText(session: Pick<Session, "agentType" | "managedSession">): string {
	const host = reportedHostName(session);
	return `Stopping ${agentName(session)}${host ? ` on ${host}` : ""}…`;
}

/** Why Stop is off for someone who may not change this session (the same owner-or-admin rule as the composer). */
export const STOP_NOT_OWNER_REASON = "Only the owner or an admin can stop this session.";

const CONTROL_BUSY_REASON = (agent: string) =>
	`${agent} is still handling the last request, so it couldn't be stopped yet. Try again when it finishes its current turn.`;

const NOTHING_TO_STOP_REASON = "This session has already ended, so there is nothing to stop.";

const STOP_FAILED_FALLBACK = "The stop didn't finish. Try again.";

/**
 * The sentence for a stop the server refused, or null when the usual text should stand. The codes that
 * mean something specific to a stop are read first; the host refusals (offline, gone) fall through to the
 * shared table.
 */
export function stopRefusalMessage(
	error: unknown,
	session: Pick<Session, "agentType" | "managedSession">,
): string | null {
	if (error instanceof ApiError) {
		const agent = agentName(session);
		if (error.code === "control_busy") return CONTROL_BUSY_REASON(agent);
		if (error.code === "nothing_to_stop") return NOTHING_TO_STOP_REASON;
		if (error.code === STOP_NOT_SUPPORTED) return STOP_NOT_SUPPORTED_MESSAGE;
		if (error.status === 409 && error.code === "host_upgrade_required") {
			// For a stop the only upgrade that can be missing is the Claude one.
			return `${hostNameOf(session)} is running an older supervisor that can't stop Claude sessions. Update it, then try again.`;
		}
	}
	return hostRefusalMessage(error, session);
}

/** What `performStop` shows when the request itself failed. */
export function stopRequestFailure(
	error: unknown,
	session: Pick<Session, "agentType" | "managedSession">,
): string {
	return (
		stopRefusalMessage(error, session) ?? describeApiError(error, "Couldn't stop the session.")
	);
}

/**
 * The newest control action is a stop that failed: the standing alert near the composer, until something
 * newer happens (another stop, a prompt). Derived from the actions, so a reload or another tab still shows it.
 */
type ActionLike = Pick<ControlAction, "actionType" | "status" | "error" | "createdAt">;

/** The newest control action of any kind, or null. */
function newestAction<T extends ActionLike>(actions: readonly T[]): T | null {
	let newest: T | null = null;
	for (const action of actions) {
		if (newest === null || action.createdAt > newest.createdAt) newest = action;
	}
	return newest;
}

/** The newest control action is a stop that went through: what "Stopped." is announced for. */
export function stopSucceeded(actions: readonly ActionLike[]): boolean {
	const newest = newestAction(actions);
	return newest?.actionType === "stop" && newest.status === "succeeded";
}

const TERMINAL_MANAGED_STATES: ReadonlySet<string> = new Set(["stopped", "completed", "failed"]);

/** The session ended after `createdAt`: a stop that failed before that is history, not news. */
function endedSince(
	session: Pick<Session, "managedSession"> & Partial<Pick<Session, "endedAt">>,
	createdAt: string,
): boolean {
	const since = parseDate(createdAt);
	if (Number.isNaN(since)) return false;
	if (session.endedAt && parseDate(session.endedAt) > since) return true;
	const managed = session.managedSession;
	return (
		managed !== null &&
		managed !== undefined &&
		TERMINAL_MANAGED_STATES.has(managed.managedState) &&
		parseDate(managed.updatedAt) > since
	);
}

export function stopFailureText(
	session: Pick<Session, "agentType" | "managedSession"> & Partial<Pick<Session, "endedAt">>,
	actions: readonly ActionLike[],
): string | null {
	const newest = newestAction(actions);
	if (newest === null || newest.actionType !== "stop" || newest.status !== "failed") return null;
	if (endedSince(session, newest.createdAt)) return null;
	if (newest.error === CONTROL_TIMEOUT_ERROR) {
		const host = reportedHostName(session);
		return `${host ?? "This session's host"} didn't confirm the stop. ${agentName(session)} may still be running.`;
	}
	return cleanHostText(newest.error) ?? STOP_FAILED_FALLBACK;
}

// ── Stop turn (AGEN-119) ────────────────────────────────────────────────────

/** The words of the prompt box's Stop turn control, and of what the page says around it. */
export const STOP_TURN_LABEL = "Stop turn";
export const STOPPING_TURN_LABEL = "Stopping turn…";
export const STOP_TURN_NOTICE =
	"Claude is working. Stop turn ends what it's doing; the session stays open.";
export const STOP_TURN_ANNOUNCE_START = "Stopping the turn…";
export const STOP_TURN_ANNOUNCE_DONE = "Turn stopped. You can send a prompt.";
const STOP_TURN_ANNOUNCE_ALREADY = "Claude had already finished the turn.";
const STOP_TURN_FAILED_FALLBACK = "The turn didn't stop. Try again, or end the session.";

type InFlightAction = Pick<ControlAction, "actionType" | "status">;

/** The turn a continued Claude session is running: its newest prompt action, while the host reports it `running`. */
export function runningForkTurn<T extends InFlightAction & Pick<ControlAction, "createdAt">>(
	session: ForkAware & Pick<Session, "agentType">,
	actions: readonly T[],
): T | null {
	if (session.agentType !== "claude_code" || !isFork(session)) return null;
	let newest: T | null = null;
	for (const action of actions) {
		if (action.actionType !== "prompt") continue;
		if (newest === null || action.createdAt > newest.createdAt) newest = action;
	}
	return newest?.status === "running" ? newest : null;
}

/**
 * Whether the prompt box offers Stop turn in place of Send: a continued Claude session whose prompt the host is
 * running, for someone who may change the session, on a server that advertises `claudeStopTurn`. A stop of the
 * whole session in flight takes the box instead ("Stopping Claude..."). Display only: the server decides.
 */
export function canStopTurn(
	session: ForkAware & Pick<Session, "agentType" | "managedSession">,
	actions: readonly (InFlightAction & Pick<ControlAction, "createdAt">)[],
	access: { mayChange: boolean; advertised: boolean },
): boolean {
	if (!access.mayChange || !access.advertised) return false;
	if (stopInFlight(actions)) return false;
	return runningForkTurn(session, actions) !== null;
}

/** True while a Stop turn is queued or running: the server's own record, so it survives a reload. */
export function stopTurnInFlight(actions: readonly InFlightAction[]): boolean {
	return actions.some(
		(a) => a.actionType === "interrupt" && (a.status === "queued" || a.status === "running"),
	);
}

/** What `stopTurnRefusalMessage` says per code (F47). `no_turn_running` is information, not an error. */
export function stopTurnRefusalMessage(
	error: unknown,
	session: Pick<Session, "managedSession">,
): string | null {
	if (error instanceof ApiError) {
		switch (error.code) {
			case "no_turn_running":
				return STOP_TURN_ANNOUNCE_ALREADY;
			case "interrupt_not_supported":
				return "This session can't stop a turn and stay open. Use End session instead.";
			case "host_upgrade_required":
				return `${hostNameOf(session)} is running an older supervisor that can't stop a turn. Update it, or end the session.`;
			case "not_owner":
				return "Only the owner or an admin can stop this turn.";
			case "launch_mismatch":
			case "not_managed":
				return "This session can't be stopped from here.";
			case "rate_limited":
				return "Too many stops in a minute. Try again shortly.";
		}
	}
	return hostRefusalMessage(error, session);
}

/** What the page shows when the Stop turn request itself failed. */
export function stopTurnRequestFailure(
	error: unknown,
	session: Pick<Session, "managedSession">,
): string {
	return (
		stopTurnRefusalMessage(error, session) ?? describeApiError(error, STOP_TURN_FAILED_FALLBACK)
	);
}

/** The newest control action is a Stop turn that went through. */
export function stopTurnSucceeded(actions: readonly ActionLike[]): boolean {
	const newest = newestAction(actions);
	return newest?.actionType === "interrupt" && newest.status === "succeeded";
}

/** The newest Stop turn ended because the turn had already finished by itself: it ran, and found nothing to stop. */
export function stopTurnFoundNothing(
	actions: readonly (ActionLike & Pick<ControlAction, "metadata">)[],
): boolean {
	const newest = newestAction(actions);
	return (
		newest?.actionType === "interrupt" &&
		newest.status === "succeeded" &&
		(newest.metadata as Record<string, unknown> | null)?.interrupted === false
	);
}

/**
 * The newest control action is a Stop turn that failed: the standing alert near the composer, until something
 * newer happens. A turn that had already ended, or a session that was ended first, is not a failure to show.
 */
export function stopTurnFailureText(actions: readonly ActionLike[]): string | null {
	const newest = newestAction(actions);
	if (newest === null || newest.actionType !== "interrupt" || newest.status !== "failed") {
		return null;
	}
	if (newest.error === TURN_ALREADY_ENDED || newest.error === SESSION_ENDED_FIRST) return null;
	if (newest.error === CONTROL_TIMEOUT_ERROR) {
		return "The host didn't confirm the stop. The turn may still be running.";
	}
	return cleanHostText(newest.error) ?? STOP_TURN_FAILED_FALLBACK;
}

/** The sentence spoken when a followed Stop turn settles; null when it should stay quiet. */
export function stopTurnSettledText(
	actions: readonly (ActionLike & Pick<ControlAction, "metadata">)[],
): string | null {
	const failure = stopTurnFailureText(actions);
	if (failure !== null) return failure;
	if (!stopTurnSucceeded(actions)) return null;
	return stopTurnFoundNothing(actions) ? STOP_TURN_ANNOUNCE_ALREADY : STOP_TURN_ANNOUNCE_DONE;
}
