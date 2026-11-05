/**
 * Taking over an observed Codex session, and resuming a managed one whose process is gone (AGEN-115).
 * One module, so the server that writes a refusal, the supervisor that reports a failure and the clients
 * that print either hold the same names and the same sentences.
 */
import type { ApprovalPolicy, SandboxMode } from "./types.js";

/** The supervisor feature that says a host can run a `resume` action. Added to its capability lists in the phase where the handler lands. */
export const RESUMES_SESSIONS = "resumes_sessions";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Whether this id can be handed to Codex as a thread id and used to build a lock path: a lowercase UUID.
 * Both the server (at request time) and the host (before it touches the filesystem) ask.
 */
export function isResumableSessionId(id: string): boolean {
	return SESSION_ID.test(id);
}

/**
 * What a takeover runs under. Fixed: a resume that passed nothing would keep whatever the thread recorded,
 * which on a thread started with the sandbox off is no approvals at all. Mapped through
 * `launch-privileges.ts` like a launch's.
 */
export const TAKEOVER_PRIVILEGES: {
	readonly approvalPolicy: ApprovalPolicy;
	readonly sandboxMode: SandboxMode;
} = { approvalPolicy: "untrusted", sandboxMode: "workspace-write" };

export type ResumeKind = "takeover" | "recovery";

/** Every refusal code the take-over and resume routes (and the routes they guard) can answer, one with copy each in the web. */
export const RESUME_REFUSAL_CODES = [
	"session_active",
	"already_managed",
	"session_id_unsupported",
	"agent_not_supported",
	"cwd_unknown",
	"cwd_not_trusted",
	"host_owner_mismatch",
	"host_not_allowed",
	"not_owner",
	"session_not_found",
	"host_offline",
	"host_gone",
	"host_upgrade_required",
	"host_cannot_run_codex",
	"session_key_mismatch",
	"rate_limited",
	"takeover_in_progress",
	"human_required",
	"retry_not_available",
	"not_resumable",
] as const;
export type ResumeRefusalCode = (typeof RESUME_REFUSAL_CODES)[number];

/** Why a resume action failed on the host or in the server's own bookkeeping; the action's `error` is the sentence for it. */
export const RESUME_FAILURE_KINDS = [
	"missing",
	"running",
	"cwd_mismatch",
	"privileges",
	"unsupported_codex",
	"reports_pending",
	"reports_held",
	"project_config",
	"thread_unverified",
	"timeout",
	"restart",
	"rejected",
	"host_upgrade_required",
] as const;
export type ResumeFailureKind = (typeof RESUME_FAILURE_KINDS)[number];

/** What a `resume` control action carries in its metadata. No env, no model, no prompt. */
export interface ResumeActionMetadata {
	resumeKind: ResumeKind;
	agentType: "codex_cli";
	/** The thread to resume. For a takeover this is the session id. */
	threadId: string;
	/** The candidate directory: the server's validated guess, never authority. The host reads the real one. */
	cwd: string;
	approvalPolicy: ApprovalPolicy | null;
	sandboxMode: SandboxMode | null;
	/** The flags the mapping adds for the privileges above, for the host to compare with its own resolution. */
	expectedEnforcedArgs: string[];
	/** Set only for a takeover of an unowned session in team mode: give it an owner when the takeover succeeds. */
	assignOwner?: true;
	/** Who pressed the button. A takeover's launch row names the session's owner instead. */
	boundByUserId?: string | null;
}

/** What to do about a thread another Codex still holds. Backticks mark a command; the web draws them as code. */
const STILL_HELD = (host: string, done: string): string =>
	`Codex on ${host} still holds this session, so it wasn't ${done}. If it's open in a terminal, exit it and try again. If you already closed it, Codex's background service is probably holding it. Stopping that service interrupts anything else running through it. When that's safe, run \`codex app-server daemon stop\` on ${host} and try again.`;

const SAYS_RESUMED_ABOUT_RETRY = "Start a new session for this work.";

type Words = (host: string) => string;
type KindWords = Record<ResumeFailureKind, Words>;

const WAITING_ON_REPORTS: Words = (host) =>
	`${host} is still sending earlier reports for this session. Try again in a few seconds.`;
const HELD_REPORTS: Words = (host) =>
	`${host} has earlier reports for this session that it can't send, so nothing was started. Its supervisor log names the folder under \`~/.agentpulse/supervisor-outbox/\`.`;

const TAKEOVER_WORDS: KindWords = {
	missing: (host) =>
		`${host} can't find this session's history, so it wasn't taken over. It probably ran on another machine or under another account.`,
	running: (host) => STILL_HELD(host, "taken over"),
	cwd_mismatch: (host) =>
		`This session's recorded directory doesn't match ${host}'s, so it wasn't taken over. It may have run on another machine.`,
	privileges: (host) =>
		`${host} wouldn't run this session under the required approval settings, so it wasn't taken over. Its supervisor log has the reason.`,
	unsupported_codex: (host) =>
		`${host}'s Codex version isn't one AgentPulse can answer approvals for, so the session wasn't taken over. Update Codex on ${host}.`,
	reports_pending: WAITING_ON_REPORTS,
	reports_held: HELD_REPORTS,
	project_config: (host) =>
		`This session's project has a .codex/config.toml, in its directory or a folder above it. Its settings can run commands without asking you, so it wasn't taken over. If the project needs that file, keep it and carry on in your terminal. Otherwise move it out of the project on ${host} and try again.`,
	// A takeover never consults the host's thread record; the sentence exists so the table is total.
	thread_unverified: (host) =>
		`AgentPulse can't confirm this session can be resumed on ${host}. ${SAYS_RESUMED_ABOUT_RETRY}`,
	timeout: (host) =>
		`${host} didn't answer in time, so the session wasn't taken over. Check that the machine is awake, then try again.`,
	restart: (host) =>
		`${host} restarted before it finished, so the session wasn't taken over. Try again.`,
	rejected: (host) =>
		`${host} couldn't start this session, so it wasn't taken over. Its supervisor log has the reason.`,
	host_upgrade_required: (host) =>
		`${host} is running an older supervisor that can't take over sessions. Update it, then try again.`,
};

const RECOVERY_REJECTED: Words = (host) =>
	`${host} couldn't start this session, so it wasn't resumed. Its supervisor log has the reason.`;

const RECOVERY_WORDS: KindWords = {
	missing: (host) =>
		`${host} no longer has this session's history, so it can't be resumed. ${SAYS_RESUMED_ABOUT_RETRY}`,
	running: (host) => STILL_HELD(host, "resumed"),
	cwd_mismatch: (host) =>
		`This session's directory on ${host} has changed, so it wasn't resumed. ${SAYS_RESUMED_ABOUT_RETRY}`,
	privileges: (host) =>
		`${host} wouldn't run this session under its approval settings, so it wasn't resumed. Its supervisor log has the reason.`,
	// A recovery proceeds on a Codex it can't answer approvals for (it declines them locally), so that
	// kind reads as the generic refusal.
	unsupported_codex: RECOVERY_REJECTED,
	project_config: (host) =>
		`This session's project has a .codex/config.toml, in its directory or a folder above it. Its settings can run commands without asking you, so it wasn't resumed. If the project needs that file, start a new session for this work. Otherwise move it out of the project on ${host} and try again.`,
	reports_pending: WAITING_ON_REPORTS,
	reports_held: HELD_REPORTS,
	thread_unverified: (host) =>
		`AgentPulse can't confirm this session can be resumed on ${host}. ${SAYS_RESUMED_ABOUT_RETRY}`,
	timeout: (host) => `${host} didn't answer in time, so the session wasn't resumed. Try again.`,
	restart: (host) =>
		`${host} restarted before it finished, so the session wasn't resumed. Try again.`,
	rejected: RECOVERY_REJECTED,
	host_upgrade_required: (host) =>
		`${host} is running an older supervisor that can't resume sessions. Update it, then try again.`,
};

/**
 * The sentence an action's `error` carries for a failure. The web, iOS and Control history all read it
 * verbatim, so it says "wasn't taken over" rather than "nothing changed": a resume can append to the thread
 * and narrow its settings before it fails.
 */
export function resumeFailureMessage(
	kind: ResumeFailureKind,
	host: string,
	resumeKind: ResumeKind,
): string {
	return (resumeKind === "takeover" ? TAKEOVER_WORDS : RECOVERY_WORDS)[kind](host);
}

/**
 * What a host with an exclude-rules file says, whatever went wrong: one sentence per kind, built from the
 * host's name alone, so a person who can bind learns nothing about the host's rules from it. The cause goes
 * to the host's own log.
 */
export const RESUME_REFUSED_MESSAGE: Readonly<Record<ResumeKind, (host: string) => string>> = {
	takeover: (host) =>
		`${host} refused this session, so it wasn't taken over. Check that it's the machine the session ran on and that the session has ended there. Its supervisor log has the reason.`,
	recovery: (host) => `${host} refused to resume this session. Its supervisor log has the reason.`,
};

export { TAKEOVER_IN_PROGRESS_MESSAGE } from "./takeover-in-progress.js";

/**
 * A host that is current enough but can't run a Codex session at all: no usable Codex executable, or no
 * managed Codex launch mode. Not an upgrade problem, so it isn't `host_upgrade_required`.
 */
export const hostCannotRunCodexMessage = (host: string, kind: ResumeKind = "takeover"): string =>
	kind === "recovery"
		? `${host} can't run Codex sessions: Codex isn't set up there, or it doesn't support managed Codex sessions. Fix that on ${host}, or start a new session for this work.`
		: `${host} can't run Codex sessions: Codex isn't set up there, or it doesn't support managed Codex sessions. Choose another machine.`;

/** The timeline event the server writes when a resume succeeds. Server-only: hooks and supervisors can't write it. */
export const SESSION_RESUMED_EVENT_TYPE = "ManagedSessionResumed";

/** Its fixed words, one per resume kind. */
export const SESSION_RESUMED_CONTENT: Readonly<Record<ResumeKind, string>> = {
	takeover: "AgentPulse took over this session.",
	recovery:
		"AgentPulse resumed this session. Any turn that was running when its process ended didn't finish.",
};
