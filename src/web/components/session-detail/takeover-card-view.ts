/**
 * What the take-over card, its dialog and the machine list say and offer (AGEN-115). Pure functions, so every
 * sentence and every rule is tested without rendering. Everything here is display: the server decides. Loaded
 * only by the card's lazy chunk; the rules the session page itself needs are in session-takeover-view.ts.
 */
import { cleanHostText } from "../../../shared/clean-host-text.js";
import { SESSION_END_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from "../../../shared/constants.js";
import {
	CLAUDE_TAKEOVER,
	RESUMES_SESSIONS,
	type ResumeKind,
} from "../../../shared/session-resume.js";
import { parseStoredTimestamp } from "../../../shared/timestamp.js";
import type { Session, SupervisorRecord } from "../../../shared/types.js";
import type { OwnershipUi } from "../../lib/ownership-ui.js";
import {
	CLAUDE_CARD_ELIGIBLE,
	CLAUDE_ENTRY_BUTTON,
	CLAUDE_HOST_SUFFIX,
	CLAUDE_NOT_ADMIN,
	CLAUDE_NO_HOST_SOLO,
	CLAUDE_NO_HOST_TEAM,
	CLAUDE_QUIET_WAIT,
	claudeHostReason,
	claudeProgress,
	claudeStaleWorking,
} from "./claude-takeover-copy.js";
import {
	type ResumeAgent,
	TAKEOVER_NOT_ADMIN,
	type TakeoverAttempt,
} from "./session-takeover-view.js";

/** A session working or waiting is taken to have crashed once it has been silent this long (the server's sweep). */
const CRASHED_AFTER_MS = 2 * SESSION_END_TIMEOUT_MS;
const STILL_WAITING_AFTER_MS = 20_000;
const THE_HOST = "the host";

export const TAKEOVER_QUIET_WAIT =
	"You can take this session over here once it's been quiet for 5 minutes.";
export const TAKEOVER_ELIGIBLE =
	"Started outside AgentPulse. Once it has ended, a connected machine can take it over so you can send prompts here.";
export const TAKEOVER_NO_HOST_SOLO =
	"To send prompts here, this session's machine needs the AgentPulse supervisor running.";
export const TAKEOVER_NO_HOST_TEAM =
	"To take this over, you need a connected host of your own. An admin can use a shared one.";
export const TAKEOVER_HOSTS_FAILED = "Couldn't load your machines.";

export const TAKEOVER_STILL_WAITING = (host: string): string =>
	`Still no answer from ${host}. This can take about a minute and a half. You can leave this page.`;

/** The words while the host works: asking it, then, after 20 seconds, that this can take a minute and a half. */
export function takeoverProgress(
	kind: ResumeKind,
	host: string | null,
	startedAt: string,
	now: number,
	agent: ResumeAgent = "codex_cli",
): string {
	const name = host?.trim() || THE_HOST;
	const started = parseStoredTimestamp(startedAt);
	const waiting = started !== null && now - started >= STILL_WAITING_AFTER_MS;
	// A continued Claude session starts a new one; a recovery of one resumes it, in the Codex words.
	if (agent === "claude_code" && kind === "takeover") return claudeProgress(host, waiting);
	if (waiting) return TAKEOVER_STILL_WAITING(name);
	return kind === "takeover"
		? `Asking ${name} to take over this session…`
		: `Asking ${name} to resume this session…`;
}

// ── Eligibility (display only) ──────────────────────────────────────────────

export type TakeoverEligibility =
	| { kind: "unavailable" }
	| { kind: "quiet_wait" }
	| { kind: "stale_working"; lastHeardAt: string }
	| { kind: "eligible" };

type EligibilitySession = Pick<
	Session,
	"agentType" | "isArchived" | "isWorking" | "lastActivityAt" | "metadata"
> &
	Partial<Pick<Session, "managed" | "managedSession">>;

function hasOutstandingPermissionWait(metadata: Session["metadata"] | undefined): boolean {
	const wait = (
		metadata as { permissionWait?: { ids?: unknown; anon?: unknown } } | null | undefined
	)?.permissionWait;
	if (!wait) return false;
	return (
		(Array.isArray(wait.ids) && wait.ids.length > 0) ||
		(typeof wait.anon === "number" && wait.anon > 0)
	);
}

/**
 * The first group of the card's table. A session heard from in the last five minutes is active whatever it
 * says; one that finished a turn becomes available after five quiet minutes; one that is working or waiting
 * is taken to have crashed an hour after its last activity, which is when the server's own sweep lets go of
 * it. The server's clock decides, so this can be a moment off; it never grants anything.
 */
export function takeoverEligibility(session: EligibilitySession, now: number): TakeoverEligibility {
	if (
		(session.agentType !== "codex_cli" && session.agentType !== "claude_code") ||
		session.isArchived ||
		session.managed === true ||
		session.managedSession
	) {
		return { kind: "unavailable" };
	}
	const last = parseStoredTimestamp(session.lastActivityAt);
	if (last === null) return { kind: "unavailable" };
	const age = now - last;
	const working = session.isWorking || hasOutstandingPermissionWait(session.metadata);
	if (age < SESSION_IDLE_TIMEOUT_MS)
		return working ? { kind: "unavailable" } : { kind: "quiet_wait" };
	if (working && age < CRASHED_AFTER_MS) {
		return { kind: "stale_working", lastHeardAt: session.lastActivityAt };
	}
	return { kind: "eligible" };
}

// ── The machines ────────────────────────────────────────────────────────────

export type BindHostReason =
	| "offline"
	| "needs_update"
	| "directory"
	| "unsupported_os"
	| "needs_claude";

export interface BindHostOption {
	id: string;
	name: string;
	disabled: boolean;
	reason: BindHostReason | null;
	/** The option's text: the name, with the reason in brackets when it can't be chosen. */
	label: string;
}

const REASON_SUFFIX: Record<BindHostReason, string> = {
	offline: "offline",
	needs_update: "needs a supervisor update",
	directory: "doesn't allow this directory",
	unsupported_os: CLAUDE_HOST_SUFFIX.unsupported_os,
	needs_claude: CLAUDE_HOST_SUFFIX.needs_claude,
};

function segmentsOf(path: string): { windows: boolean; segments: string[] } | null {
	const windows = /^[A-Za-z]:[\\/]/.test(path);
	if (!windows && !path.startsWith("/")) return null;
	const segments = path.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
	if (segments.includes("..")) return null;
	return { windows, segments };
}

/** Lexical only (no symlinks, no disk): whether `cwd` is a trusted root or inside one. The host's check is the real one. */
function insideTrustedRoots(cwd: string | null | undefined, roots: readonly string[]): boolean {
	if (!cwd) return false;
	const target = segmentsOf(cwd);
	if (target === null) return false;
	return roots.some((root) => {
		const r = segmentsOf(root);
		if (r === null || r.windows !== target.windows || r.segments.length > target.segments.length) {
			return false;
		}
		return r.segments.every((seg, i) => {
			const other = target.segments[i] as string;
			return target.windows ? seg.toLowerCase() === other.toLowerCase() : seg === other;
		});
	});
}

function leaseIsLive(
	host: Pick<SupervisorRecord, "heartbeatLeaseExpiresAt">,
	now: number,
): boolean {
	const expiry = parseStoredTimestamp(host.heartbeatLeaseExpiresAt);
	return expiry !== null && expiry > now;
}

export interface BindableHostsContext {
	ui: Pick<OwnershipUi, "showHostOwner">;
	viewerUserId: string | null;
	isAdmin: boolean;
	session: { ownerUserId?: string | null; cwd?: string | null };
	now: number;
	/** Which agent the session is: a Claude session needs a host that advertises `claude_takeover` and runs macOS. */
	agent?: ResumeAgent;
}

/**
 * The machines the dialog lists: the ones the server could accept, plus the ones that are usable in principle
 * but not now, as disabled options that say why. Left out: revoked or unenrolled hosts; in team mode a member's
 * view of anyone's host but their own; and, for everyone, a host owned by someone other than the session's
 * owner (the server refuses it as `host_owner_mismatch`). The session's reported machine is a sentence in the
 * dialog and plays no part here: nothing is filtered or chosen by it.
 */
export function bindableHosts(
	hosts: readonly SupervisorRecord[],
	ctx: BindableHostsContext,
): { options: BindHostOption[]; usable: number } {
	const team = ctx.ui.showHostOwner;
	const sessionOwner = ctx.session.ownerUserId ?? null;
	const options: BindHostOption[] = [];
	for (const host of hosts) {
		if (host.enrollmentState !== undefined && host.enrollmentState !== "active") continue;
		const owner = host.ownerUserId ?? null;
		if (team) {
			if (!ctx.isAdmin && (ctx.viewerUserId === null || owner !== ctx.viewerUserId)) continue;
			if (sessionOwner !== null && owner !== null && sessionOwner !== owner) continue;
		}
		const claude = ctx.agent === "claude_code";
		const reason: BindHostReason | null = !leaseIsLive(host, ctx.now)
			? "offline"
			: claude
				? (claudeHostReason(host, CLAUDE_TAKEOVER) ??
					(insideTrustedRoots(ctx.session.cwd, host.trustedRoots ?? []) ? null : "directory"))
				: !(host.capabilities?.features ?? []).includes(RESUMES_SESSIONS)
					? "needs_update"
					: !insideTrustedRoots(ctx.session.cwd, host.trustedRoots ?? [])
						? "directory"
						: null;
		options.push({
			id: host.id,
			name: host.hostName,
			disabled: reason !== null,
			reason,
			label: reason === null ? host.hostName : `${host.hostName} (${REASON_SUFFIX[reason]})`,
		});
	}
	options.sort((a, b) =>
		a.disabled === b.disabled ? a.name.localeCompare(b.name) : a.disabled ? 1 : -1,
	);
	return { options, usable: options.filter((o) => !o.disabled).length };
}

// ── The dialog ──────────────────────────────────────────────────────────────

export interface TakeoverDialogInput {
	sessionName: string;
	/** The session's owner when it is someone other than the viewer; null otherwise. */
	owner: string | null;
	ownerName: string | null;
	/** Who an unowned session will belong to after a takeover in team mode; null when it isn't one. */
	assigneeName: string | null;
	reportedHost: string | null;
	hostName: string | null;
	cwd: string | null;
	team: boolean;
	viewerIsAdmin: boolean;
}

export interface TakeoverDialogLines {
	title: string;
	lead: string;
	adminNote: string | null;
	reportedHostNote: string;
	directory: string;
	teamNote: string | null;
	whatHappens: readonly string[];
}

export const TAKEOVER_LEAD =
	"Only continue if this session has ended on the machine it ran on. If it's still open in a terminal, exit it first. AgentPulse checks the machine too, but can't always tell.";
/** What the session will run under, one short paragraph each so a phone can read them. */
export const TAKEOVER_WHAT_HAPPENS: readonly string[] = [
	"Codex will run on the machine you choose. Commands and file changes will ask for your approval here, and writes stay inside the directory below.",
	"These limits stay with the session, even if the take-over fails partway.",
	"Anyone who can already send prompts to your sessions, including API keys you've issued, can send them to this one.",
	"You can stop it from here, but a stopped session can't be taken over again.",
];

/** The session's own report of where it ran is shown short: it is whatever the sender chose to say. */
const REPORTED_HOST_MAX_CHARS = 60;

function reportedHostNote(reported: string | null, chosen: string | null): string {
	const name = cleanHostText(reported, REPORTED_HOST_MAX_CHARS);
	if (name === null) return "This session didn't report a machine name.";
	const note = `This session reported running on ${name}. AgentPulse can't verify that, so make sure it's right.`;
	const picked = chosen?.trim();
	return picked && picked.toLowerCase() !== name.toLowerCase()
		? `${note} You chose ${picked}, but this session reported ${name}.`
		: note;
}

export function takeoverDialogLines(input: TakeoverDialogInput): TakeoverDialogLines {
	const adminNote =
		input.team && input.viewerIsAdmin
			? input.owner !== null && input.ownerName
				? `This is ${input.ownerName}'s session. It stays theirs, and they'll see that you took it over.`
				: input.assigneeName
					? `This session has no owner, so it will belong to ${input.assigneeName} from now on.`
					: null
			: null;
	const where = input.hostName?.trim() || "that machine";
	return {
		title: `Take over ${input.sessionName}?`,
		lead: TAKEOVER_LEAD,
		adminNote,
		reportedHostNote: reportedHostNote(input.reportedHost, input.hostName),
		directory: `Directory: ${input.cwd?.trim() || "not reported"}`,
		teamNote: input.team
			? `AgentPulse checks who reported this session, not who typed in it. If people share one account on ${where}, check that this is your session first.`
			: null,
		whatHappens: TAKEOVER_WHAT_HAPPENS,
	};
}

/** "Take over" until a machine is chosen, then "Take over on {host}". */
export function takeoverConfirmLabel(hostName: string | null): string {
	return hostName ? `Take over on ${hostName}` : "Take over";
}

// ── The card ────────────────────────────────────────────────────────────────

export type HostsLoad =
	| { state: "loading" }
	| { state: "error" }
	| { state: "ready"; options: BindHostOption[]; usable: number };

export interface TakeoverCardInput {
	session: EligibilitySession &
		Pick<Session, "ownerUserId" | "sessionId"> &
		Partial<Pick<Session, "displayName">> &
		Partial<Pick<Session, "continuedIn">>;
	attempt: TakeoverAttempt;
	/** `sessionBindAccess` for this viewer. */
	canBind: boolean;
	team: boolean;
	viewerIsAdmin: boolean;
	hosts: HostsLoad;
	now: number;
	formatTime: (iso: string) => string;
}

export type TakeoverCardView =
	| { kind: "hidden" }
	| { kind: "info"; text: string; failure: string | null }
	| { kind: "no_host"; text: string; setupLink: boolean; failure: string | null }
	| {
			kind: "eligible";
			text: string;
			failure: string | null;
			hostsState: "loading" | "error" | "ready";
			/** The button that opens the dialog. */
			entryLabel: string;
	  }
	/** A Claude session whose fork is still open: the way to it, and the command that opens the original. */
	| {
			kind: "continued";
			forkId: string;
			forkName: string | null;
			sourceId: string;
			/** The observed session's own name, for the Copy button's label. */
			sourceName: string | null;
	  };

/** Which card the observed session gets, and with what words. Nothing here grants anything. */
export function takeoverCardView(input: TakeoverCardInput): TakeoverCardView {
	const claude = input.session.agentType === "claude_code";
	const fork = input.session.continuedIn;
	if (claude && fork?.live && !input.session.isArchived) {
		return {
			kind: "continued",
			forkId: fork.sessionId,
			forkName: fork.name,
			sourceId: input.session.sessionId,
			sourceName: input.session.displayName ?? null,
		};
	}
	const eligibility = takeoverEligibility(input.session, input.now);
	if (eligibility.kind === "unavailable") return { kind: "hidden" };
	const failure =
		input.attempt.state === "failed" && input.attempt.kind === "takeover"
			? input.attempt.reason
			: null;
	if (!input.canBind) {
		const unowned = (input.session.ownerUserId ?? null) === null;
		return input.team && !input.viewerIsAdmin && unowned && eligibility.kind === "eligible"
			? { kind: "info", text: claude ? CLAUDE_NOT_ADMIN : TAKEOVER_NOT_ADMIN, failure: null }
			: { kind: "hidden" };
	}
	if (eligibility.kind === "quiet_wait")
		return { kind: "info", text: claude ? CLAUDE_QUIET_WAIT : TAKEOVER_QUIET_WAIT, failure };
	if (eligibility.kind === "stale_working") {
		const heard = input.formatTime(eligibility.lastHeardAt);
		return {
			kind: "info",
			text: claude
				? claudeStaleWorking(heard)
				: `AgentPulse last heard from this session at ${heard}. If it crashed, you can take it over about an hour after that.`,
			failure,
		};
	}
	if (input.hosts.state === "ready" && input.hosts.options.length === 0) {
		const memberInTeam = input.team && !input.viewerIsAdmin;
		const solo = claude ? CLAUDE_NO_HOST_SOLO : TAKEOVER_NO_HOST_SOLO;
		const teamText = claude ? CLAUDE_NO_HOST_TEAM : TAKEOVER_NO_HOST_TEAM;
		return {
			kind: "no_host",
			text: memberInTeam ? teamText : solo,
			setupLink: !memberInTeam,
			failure,
		};
	}
	return {
		kind: "eligible",
		text: claude ? CLAUDE_CARD_ELIGIBLE : TAKEOVER_ELIGIBLE,
		failure,
		hostsState: input.hosts.state,
		entryLabel: claude ? CLAUDE_ENTRY_BUTTON : "Take over…",
	};
}
