/**
 * Taking over an observed Codex session, and resuming a managed one whose process is gone (AGEN-115).
 * One module, so the server that writes a refusal, the supervisor that reports a failure and the clients
 * that print either hold the same names and the same sentences.
 */
import {
	ORIGINAL_SESSION_FALLBACK,
	RESTRICTED_LOGIN_KINDS,
	forkSentenceName,
} from "./claude-fork-copy.js";
import type { ApprovalPolicy, SandboxMode } from "./types.js";

/** The supervisor feature that says a host can run a `resume` action. Added to its capability lists in the phase where the handler lands. */
export const RESUMES_SESSIONS = "resumes_sessions";

/**
 * The supervisor feature that says a host can take over an observed Claude Code session by forking it, and
 * resume a fork (AGEN-117 T14). Advertised only when `claude` resolves on the host. Separate from
 * `RESUMES_SESSIONS` so a Claude-only host (no Codex) can take over, and a Codex-only one is never asked to.
 */
export const CLAUDE_TAKEOVER = "claude_takeover";

/** How long a Claude takeover action may stay open before the server fails it (T5): claim, preflight and settle. */
export const CLAUDE_FORK_DEADLINE_MS = 90_000;

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

/**
 * The permission mode a Claude takeover runs under (AGEN-117 T4). The host picks it per takeover from the
 * login Claude Code reports, the server validates and stores it, and every sentence about what applies
 * follows it. `restricted` ignores the person's own Claude settings; `ask` leaves them in force. Never a
 * build-wide constant, and never chosen by a client.
 */
export const CLAUDE_FORK_MODES = ["ask", "restricted"] as const;
export type ClaudeForkMode = (typeof CLAUDE_FORK_MODES)[number];

export function isClaudeForkMode(value: unknown): value is ClaudeForkMode {
	return typeof value === "string" && (CLAUDE_FORK_MODES as readonly string[]).includes(value);
}

/**
 * What a Claude takeover runs under (AGEN-117 T14): a person approves anything that changes something.
 * Mapped through `launch-privileges.ts` to `--permission-mode default`; the host recomputes the argv from it.
 */
export const CLAUDE_TAKEOVER_PRIVILEGES: {
	readonly approvalPolicy: ApprovalPolicy;
	readonly sandboxMode: SandboxMode | null;
} = { approvalPolicy: "manual", sandboxMode: null };

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
	"host_cannot_run_claude",
	"end_session_first",
	// AGEN-119..123: a fork option (MCP servers, subagents) asked for on a machine the actor doesn't own.
	"fork_options_host_not_yours",
	// A fork option asked for on a session that isn't a Claude Code one (Codex takes none).
	"fork_options_not_supported",
] as const;
export type ResumeRefusalCode = (typeof RESUME_REFUSAL_CODES)[number];

/** Why a resume action failed on the host or in the server's own bookkeeping; the action's `error` is the sentence for it. */
const CODEX_FAILURE_KINDS = [
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

/** Failures only a Claude takeover or recovery can have (AGEN-117). */
const CLAUDE_FAILURE_KINDS = [
	"claude_not_logged_in",
	"ownership_changed",
	"branch_changed",
	"liveness_unknown",
	"host_busy",
	"source_changed",
	"settle_conflict",
	"unsupported_claude",
	"insecure_transport",
	"unsupported_platform",
	// AGEN-121: the MCP servers a fork was started with changed before it was resumed.
	"mcp_servers_changed",
] as const;

export const RESUME_FAILURE_KINDS = [...CODEX_FAILURE_KINDS, ...CLAUDE_FAILURE_KINDS] as const;
export type ResumeFailureKind = (typeof RESUME_FAILURE_KINDS)[number];
type CodexFailureKind = (typeof CODEX_FAILURE_KINDS)[number];

// ---- Fork options (AGEN-119..123, Track 0) ----

/** What a person asks for on the bind body. Exactly these keys; both default off. */
export interface ForkOptionsRequest {
	mcp?: boolean;
	subagents?: boolean;
}

/** What the host actually applied, reported with the takeover's success and stored on the fork (server-owned). */
export interface AppliedForkOptions {
	mcpServers: { name: string; digest: string }[];
	subagents: boolean;
	claudeVersion: string;
}

/** No options. `claudeVersion` is empty: a host that applied nothing has nothing to record about it. */
export const FORK_OPTIONS_OFF: AppliedForkOptions = Object.freeze({
	mcpServers: Object.freeze([]) as unknown as { name: string; digest: string }[],
	subagents: false,
	claudeVersion: "",
});

/**
 * The Claude Code versions the options were measured on (F45). Elsewhere the host reports an option not
 * applied. The per-release canary adds a version here.
 */
export const FORK_OPTION_MEASURED_VERSIONS: readonly string[] = ["2.1.319"];

const FORK_OPTION_KEYS = new Set(["mcp", "subagents"]);

/** The bind body's `forkOptions`: absent means none; anything but an object of those two booleans is null (invalid). */
export function parseForkOptionsRequest(value: unknown): ForkOptionsRequest | null {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const out: ForkOptionsRequest = {};
	for (const [key, v] of Object.entries(value)) {
		if (!FORK_OPTION_KEYS.has(key) || typeof v !== "boolean") return null;
		(out as Record<string, boolean>)[key] = v;
	}
	return out;
}

/** Whether a request asks for any option. */
export function forkOptionsRequested(request: ForkOptionsRequest | undefined | null): boolean {
	return request?.mcp === true || request?.subagents === true;
}

const SERVER_NAME = /^[A-Za-z0-9-]{1,32}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** A host's report of what it applied, checked strictly. Null when it is not that shape. */
export function parseAppliedForkOptions(value: unknown): AppliedForkOptions | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).some((k) => k !== "mcpServers" && k !== "subagents" && k !== "claudeVersion")
	) {
		return null;
	}
	if (!Array.isArray(v.mcpServers) || v.mcpServers.length > 16) return null;
	if (typeof v.subagents !== "boolean") return null;
	if (typeof v.claudeVersion !== "string" || v.claudeVersion.length > 32) return null;
	const mcpServers: { name: string; digest: string }[] = [];
	for (const entry of v.mcpServers) {
		if (typeof entry !== "object" || entry === null) return null;
		const { name, digest, ...rest } = entry as Record<string, unknown>;
		if (Object.keys(rest).length > 0) return null;
		if (typeof name !== "string" || !SERVER_NAME.test(name)) return null;
		if (typeof digest !== "string" || !DIGEST.test(digest)) return null;
		mcpServers.push({ name, digest });
	}
	return { mcpServers, subagents: v.subagents, claudeVersion: v.claudeVersion };
}

/**
 * `sessions.metadata` key on a fork: the user id of the host owner who consented to its options at bind. Server-owned.
 * In team mode only that person may drive a fork that runs those options (AGEN-119..123, review H1).
 */
export const FORK_OPTIONS_CONSENT_KEY = "forkOptionsConsentUserId";

/**
 * Clamp what a host says it applied to what the bind asked for. A host that reports an option nobody asked for
 * gets it forced off, so a lying or buggy host can't create consent. `requested` is the bind's own request.
 */
export function clampAppliedToRequested(
	applied: AppliedForkOptions,
	requested: ForkOptionsRequest,
): AppliedForkOptions {
	return {
		mcpServers: requested.mcp === true ? applied.mcpServers : [],
		subagents: requested.subagents === true ? applied.subagents : false,
		claudeVersion: applied.claudeVersion,
	};
}

/** True when nothing but the version differs from `FORK_OPTIONS_OFF`. */
export function forkOptionsAreOff(applied: AppliedForkOptions | null | undefined): boolean {
	return !applied || (applied.mcpServers.length === 0 && applied.subagents === false);
}

/** The sentence for a fork option asked for on a machine the actor doesn't own (`fork_options_host_not_yours`). */
export function forkOptionsHostNotYoursMessage(host: string, owner?: string | null): string {
	const tail =
		owner === undefined
			? `${host} isn't yours.`
			: owner === null
				? `${host} has no owner.`
				: `${host} belongs to ${owner}.`;
	return `Your MCP servers and subagents can be used only on a machine you own. ${tail}`;
}

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
	/**
	 * The title the person's thread has: the session's own name. The host starts its runtime with it as the
	 * thread's current title, so the first provider sync (which compares it with the server's desired title)
	 * renames nothing. Absent when the session has no name; the server then has no title to sync either.
	 */
	sessionName?: string;
}

/**
 * The one place the server builds what the host reads from a `resume` action, so a field the host needs
 * can't be left out of one of the two literals (the name was).
 */
export function buildResumeActionMetadata(
	input: Omit<ResumeActionMetadata, "agentType" | "sessionName" | "assignOwner"> & {
		assignOwner?: boolean;
		sessionName?: string | null;
	},
): ResumeActionMetadata {
	const { sessionName, assignOwner, ...rest } = input;
	// Unchanged: the server's desired title is the stored name as it is, and the host compares the two, so a
	// trimmed or cut name would read as a rename. Only a blank one is left out.
	const name = typeof sessionName === "string" && sessionName.trim() !== "" ? sessionName : "";
	return {
		...rest,
		agentType: "codex_cli",
		...(assignOwner ? { assignOwner: true as const } : {}),
		...(name !== "" ? { sessionName: name } : {}),
	};
}

/**
 * What a Claude `resume` action carries (AGEN-117 T5, T13). A takeover is an action on the observed session S
 * that names the fork N the server minted for it; no row N exists until the host's success report settles.
 * A recovery is an action on N itself. The host picks the permission mode (T4) and reports it; a recovery
 * never carries one, because it runs under the mode stored on N.
 */
export interface ClaudeResumeActionMetadata {
	resumeKind: ResumeKind;
	agentType: "claude_code";
	/** The session the action is about: S for a takeover, N for a recovery. */
	threadId: string;
	/** The server's validated guess at S's directory; never authority. A recovery uses the host's own record. */
	candidateCwd: string | null;
	expectedEnforcedArgs: string[];
	boundByUserId?: string | null;
	sessionName?: string;
	/** Recovery only: the observed session N was forked from, by name, for the few sentences that point back to it. */
	sourceName?: string;
	/** Takeover only. */
	forkSessionId?: string;
	carrierLaunchId?: string;
	targetSupervisorId?: string;
	hostName?: string;
	intendedOwner?: string | null;
	ownerAtBind?: string | null;
	assignOwner?: true;
	forkDeadlineAt?: string;
	/** Takeover only: the options the person asked for (default none). */
	forkOptions?: ForkOptionsRequest;
	/** Recovery only: what the fork was started with, read by the server from N's stored `metadata.forkOptions`. */
	storedForkOptions?: AppliedForkOptions;
}

export function buildClaudeResumeActionMetadata(
	input: Omit<
		ClaudeResumeActionMetadata,
		"agentType" | "assignOwner" | "sessionName" | "sourceName"
	> & {
		assignOwner?: boolean;
		sessionName?: string | null;
		sourceName?: string | null;
	},
): ClaudeResumeActionMetadata {
	const { assignOwner, sessionName, sourceName, ...rest } = input;
	const name = typeof sessionName === "string" && sessionName.trim() !== "" ? sessionName : "";
	const source = typeof sourceName === "string" && sourceName.trim() !== "" ? sourceName : "";
	return {
		...rest,
		agentType: "claude_code",
		...(assignOwner ? { assignOwner: true as const } : {}),
		...(name !== "" ? { sessionName: name } : {}),
		...(source !== "" ? { sourceName: source } : {}),
	};
}

/** Whether a resume action's metadata is a Claude one. The one place the agent is read from it. */
export function resumeAgentOf(metadata: unknown): "codex_cli" | "claude_code" {
	return (metadata as { agentType?: unknown } | null)?.agentType === "claude_code"
		? "claude_code"
		: "codex_cli";
}

/** A takeover action that forks (as opposed to a recovery): it names the fork N. */
export function forkSessionIdOf(metadata: unknown): string | null {
	const id = (metadata as { forkSessionId?: unknown } | null)?.forkSessionId;
	return typeof id === "string" && id !== "" ? id : null;
}

/** What to do about a thread another Codex still holds. Backticks mark a command; the web draws them as code. */
const STILL_HELD = (host: string, done: string): string =>
	`Codex on ${host} still holds this session, so it wasn't ${done}. If it's open in a terminal, exit it and try again. If you already closed it, Codex's background service is probably holding it. That usually lets go within about 30 minutes, so try again then. To free it sooner, run \`codex app-server daemon stop\` on ${host}, which interrupts anything else running through that service.`;

const SAYS_RESUMED_ABOUT_RETRY = "Start a new session for this work.";

/** A sentence for a failure; the second argument is the observed session's name, for the few that mention it. */
type Words = (
	host: string,
	sourceName?: string | null,
	version?: ClaudeVersionNote | null,
) => string;

/** The Claude Code version a host found and the range AgentPulse has tested, for the version refusal's words. */
export interface ClaudeVersionNote {
	found: string;
	range: string;
}
type KindWords = Record<CodexFailureKind, Words>;

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

const CLAUDE_TERMINAL_LOGIN =
	"Being logged in to Claude in a terminal isn't enough for the supervisor.";

const CLAUDE_TAKEOVER_WORDS: Record<ResumeFailureKind, Words> = {
	running: (host) =>
		`This conversation is still open on ${host}, in a terminal or as a background agent. Close it there, then try again.`,
	missing: (host) =>
		`${host} can't find this conversation's history, so nothing was started. It probably ran on another machine or under another account.`,
	cwd_mismatch: (host) =>
		`This conversation's directory isn't one ${host} allows, so nothing was started.`,
	privileges: (host) =>
		`${host} wouldn't run this under the required approval settings, so nothing was started. Its supervisor log has the reason.`,
	unsupported_codex: (host) => CLAUDE_TAKEOVER_WORDS.rejected(host),
	reports_pending: WAITING_ON_REPORTS,
	reports_held: HELD_REPORTS,
	project_config: (host) => CLAUDE_TAKEOVER_WORDS.rejected(host),
	thread_unverified: (host) => CLAUDE_TAKEOVER_WORDS.rejected(host),
	timeout: (host) =>
		`${host} didn't answer in time, so nothing was started. Check that it's awake, then try again.`,
	restart: (host) => `${host} restarted before it finished, so nothing was started. Try again.`,
	rejected: (host) =>
		`${host} couldn't start this, so nothing was started. Its supervisor log has the reason.`,
	host_upgrade_required: (host) =>
		`${host} is running an older supervisor that can't continue Claude sessions. Update it, then try again.`,
	claude_not_logged_in: (host) =>
		`Claude Code has no login the supervisor on ${host} can use, so nothing was started. ${CLAUDE_TERMINAL_LOGIN} Give the supervisor's environment either a subscription token, made with \`claude setup-token\` and set as \`CLAUDE_CODE_OAUTH_TOKEN\`, or an API key set as \`ANTHROPIC_API_KEY\`. Then restart the supervisor and try again.`,
	ownership_changed: (host) =>
		`Who owns this session or ${host} changed while it was starting, so nothing was started. Try again.`,
	branch_changed: (_host, sourceName) =>
		`This session started under different rules than AgentPulse uses now, so it can't be resumed. End it and continue ${forkSentenceName(sourceName, ORIGINAL_SESSION_FALLBACK)} again.`,
	liveness_unknown: (host) =>
		`AgentPulse couldn't check whether this session is open on ${host}, so it didn't start. Try again.`,
	host_busy: (host) =>
		`${host} is already running as many of these as it can. End one and try again. Nothing was started.`,
	source_changed: () =>
		"Your terminal's conversation changed while this was starting, so AgentPulse stopped. It may have been you, or this version of Claude Code may have written to it. Check that conversation before trying again.",
	settle_conflict: () => "AgentPulse couldn't set this up, so nothing was started. Try again.",
	unsupported_claude: (host, _name, version) =>
		version
			? `Claude Code ${version.found} on ${host} is outside what AgentPulse has tested (${version.range}). Nothing was started. Change the Claude Code version there, or update AgentPulse.`
			: `Claude Code on ${host} is outside what AgentPulse has tested. Nothing was started. Change the Claude Code version there, or update AgentPulse.`,
	insecure_transport: (host) =>
		`${host} doesn't reach AgentPulse over https, so it can't answer approvals. Nothing was started.`,
	unsupported_platform: () => "AgentPulse can do this only on macOS so far.",
	mcp_servers_changed: (host) =>
		`The MCP servers this session was started with have changed on ${host}, so it wasn't resumed. End it and continue the original session again.`,
};

/** A recovery of a fork: the same, worded for a session that already exists and a mode already stored on it. */
const CLAUDE_RECOVERY_OVERRIDES: Partial<Record<ResumeFailureKind, Words>> = {
	running: (host) =>
		`${host} still shows this session running. A command you approved may still be finishing, so try again when it's done. If it's open in a terminal, close it there.`,
	missing: (host) =>
		`${host} no longer has this session's history, so it can't be resumed. ${SAYS_RESUMED_ABOUT_RETRY}`,
	timeout: (host) => `${host} didn't answer in time, so the session wasn't resumed. Try again.`,
	restart: (host) =>
		`${host} restarted before it finished, so the session wasn't resumed. Try again.`,
	rejected: RECOVERY_REJECTED,
	thread_unverified: (host) =>
		`AgentPulse can't confirm this session can be resumed on ${host}. ${SAYS_RESUMED_ABOUT_RETRY}`,
};

/**
 * `claude_not_logged_in` on a recovery is worded by the mode N was started under: a `restricted` session
 * can't be resumed on a login that only works with the person's own settings.
 */
function claudeRecoveryNotLoggedIn(host: string, mode: ClaudeForkMode | undefined): string {
	return mode === "restricted"
		? `This session runs without your Claude settings, and Claude Code on ${host} no longer has a login it can use that way, so it wasn't resumed. Give the supervisor's environment ${RESTRICTED_LOGIN_KINDS.includes("token") ? "a subscription token from `claude setup-token` (as `CLAUDE_CODE_OAUTH_TOKEN`) or an API key" : "an API key"} (as \`ANTHROPIC_API_KEY\`), restart the supervisor, then resume.`
		: `Claude Code on ${host} no longer has a login the supervisor can use, so this session wasn't resumed. ${CLAUDE_TERMINAL_LOGIN} Give it a subscription token from \`claude setup-token\` (as \`CLAUDE_CODE_OAUTH_TOKEN\`) or an API key (as \`ANTHROPIC_API_KEY\`), restart the supervisor, then resume.`;
}

/**
 * The sentence an action's `error` carries for a failure. The web, iOS and Control history all read it
 * verbatim, so it says "wasn't taken over" rather than "nothing changed": a resume can append to the thread
 * and narrow its settings before it fails. A Claude takeover is the opposite: it writes nothing to the
 * original, so its words say "nothing was started". `mode` is the mode stored on the fork, for a recovery.
 */
export function resumeFailureMessage(
	kind: ResumeFailureKind,
	host: string,
	resumeKind: ResumeKind,
	agent: "codex_cli" | "claude_code" = "codex_cli",
	mode?: ClaudeForkMode,
	sourceName?: string | null,
	version?: ClaudeVersionNote | null,
): string {
	if (agent === "claude_code") {
		if (resumeKind === "recovery") {
			if (kind === "claude_not_logged_in") return claudeRecoveryNotLoggedIn(host, mode);
			const override = CLAUDE_RECOVERY_OVERRIDES[kind];
			if (override) return override(host, sourceName, version);
		}
		return CLAUDE_TAKEOVER_WORDS[kind](host, sourceName, version);
	}
	const table = resumeKind === "takeover" ? TAKEOVER_WORDS : RECOVERY_WORDS;
	// A kind only a Claude resume can have is, on a Codex one, the generic refusal.
	return (table[kind as CodexFailureKind] ?? table.rejected)(host);
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

export { END_SESSION_FIRST_MESSAGE, TAKEOVER_IN_PROGRESS_MESSAGE } from "./takeover-in-progress.js";

/**
 * A host that is current enough but can't run a Codex session at all: no usable Codex executable, or no
 * managed Codex launch mode. Not an upgrade problem, so it isn't `host_upgrade_required`.
 */
export const hostCannotRunCodexMessage = (host: string, kind: ResumeKind = "takeover"): string =>
	kind === "recovery"
		? `${host} can't run Codex sessions: Codex isn't set up there, or it doesn't support managed Codex sessions. Fix that on ${host}, or start a new session for this work.`
		: `${host} can't run Codex sessions: Codex isn't set up there, or it doesn't support managed Codex sessions. Choose another machine.`;

/** A host that is current enough but has no usable Claude Code, or predates Claude takeover. */
export const hostCannotRunClaudeMessage = (
	host: string,
	kind: ResumeKind = "takeover",
	sourceName?: string | null,
): string =>
	kind === "recovery"
		? `${host} can't continue Claude sessions: Claude Code isn't set up there, or its supervisor is out of date. Fix that on ${host}, or end this session and continue ${forkSentenceName(sourceName, ORIGINAL_SESSION_FALLBACK)} on another machine.`
		: `${host} can't continue Claude sessions: Claude Code isn't set up there, isn't on macOS, or its supervisor is out of date. Choose another machine.`;

/** The timeline event the server writes when a resume succeeds. Server-only: hooks and supervisors can't write it. */
export const SESSION_RESUMED_EVENT_TYPE = "ManagedSessionResumed";

/** Its fixed words, one per resume kind. */
export const SESSION_RESUMED_CONTENT: Readonly<Record<ResumeKind, string>> = {
	takeover: "AgentPulse took over this session.",
	recovery:
		"AgentPulse resumed this session. Any turn that was running when its process ended didn't finish.",
};
