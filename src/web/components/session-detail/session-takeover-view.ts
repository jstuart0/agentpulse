/**
 * What the take-over and resume flows decide for the session page (AGEN-115): where an attempt stands, what
 * sits in the prompt box's slot, the labels on a taken-over session, and the sentence for every refusal. Pure
 * functions, so every rule is tested without rendering. Display only: the server decides who may take a
 * session over, on which machine, and whether it has ended. The refusal codes and the host's failure
 * sentences come from `shared/session-resume.ts`, the one place both the server and the web read them.
 * The card's own rules (eligibility, the machines, the dialog) are in takeover-card-view.ts, which only the
 * card's lazy chunk loads.
 *
 * The user-facing word is "take over" (an observed session) and "resume" (a managed one whose process is gone).
 */
import { cleanHostText } from "../../../shared/clean-host-text.js";
import {
	type ResumeKind,
	TAKEOVER_IN_PROGRESS_MESSAGE,
	hostCannotRunCodexMessage,
	resumeFailureMessage,
} from "../../../shared/session-resume.js";
import type { ControlAction, Session } from "../../../shared/types.js";
import { registerApiErrorMessages } from "../../lib/api-errors.js";
import { ApiError } from "../../lib/api.js";

export const TAKEOVER_FAILURE_FALLBACK = "That machine couldn't take this session over. Try again.";
export const TAKEOVER_NOT_ADMIN = "Only an admin can take over a session with no owner.";

// ── The attempt ─────────────────────────────────────────────────────────────

export type TakeoverAttempt =
	| { state: "none" }
	| { state: "in_flight"; actionId: string; kind: ResumeKind; startedAt: string }
	| { state: "failed"; actionId: string; kind: ResumeKind; reason: string };

function kindOf(action: ControlAction): ResumeKind {
	return (action.metadata as { resumeKind?: unknown } | null)?.resumeKind === "recovery"
		? "recovery"
		: "takeover";
}

function byAge(a: ControlAction, b: ControlAction): number {
	return a.createdAt === b.createdAt
		? a.id.localeCompare(b.id)
		: a.createdAt < b.createdAt
			? -1
			: 1;
}

/**
 * Where a take-over or resume stands, from the session's `resume` control actions and nothing else. The
 * server keeps the action row after a failure (the rows it created are undone, the action is not), so this
 * survives a reload, a poll that lands mid-attempt, and another tab. A queued or running action is in flight;
 * otherwise the newest one decides: failed is a failure carrying the host's own sentence, succeeded is none.
 */
export function takeoverAttempt(actions: readonly ControlAction[]): TakeoverAttempt {
	const resumes = actions.filter((a) => a.actionType === "resume").sort(byAge);
	const open = resumes.filter((a) => a.status === "queued" || a.status === "running").pop();
	if (open) {
		return { state: "in_flight", actionId: open.id, kind: kindOf(open), startedAt: open.createdAt };
	}
	const newest = resumes[resumes.length - 1];
	if (newest?.status === "failed") {
		return {
			state: "failed",
			actionId: newest.id,
			kind: kindOf(newest),
			reason: cleanHostText(newest.error) ?? TAKEOVER_FAILURE_FALLBACK,
		};
	}
	return { state: "none" };
}

/**
 * What to announce to a screen reader when an attempt that was in flight ends. `role="alert"` on a node that
 * mounts with its text can go unannounced, so the page speaks through its live region as well. Silence when
 * nothing ended: a first look at a failed attempt is not news.
 */
export function attemptAnnouncement(
	previous: TakeoverAttempt,
	next: TakeoverAttempt,
	hostName: string | null,
): string | null {
	if (previous.state !== "in_flight") return null;
	if (next.state === "failed") return next.reason;
	if (next.state !== "none") return null;
	const host = hostName?.trim();
	return previous.kind === "takeover"
		? `${host || "The host"} took over this session. You can send a prompt now.`
		: `Session resumed on ${host || "the host"}. You can send a prompt now.`;
}

// ── Refusals ────────────────────────────────────────────────────────────────

const UNREADABLE_REQUEST = "AgentPulse couldn't read that request. Reload the page and try again.";
const UNREACHABLE = "Couldn't reach AgentPulse. Check your connection and try again.";

type RefusalWords = (host: string, kind: ResumeKind) => string;

const RETRY_NOT_AVAILABLE =
	"This session was taken over, not launched, so it can't be retried. Send it a prompt, or start a new session.";
// The retry route's refusal is read by whatever calls it, so it joins the shared table with the rest of this feature.
registerApiErrorMessages({ retry_not_available: RETRY_NOT_AVAILABLE });

const RECOVERY_NOT_OWNER = "Only the session's owner or an admin can resume it.";
const TAKEOVER_NOT_OWNER = "Only this session's owner or an admin can take it over.";

/** One sentence per code the take-over and resume routes (and the delete, archive and retry routes they guard) answer. */
const REFUSALS: Record<string, RefusalWords> = {
	session_active: () =>
		"This session looks active: AgentPulse heard from it in the last 5 minutes, or it hasn't finished a turn. Exit it there and try again in a few minutes. A session that crashed becomes available about an hour after its last activity.",
	already_managed: () =>
		"AgentPulse already has a record of running this session, so it can't be taken over.",
	session_id_unsupported: () =>
		"This session's ID isn't in a form AgentPulse can resume, so it can't be taken over.",
	agent_not_supported: () => "AgentPulse can only take over Codex sessions for now.",
	cwd_unknown: () => "This session never reported a directory, so it can't be taken over.",
	cwd_not_trusted: (host) =>
		`${host} doesn't allow this session's directory. Its trusted roots are listed on Hosts.`,
	host_owner_mismatch: (host) =>
		`${host} belongs to someone other than this session's owner. Change the session's owner first, or choose a host of theirs.`,
	host_not_allowed: () => "You can't use that machine. Choose one of your own, or ask an admin.",
	not_owner: (_host, kind) => (kind === "recovery" ? RECOVERY_NOT_OWNER : TAKEOVER_NOT_OWNER),
	session_not_found: () => "This session isn't available.",
	host_offline: (host, kind) =>
		kind === "recovery"
			? `${host} is offline, so nothing was started. Try again when it's back.`
			: `${host} is offline, so nothing was started. Try again when it's back, or choose another machine.`,
	host_gone: (host, kind) =>
		kind === "recovery"
			? `${host} was removed from AgentPulse, so this session can't be resumed. Start a new session for this work.`
			: `${host} was removed from AgentPulse. Choose another machine.`,
	host_upgrade_required: (host, kind) => resumeFailureMessage("host_upgrade_required", host, kind),
	host_cannot_run_codex: (host, kind) => hostCannotRunCodexMessage(host, kind),
	session_key_mismatch: (host) =>
		`This session was reported by a key that isn't tied to ${host}. Ask an admin to take it over.`,
	rate_limited: () => "Too many attempts. Try again in a minute.",
	takeover_in_progress: () => TAKEOVER_IN_PROGRESS_MESSAGE,
	human_required: (_host, kind) =>
		kind === "recovery"
			? "Resuming a session needs a signed-in person, not an API key."
			: "Taking over a session needs a signed-in person, not an API key.",
	retry_not_available: () => RETRY_NOT_AVAILABLE,
	not_resumable: (host, kind) => resumeFailureMessage("thread_unverified", host, kind),
	invalid_body: () => UNREADABLE_REQUEST,
	payload_too_large: () => UNREADABLE_REQUEST,
	unsupported_media_type: () => UNREADABLE_REQUEST,
};

/**
 * What to tell the person when POST /bind or POST /resume is refused or fails. The code decides; the host
 * (when one was chosen, or the session's own) names the machine; an unknown code or a network failure gets a
 * plain sentence of its own, never the code or a stack.
 */
export function bindRefusalMessage(
	error: unknown,
	ctx: { host: string | null; kind: ResumeKind },
): string {
	const host = ctx.host?.trim() || "That machine";
	if (error instanceof ApiError) {
		if (error.code !== null && Object.hasOwn(REFUSALS, error.code)) {
			return (REFUSALS[error.code] as RefusalWords)(host, ctx.kind);
		}
		return ctx.kind === "takeover"
			? TAKEOVER_FAILURE_FALLBACK
			: "That machine couldn't resume this session. Try again.";
	}
	return UNREACHABLE;
}

// ── Where it sits on the page ───────────────────────────────────────────────

export type BottomSlot = "composer" | "takeover" | "takeover_progress";

/**
 * What sits where the prompt box would. A takeover in flight shows its progress whatever the managed session
 * says (a `pending` row appears mid-attempt, and the card's state, with a failure's reason, must not go with
 * it). A recovery in flight keeps the composer's slot, which holds the person's draft.
 */
export function bottomSlot(
	session: Pick<Session, "managedSession">,
	attempt: TakeoverAttempt,
): BottomSlot {
	if (attempt.state === "in_flight" && attempt.kind === "takeover") return "takeover_progress";
	return session.managedSession ? "composer" : "takeover";
}

/** The standing status hint ("Managed Codex", a pending pill) waits while a takeover works, so no state is said twice. */
export function showsStatusHint(attempt: TakeoverAttempt): boolean {
	return !(attempt.state === "in_flight" && attempt.kind === "takeover");
}

// ── Labels on a taken-over session ──────────────────────────────────────────

export const TAKEN_OVER_AFFINITY = "taken_over";

export function isTakenOver(
	managedSession: { hostAffinityReason?: string | null } | null | undefined,
): boolean {
	return managedSession?.hostAffinityReason === TAKEN_OVER_AFFINITY;
}

/**
 * The Overview's "who" field. A launched session names the launch's requester. On a taken-over session the
 * launch row's requester is the session's owner (the row exists so they can read it), so the person who took
 * it over is read from the row's metadata instead; with none recorded the field is left out rather than
 * crediting the owner.
 */
export function overviewOriginField(
	takenOver: boolean,
	launch: { requestedByUserId: string | null; metadata: Record<string, unknown> | null },
	agentType?: string | null,
): { label: "Launched by" | "Taken over by" | "Continued by"; userId: string } | null {
	if (takenOver) {
		const bound = launch.metadata?.boundByUserId;
		// A Claude Code session is continued in a new session, never taken over (AGEN-117).
		const label = agentType === "claude_code" ? "Continued by" : "Taken over by";
		return typeof bound === "string" && bound !== "" ? { label, userId: bound } : null;
	}
	return launch.requestedByUserId
		? { label: "Launched by", userId: launch.requestedByUserId }
		: null;
}

/** The Launch tab's one-line summary: a taken-over session was never launched, so its carrier row isn't "completed". */
export function launchSummaryLine(
	takenOver: boolean,
	status: string,
	modeLabel: string,
	agentType?: string | null,
): string {
	if (!takenOver) return `${status} · ${modeLabel}`;
	return agentType === "claude_code" ? "Continued · Claude" : "Taken over · Codex";
}

export type SentencePart = { code: boolean; text: string };

/**
 * A host sentence cut at its backtick spans, so the web can draw a command as code. Text only: no part is
 * ever markup, and an unpaired backtick stays an ordinary character.
 */
export function sentenceParts(sentence: string): SentencePart[] {
	const parts: SentencePart[] = [];
	let rest = sentence;
	for (;;) {
		const match = /`([^`]+)`/.exec(rest);
		if (!match) break;
		if (match.index > 0) parts.push({ code: false, text: rest.slice(0, match.index) });
		parts.push({ code: true, text: match[1] as string });
		rest = rest.slice(match.index + match[0].length);
	}
	if (rest !== "") parts.push({ code: false, text: rest });
	return parts;
}

/** The link to the launch row's page. A taken-over session was never launched, so its row is "details". */
export function launchLinkLabel(
	managedSession: { hostAffinityReason?: string | null } | null | undefined,
): "View launch" | "View details" {
	return isTakenOver(managedSession) ? "View details" : "View launch";
}

/**
 * What Control history calls an action. A resume that took a session over says "take over"; every other
 * action, a recovery's resume included, keeps its type's own word.
 */
export function controlActionLabel(action: Pick<ControlAction, "actionType" | "metadata">): string {
	return action.actionType === "resume" &&
		(action.metadata as { resumeKind?: unknown } | null)?.resumeKind === "takeover"
		? "take over"
		: action.actionType;
}
