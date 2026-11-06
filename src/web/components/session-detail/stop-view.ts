/**
 * What Stop means on the session page (AGEN-110): which sessions offer it, what the confirmation says, and
 * when a stop is already on its way. Pure functions, so every rule is tested without rendering. Display only:
 * the server queues the stop, the host decides whether it can run it, and a terminal launch is refused there.
 *
 * Stop ends different things. A Codex session's stop closes its thread, and a launched Claude session's stop
 * ends the turn it is running (the next prompt starts a new process), so the words differ.
 */
import { cleanHostText } from "../../../shared/clean-host-text.js";
import { CONTROL_TIMEOUT_ERROR } from "../../../shared/managed-messages.js";
import { STOP_NOT_SUPPORTED, STOP_NOT_SUPPORTED_MESSAGE } from "../../../shared/stop-runtime.js";
import type { ControlAction, Session } from "../../../shared/types.js";
import { describeApiError } from "../../lib/api-errors.js";
import { ApiError } from "../../lib/api.js";
import { parseDate } from "../../lib/utils.js";
import { hostNameOf, hostRefusalMessage } from "./host-control-view.js";

/** Claude states with a process this host can stop. A terminal launch has none, so it offers no button. */
const CLAUDE_STOPPABLE_STATES: ReadonlySet<string> = new Set(["headless", "managed"]);

export function canStopSession(session: Pick<Session, "agentType" | "managedSession">): boolean {
	const state = session.managedSession?.managedState;
	if (state === undefined) return false;
	if (session.agentType === "codex_cli") return state === "managed";
	if (session.agentType === "claude_code") return CLAUDE_STOPPABLE_STATES.has(state);
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

export function stopConfirmCopy(
	session: Pick<Session, "agentType"> & Partial<Pick<Session, "isWorking">>,
): StopConfirmCopy {
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
export function stopControlLabel(session: Pick<Session, "agentType">): string {
	return session.agentType === "claude_code" ? "Stop turn" : "Stop session";
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
	`${agent} is still handling the last request, so it couldn't be stopped yet. Try again in a moment.`;

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
