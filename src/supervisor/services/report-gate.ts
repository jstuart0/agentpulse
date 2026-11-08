import { randomUUID } from "node:crypto";
/**
 * The one place a supervisor report about a session leaves the machine.
 *
 * Every request that carries session data (managed-session state, managed-session
 * events, control-action results, launch status) is built and sent here, and
 * nowhere else under src/supervisor (a drift test holds the endpoint paths to
 * this file). Before anything goes out the gate asks one question of the id the
 * report is about: is the directory the supervisor started that session in
 * excluded by the user's rules as they are now?
 *
 *  - rules invalid: fail closed, nothing goes out, nothing is replayed later;
 *  - rules present, directory excluded or unknown: nothing goes out. A session
 *    this gate already reported on gets exactly one closing report with no
 *    content at all (without it the server would hold the session live forever:
 *    live managed sessions are exempt from staleness) and then silence. A session
 *    it never delivered a report for gets nothing, so no row ever exists for it;
 *  - otherwise the report goes out as given.
 *
 * The directory of a session is what THIS supervisor learned when it started the
 * session, never what the server says about it later: a directory in a report
 * body or in a control action feeds nothing, and an action that names a different
 * directory than the one known is refused. A session this supervisor has no
 * directory for counts as excluded while rules exist. That memory (directories,
 * which sessions are excluded, which were reported and which were closed) is kept
 * in a private file next to the stamp, so a restart forgets nothing: a session
 * excluded before it stays excluded and is closed exactly once.
 *
 * A host with no rules file pays nothing for any of this. While there are no rules,
 * nothing is excluded and no interactive terminal session has been launched, the gate
 * keeps its memory in the process only (no state file is created or written); an
 * interactive launch is remembered on disk regardless, because its terminal bridge
 * outlives the supervisor and has to be found again after a restart. A full memory forgets its oldest session instead
 * of refusing a launch. When rules appear the memory is saved at the next decision
 * or scan. A session is let go (its slot reusable) once a terminal state report for
 * it has been delivered; with rules in place a launch is refused for capacity only
 * when the bound's worth of sessions are really live.
 *
 * Exclusion is sticky: once a session is excluded it stays excluded for good,
 * whatever a later note or a later edit of the rules says. The agent process
 * itself is left running: it is the user's work.
 *
 * A session counts as reported only after the report was delivered: a first report
 * that failed leaves no session on the server, so excluding the directory later
 * must not create one with a closing report.
 *
 * The supervisor does not see AGENTPULSE_SKIP of the agent it launched; the path
 * rules are what cover it.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CODEX_SYNC_TIMEOUT_MS,
	type CodexApprovalLive,
	type CodexApprovalReportRequest,
	type CodexApprovalReportResponse,
	type CodexApprovalResolved,
	type ParsedApprovalSyncResponse,
	parseApprovalReportResponse,
	parseApprovalSyncResponse,
} from "../../shared/codex-approvals.js";
import {
	type LoadExcludeRulesResult,
	MAX_CWD_LENGTH,
	evaluateExclusion,
} from "../../shared/exclude-rules.js";
import {
	DELIVERY_ID_HEADER,
	REPLAY_HEADER,
	SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH,
} from "../../shared/hook-headers.js";
import { clampEventContent } from "../../shared/managed-report-limits.js";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import type { AppliedForkOptions } from "../../shared/session-resume.js";
import type {
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	Session,
} from "../../shared/types.js";
import type { ExcludeScope } from "../providers/fork-tool-record.js";
import { type RulesWatch, createRulesWatch } from "./exclude-rules-watch.js";
import {
	readPrivateFileNoFollow,
	isTrustedStateFileStat as storeIsTrustedStateFileStat,
	trustedDirectory,
} from "./private-store.js";
import type { OutboxEntry, OutboxSummary, ReportOutbox } from "./report-outbox.js";
import {
	BACKOFF_BUDGET_MS,
	type CredentialTripwire,
	SupervisorNetworkError,
	SupervisorRequestError,
	classifyReportFailure,
	markCredentialHandled,
	sessionBackoffMs,
} from "./report-resilience.js";

/** The one sentence a refused launch or control action reports, whatever the reason. */
export const LAUNCH_REFUSED_MESSAGE = "This host doesn't allow launches in that directory.";
export const LAUNCH_REFUSED_CODE = "path_outside_trusted_roots";

/** Sessions remembered at most this many at a time. What is forgotten first is what no longer needs the gate: never reported, finished, or already closed. */
const MAX_TRACKED_SESSIONS = 5_000;
/** Where the gate keeps what it knows between runs, next to the stamp. */
const GATE_STATE_RELATIVE_PATH = ".agentpulse/supervisor-gate-state.json";
const GATE_STATE_VERSION = 1;
/** A state file larger than this is not read (the bound on entries and on a directory's length is far below it). */
const MAX_GATE_STATE_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 1_024;

/** What the gate knows about one session id. */
type SessionRecord = {
	/** The directory this supervisor started it in; never replaced, never taken from the server. */
	cwd?: string;
	excluded?: boolean;
	/** A report about it was delivered to the server. */
	reported?: boolean;
	/** Its closing report was delivered. */
	closed?: boolean;
	/** A terminal state report (completed, failed, stopped) was delivered: it no longer needs a closing report, and its slot is free for reuse. */
	done?: boolean;
	/** This id is the correlation id of an interactive terminal launch this supervisor started: the only kind of id whose terminal bridge directory the spool drain may follow without being told. */
	interactive?: boolean;
};

export type LaunchStatusBody = {
	status: "launching" | "awaiting_session" | "running" | "completed" | "failed" | "cancelled";
	error?: string | null;
	pid?: number | null;
	providerLaunchMetadata?: Record<string, unknown> | null;
};

export type ControlStatusBody = {
	status: "running" | "succeeded" | "failed";
	error?: string | null;
	metadata?: Record<string, unknown> | null;
	/**
	 * With `running`: the host took this Claude prompt on (spawned it, or wrote it to the fork's process). The
	 * server stamps `metadata.acceptedAt` from it, and only from it: a claim also reads `running`, so the status
	 * alone says nothing about whether the host will refuse the prompt a moment later.
	 */
	accepted?: boolean;
	/** A Claude takeover's success: the directory the host proved from the original's transcript (AGEN-117 T5). */
	provedCwd?: string;
	/** A Claude takeover's success: the permission mode the host picked from the login. The server judges the shape. */
	permissionMode?: string;
	/** A Claude takeover's success: what the host applied of the fork options. The server judges the shape. */
	applied?: AppliedForkOptions;
};

/**
 * What became of a control-status report: `sent` (with the server's answer, whose `action.status` says how the
 * action stands now), or why nothing was sent: `excluded` (a rule covers the session: the gate posted the
 * one fixed refusal instead), `blocked` (the rules or the gate's saved state can't be trusted) or `refused`
 * (the action named another directory than the known one). A caller whose report decides whether a child
 * lives reads this; every other caller ignores it.
 */
export type ControlReportOutcome =
	| { outcome: "sent"; action: { status: string } | null }
	| { outcome: "excluded" | "blocked" | "refused" };

export type StateReportResult = { session: Session; managedSession: ManagedSession };

/**
 * What became of a report handed to the gate: `sent` (the server took it), `queued` (kept for later
 * delivery), `excluded` (a rule covers the session: nothing left the host) or `blocked` (the rules or the
 * gate's saved state can't be trusted: nothing left, and nothing was kept). A caller that must tell "held
 * back, try again once the rules are valid" from "dropped for good" reads this.
 */
export type ReportOutcome = "sent" | "queued" | "excluded" | "blocked";

/** Options for events: a stable delivery id (generated when omitted) the server dedupes on, and whether this is a late replay. */
export type ReportEventsOptions = { deliveryId?: string; replay?: boolean };
export type ReportStateOptions = { replay?: boolean };

/**
 * What became of an approval report. Approvals are never queued (a request that reaches the server after
 * its runtime is gone would present a dead approval as answerable), so there is no `queued`: a report
 * either went, or was held back by the rules, or threw.
 */
export type ApprovalReportResult =
	| { outcome: "sent"; response: CodexApprovalReportResponse }
	| { outcome: "excluded" | "blocked" };

/** One poll's contents, each entry tagged with the session it is about so the gate can leave out excluded ones. */
export type ApprovalSyncEntries = {
	live: Array<CodexApprovalLive & { sessionId: string }>;
	resolved: Array<CodexApprovalResolved & { sessionId: string }>;
};
export type ApprovalSyncResult =
	| { outcome: "sent"; response: ParsedApprovalSyncResponse }
	| { outcome: "empty" };

interface ReportGateBaseDeps {
	/** The supervisor's request function: the gate's only way out. */
	request: (path: string, options?: RequestInit) => Promise<unknown>;
	supervisorId: string;
	/** The user's home directory, where the rules file, the invalid marker and the stamp live. */
	home: string;
	/** The supervisor's version, written into the stamp the CLI reads. */
	version?: string;
	log?: (line: string) => void;
	now?: () => number;
	/** Shared with the Codex observer so both read the rules once; created from `home` when omitted. */
	rules?: RulesWatch;
	/** How many sessions are remembered at most; defaults to a generous bound. */
	maxTrackedSessions?: number;
	/**
	 * The offline outbox. Without one the gate behaves exactly as it always has: a report that can't be
	 * delivered throws. With one, a state or events report the server can't take right now is kept
	 * (and sent later, in order) instead.
	 */
	outbox?: ReportOutbox;
	/**
	 * Whether this session's terminal bridge is still in use (followed by the spool drain, or alive): such a
	 * record is not forgotten to make room, since forgetting it would strand the bridge's reports.
	 */
	isBridgeActive?: (sessionId: string) => boolean;
	/** Jitter and backoff draw from this; a test passes a fixed one. */
	random?: () => number;
	/** Runs `fn` after `ms`. The default is an unref'd timer; a test resolves it at once. */
	schedule?: (fn: () => void, ms: number) => void;
}

/**
 * A tripwire and the handler that acts on its confirmation come together: a gate that counts credential
 * rejections must say what happens when they are confirmed.
 */
export type CredentialDeps =
	| { credentialTripwire?: undefined; onCredentialRejected?: undefined }
	| {
			/** The one tripwire a rejected credential feeds; shared with the heartbeat and the bridge drain. */
			credentialTripwire: CredentialTripwire;
			/** Called once the tripwire confirms the credential was rejected (the supervisor then disposes its runtimes and exits). */
			onCredentialRejected: () => void | Promise<void>;
	  };

export type ReportGateDeps = ReportGateBaseDeps & CredentialDeps;

/** Most queued reports sent for one session, and in all, by one flush. A flush every 3 s makes about 33 requests a second at most. */
export const FLUSH_MAX_PER_SESSION = 50;
export const FLUSH_MAX_PER_PASS = 100;
/** After the server is reachable again a flush waits up to this long (random), so a fleet doesn't reconnect in step. */
const RECONNECT_JITTER_MS = 5_000;

/** What may leave for an id: "send" it, "excluded" (drop; this session is covered by a rule or its directory is unknown), "blocked" (drop; the rules file is invalid). */
export type ReportVerdict = "send" | "excluded" | "blocked" | "refused";

export interface ReportGate {
	/**
	 * Remembers the directory this supervisor started a session or launch in. The first directory noted
	 * for an id stays. False when the launch must be refused: while rules exist, when the gate is full of
	 * sessions that are really live, or when the id or directory is unusable. With no rules file nothing
	 * is ever refused here.
	 */
	noteCwd(id: string, cwd: string): boolean;
	/**
	 * `noteCwd` for a launch: the launch id and the correlation id its session will report under, together.
	 * Neither is forgotten to make room for the other, so a launch the gate accepts can always be judged by
	 * both ids. False (a capacity refusal, or an unusable id or directory) when it must be refused.
	 */
	noteLaunch(
		launchId: string,
		correlationId: string,
		cwd: string,
		opts?: { interactive?: boolean },
	): boolean;
	/** Whether this id is the correlation id of an interactive launch this supervisor started (persisted, so it survives a restart). */
	isInteractiveLaunch(id: string): boolean;
	/**
	 * Whether data about this id may leave now. Action handlers ask before they execute anything, with
	 * the directory the action names (never trusted over the one known): "excluded" when either is covered
	 * or the session is unknown while rules exist, "refused" when the action names another directory than
	 * the known one.
	 */
	verdict(id: string | null | undefined, actionCwd?: string): ReportVerdict;
	/** For an action that is not about a session: judged by the directory it names alone. */
	verdictForDirectory(cwd: string | undefined): ReportVerdict;
	rulesState(): "none" | "ok" | "invalid";
	reportState(
		body: ManagedSessionStateInput,
		opts?: ReportStateOptions,
	): Promise<StateReportResult & { outcome: ReportOutcome }>;
	reportEvents(
		sessionId: string,
		events: ManagedSessionEventInput[],
		opts?: ReportEventsOptions,
	): Promise<ReportOutcome>;
	/**
	 * Reports a Codex approval request. Never queued and never a replay. Throws what the server's refusal or
	 * the network threw, for the caller's failure table; a network failure also latches the gate offline.
	 */
	reportApproval(
		sessionId: string,
		body: CodexApprovalReportRequest,
	): Promise<ApprovalReportResult>;
	/**
	 * The host's approvals poll. Entries about a session a rule covers (or whose rules can't be trusted) are
	 * left out; with nothing left, nothing is sent. Never queued; a 10 s limit.
	 */
	syncApprovals(entries: ApprovalSyncEntries): Promise<ApprovalSyncResult>;
	/**
	 * A resume's state report (AGEN-115): live only. It is never queued, never behind a backlog and never a
	 * replay, because the server refuses a report whose resume action has closed and a queued one would
	 * reach it after the process it describes was gone. The session is marked reported, so a rule added later
	 * still closes it. Throws what the server's refusal or the network threw; a network failure also latches
	 * the gate offline. "excluded" and "blocked" send nothing.
	 */
	reportResumeState(body: ManagedSessionStateInput): Promise<ReportOutcome>;
	/**
	 * Fails a resume control action with `error`, once, without judging the session: the gate may not know it
	 * (a resume is refused before the host has noted anything), and `refuseControlAction` would post the
	 * launch sentence. The caller picks the words (one fixed sentence per resume kind while rules exist).
	 * Nothing is posted while the rules are invalid.
	 */
	refuseResume(actionId: string, error: string): Promise<void>;
	/** Drops what `noteLaunch` remembered for a launch that failed before the server heard of it. Never un-marks an excluded session, and keeps one already reported. */
	forgetLaunch(launchId: string, sessionId: string): void;
	/** What the offline outbox holds for this session: nothing, queued entries (also while the outbox hasn't finished listing), or a head it can't trust. */
	queuedState(id: string): "none" | "pending" | "held";
	/** Whether the local rules exclude this absolute path. Invalid rules exclude everything. */
	excludesPath(path: string): boolean;
	/**
	 * What the rules are right now, for deciding what a fork call may send as detail (AGEN-123): none, invalid,
	 * or the physically resolved path of each rule.
	 */
	excludeScope(): ExcludeScope;
	reportLaunchStatus(launchId: string, body: LaunchStatusBody): Promise<void>;
	/** The one fixed status for a launch this host will not start, sent whatever the reason and whatever the rules say. */
	refuseLaunch(launchId: string): Promise<void>;
	/** The one fixed failure for a control action this host will not run, once per action; nothing while the rules are invalid. */
	refuseControlAction(actionId: string): Promise<void>;
	/** `sessionId` is null for an action that is not about a session; `actionCwd` (the directory it names) then decides. */
	reportControlStatus(
		actionId: string,
		sessionId: string | null,
		body: ControlStatusBody,
		actionCwd?: string,
	): Promise<ControlReportOutcome>;
	/** Refreshes the rules (also following moved symlinks), writes the stamp, and closes any reported session a rule now covers. Called on a timer. */
	scan(): Promise<void>;
	/** Sends what the offline outbox holds, oldest first, a bounded amount per call. Called on a timer; a no-op without an outbox or while the server is unreachable. */
	flush(): Promise<void>;
	/** The server could not be reached: later reports are queued without trying it. Cleared by the next sign of life. */
	noteServerUnreachable(): void;
	/** The server answered (a heartbeat, a send): reports go to it again, and the credential tripwire is cleared. */
	noteServerReachable(): void;
	/** The server answered with an error status (a heartbeat or a send): it can be reached, so the offline latch clears; the credential tripwire is not reset. */
	noteServerContact(): void;
	isOffline(): boolean;
}

/** What a provider reads from a state report that was dropped: nothing it can use, but nothing that makes it throw. */
const DROPPED_STATE_RESULT = {
	session: { displayName: "" },
	managedSession: {},
} as unknown as StateReportResult;

/** How long after a flush the host keeps saying what it delivered and lost. */
const OUTBOX_REPORT_AFTER_FLUSH_MS = 24 * 60 * 60 * 1000;

/**
 * What the heartbeat says about the offline outbox: only while it holds something, or within a day of a
 * flush (so a person can see a host has caught up). Otherwise nothing, and the server clears what it had.
 */
export function heartbeatOutbox(summary: OutboxSummary, nowMs: number): OutboxSummary | undefined {
	if (summary.pending > 0) return summary;
	const flushedAt = summary.lastFlushAt ? Date.parse(summary.lastFlushAt) : Number.NaN;
	return Number.isFinite(flushedAt) && nowMs - flushedAt <= OUTBOX_REPORT_AFTER_FLUSH_MS
		? summary
		: undefined;
}

/**
 * The body of a heartbeat. Exclusion says only "invalid" (the one state somebody has to act on); every other
 * state is "none", so the wire never tells the server whether a host uses exclusion. With nothing to say
 * about either, there is no body, which the server reads as "nothing to act on" and clears earlier ones.
 * A body always carries `excludeRulesState`, so an older flag is cleared by a newer body too.
 */
export function heartbeatBody(
	state: "none" | "ok" | "invalid",
	outbox?: OutboxSummary,
): string | undefined {
	if (state !== "invalid" && !outbox) return undefined;
	return JSON.stringify({
		excludeRulesState: state === "invalid" ? "invalid" : "none",
		...(outbox ? { outbox } : {}),
	});
}

export function launchRefusalBody() {
	return {
		status: "failed" as const,
		error: LAUNCH_REFUSED_MESSAGE,
		providerLaunchMetadata: {
			prelaunchError: { code: LAUNCH_REFUSED_CODE, message: LAUNCH_REFUSED_MESSAGE },
		},
	};
}

export function controlRefusalBody() {
	return { status: "failed" as const, error: LAUNCH_REFUSED_MESSAGE };
}

/** The closing report: the terminal state a stop reports, with no cwd, model, title, output or metadata. */
function closingStateBody(sessionId: string) {
	return {
		sessionId,
		status: "completed" as const,
		managedState: "stopped" as const,
		providerSyncState: "synced" as const,
	};
}

/** A state report that says the session has ended. */
function isTerminalReport(body: ManagedSessionStateInput): boolean {
	return (
		body.status === "completed" ||
		body.status === "failed" ||
		body.managedState === "stopped" ||
		body.managedState === "completed" ||
		body.managedState === "failed"
	);
}

/** A directory this account owns that nobody else can write into (POSIX; Windows is judged by its ACL instead). */
export { isTrustedDirectoryStat } from "./private-store.js";

/** A plain file with one link, within the gate's state-file size bound, that only this account can read or write (POSIX). */
export function isTrustedStateFileStat(
	st: Parameters<typeof storeIsTrustedStateFileStat>[0],
	uid: number | undefined,
): boolean {
	return storeIsTrustedStateFileStat(st, uid, MAX_GATE_STATE_BYTES);
}

/**
 * The same directory: the very same string, or two spellings (a trailing slash, a `~`, a symlink to it)
 * that resolve to one real path. A lexical match is not enough, and neither is a path with a `..` in
 * it: `link/../x` reads like a sibling of `link` but the operating system follows `link` first, and
 * the resolvers available here fold the dots away before they look at the disk. Such a spelling is a
 * different directory, as is one that cannot be resolved (the directory is not there).
 */
function sameDirectory(a: string, b: string): boolean {
	if (a === b) return true;
	if (hasParentSegment(a) || hasParentSegment(b)) return false;
	try {
		return realpathSync.native(a) === realpathSync.native(b);
	} catch {
		return false;
	}
}

function hasParentSegment(path: string): boolean {
	return path.split(/[\\/]/).includes("..");
}

export function createReportGate(deps: ReportGateDeps): ReportGate {
	const log = deps.log ?? ((line: string) => console.log(line));
	const now = deps.now ?? Date.now;
	const rules = deps.rules ?? createRulesWatch({ home: deps.home, log });
	const base = `/supervisors/${deps.supervisorId}`;
	const maxTracked = deps.maxTrackedSessions ?? MAX_TRACKED_SESSIONS;
	const statePath = join(deps.home, GATE_STATE_RELATIVE_PATH);

	const sessions = new Map<string, SessionRecord>();
	const closing = new Map<string, Promise<void>>();
	const controlRefused = new Set<string>();
	let stampWarned = false;
	let persistWarned = false;
	let skipWarned = false;

	const outbox = deps.outbox;
	const tripwire = deps.credentialTripwire;
	const random = deps.random ?? Math.random;
	const schedule =
		deps.schedule ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			timer.unref?.();
		});

	/** The server could not be reached; reports are queued behind this until something gets through. */
	let offline = false;
	/** The server has just come back: the next flush waits a random moment first. */
	let settling = false;
	let flushOpen = false;
	/** Something in front of the server (a proxy, an auth edge) is refusing everything: no pass sends before this. */
	let edgeHoldUntilMs = 0;
	let flushing: Promise<void> | null = null;
	/** A session whose sends failed waits before the next one: until when, and how many failures in a row. */
	const backoffs = new Map<string, { untilMs: number; failures: number }>();
	/** How long a queue head has waited on the server's back-pressure in all. */
	const backoffBudgets = new Map<string, { seq: number; waitedMs: number }>();
	const chains = new Map<string, Promise<unknown>>();
	/** Network failures on replay sends so far in this pass: the first backs its session off, a second means the server is gone. */
	let passNetworkFailures = 0;
	/** Moves on whenever the server took a send; a stuck head counts only if it moved since the head last failed. A heartbeat answering proves nothing about the sends. */
	let successEpoch = 0;
	const networkFailEpochs = new Map<string, number>();

	function markOffline() {
		offline = true;
	}
	function markReachable() {
		if (!offline) return;
		offline = false;
		settling = true;
	}
	/** The server was reached and took a request: the credential is good and the path is open. */
	function onContact() {
		successEpoch++;
		tripwire?.reset();
		markReachable();
	}

	async function handleCredential(error: unknown) {
		markCredentialHandled(error);
		if (!tripwire || !deps.onCredentialRejected) return;
		if (tripwire.record() === "confirmed") {
			log("[supervisor] the server rejected this supervisor's credential twice");
			await deps.onCredentialRejected();
		}
	}

	/**
	 * Every request that leaves the gate. `headers` is only ever the delivery id and replay marker. A
	 * success clears the credential tripwire and the offline latch; a credential rejection feeds the
	 * tripwire (which decides whether it ends the supervisor).
	 */
	async function sendText(path: string, text: string, headers?: Record<string, string>) {
		try {
			const result = await deps.request(`${base}${path}`, {
				method: "POST",
				body: text,
				...(headers ? { headers } : {}),
			});
			onContact();
			return result;
		} catch (error) {
			// An answer of any kind (an error status included) shows the server can be reached; only a 2xx
			// shows the credential is good.
			if (error instanceof SupervisorRequestError) markReachable();
			if (classifyReportFailure(error) === "credential") await handleCredential(error);
			throw error;
		}
	}

	/** Runs `fn` after everything already running for this session, so its reports, replays and purge never interleave. */
	function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
		if (!outbox) return fn();
		const previous = chains.get(id) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(fn);
		chains.set(id, next);
		const cleanup = () => {
			if (chains.get(id) === next) chains.delete(id);
		};
		next.then(cleanup, cleanup);
		return next;
	}

	const post = (path: string, body: unknown) => sendText(path, JSON.stringify(body));

	/**
	 * A live send that is never kept for later: the outbox is not consulted and the report is not stamped as
	 * a replay. An unreachable server latches the gate offline, as for any live send, and the error goes
	 * to the caller's failure table.
	 */
	async function sendApproval(path: string, text: string, timeoutMs?: number): Promise<unknown> {
		try {
			const sending = sendText(path, text);
			return timeoutMs === undefined ? await sending : await withDeadline(sending, timeoutMs);
		} catch (error) {
			if (classifyReportFailure(error) === "network") markOffline();
			throw error;
		}
	}
	/**
	 * Gives up on an answer after `ms`, as for a server that never answers: the caller gets a network
	 * failure. The underlying send may still finish later; what it brings back is discarded, and the
	 * server's next poll answer is built from its own state, so nothing is lost by that.
	 */
	function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new SupervisorNetworkError(new Error("timed out"))), ms);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}
	/** A 2xx whose body isn't the contract: not the server's answer, so it reads as a server fault and nothing is acted on. */
	const unreadableApprovalAnswer = () =>
		new SupervisorRequestError(502, "Unreadable answer", "invalid_response");
	const replayHeader = (replay: boolean | undefined): Record<string, string> =>
		replay ? { [REPLAY_HEADER]: "1" } : {};

	const isLive = (rec: SessionRecord) =>
		rec.reported === true && rec.closed !== true && rec.done !== true;

	/** Whether any session is excluded: that exclusion must outlive a restart, so from then on the gate saves whether or not rules exist. */
	let anyExcluded = false;
	/** Whether any session is an interactive launch: that must be remembered too. */
	let anyInteractive = false;
	/** The memory changed while saving was skipped (no rules, nothing excluded); the next scan with rules in place saves it. */
	let unsaved = false;

	function liveCount(): number {
		let live = 0;
		for (const rec of sessions.values()) if (isLive(rec)) live++;
		return live;
	}

	/** An interactive launch whose terminal bridge is still in use: forgetting it would strand the bridge's reports. */
	function protectedBridge(id: string, rec: SessionRecord): boolean {
		return rec.interactive === true && deps.isBridgeActive?.(id) === true;
	}

	/** A session with reports queued is not forgotten: its rules and its closing report still need the gate's memory. */
	const hasQueued = (id: string) => outbox?.hasPending(id) === true;

	/** Makes room for one more session by forgetting one that no longer needs the gate (never one in `keep`); false when there is none. */
	function evictOne(keep: readonly string[]): boolean {
		let fallback: string | undefined;
		for (const [id, rec] of sessions) {
			if (isLive(rec) || keep.includes(id) || protectedBridge(id, rec) || hasQueued(id)) continue;
			if (!rec.excluded) {
				sessions.delete(id);
				return true;
			}
			fallback ??= id;
		}
		if (fallback === undefined) return false;
		sessions.delete(fallback);
		return true;
	}

	/**
	 * `keep` is what the caller has just noted for the same launch: it is never the one forgotten. Only live
	 * sessions count against the bound for a refusal, so what `keep` holds can take the map one past it.
	 */
	function track(id: string, keep: readonly string[] = []): SessionRecord | undefined {
		const existing = sessions.get(id);
		if (existing) return existing;
		if (sessions.size >= maxTracked && !evictOne(keep)) {
			// Nothing left to forget but live sessions and what the caller keeps. With rules in place the launch
			// is refused when the bound's worth of sessions are really live; with no rules file there is nothing
			// to protect, so the oldest goes and nothing is refused.
			if (currentRules().state !== "none") {
				if (liveCount() >= maxTracked) return undefined;
			} else {
				const oldest = [...sessions].find(
					([key, rec]) => !keep.includes(key) && !protectedBridge(key, rec) && !hasQueued(key),
				)?.[0];
				if (oldest !== undefined) sessions.delete(oldest);
			}
		}
		const rec: SessionRecord = {};
		sessions.set(id, rec);
		return rec;
	}

	/** Says once that nothing is being saved because the directory is not private to this account. (With no rules nothing is saved and nothing is said, so a host that never used the feature is never told.) */
	function warnSaveSkipped() {
		if (skipWarned) return;
		const dir = dirname(statePath);
		skipWarned = true;
		log(
			`[supervisor] the report gate's state isn't saved: ${dir} is not private to this account, so a restart will forget what the gate knows. Make it writable only by you.`,
		);
	}

	/**
	 * Saves what the gate knows. `state` is the rules state to go by: by default the one the last decision
	 * saw (a save follows the decision that changed something, so a second look at the disk would only
	 * repeat it); a caller with no decision behind it passes a fresh one.
	 */
	function persist(state: LoadExcludeRulesResult["state"] = lastState) {
		if (!deps.home) return;
		// A host that never used exclusion keeps nothing on disk, with one exception: an interactive terminal
		// launch has to be remembered across a restart, because its bridge outlives the supervisor.
		if (!anyExcluded && !anyInteractive && state === "none") {
			unsaved = true;
			return;
		}
		// Never write over a file that could not be trusted: it is the user's to repair or delete.
		if (stateProblem !== null) return;
		if (!trustedDirectory(dirname(statePath))) {
			warnSaveSkipped();
			return;
		}
		// No prototype, so an id such as "__proto__" is an ordinary key.
		const saved: Record<string, SessionRecord> = Object.create(null);
		for (const [id, rec] of sessions) saved[id] = rec;
		try {
			writePrivateFileAtomicNoFollow(
				statePath,
				`${JSON.stringify({ version: GATE_STATE_VERSION, sessions: saved })}\n`,
			);
			unsaved = false;
		} catch (error) {
			if (!persistWarned) {
				persistWarned = true;
				log(
					`[supervisor] couldn't save what the report gate knows; a restart will forget it: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	}

	/** Why the saved state cannot be trusted, while it can't; null otherwise. */
	let stateProblem: string | null = null;

	/** What is on disk at the state file's path: nothing, a file this account owns privately, or something that is not to be believed. */
	function readStateFile():
		| { kind: "absent" }
		| { kind: "ok"; entries: [string, SessionRecord][] }
		| { kind: "untrusted"; why: string } {
		if (!deps.home) return { kind: "absent" };
		const found = readPrivateFileNoFollow(statePath, MAX_GATE_STATE_BYTES);
		if (found.kind !== "ok") return found;
		try {
			const entries = readSavedSessions(JSON.parse(found.text));
			return entries === null
				? { kind: "untrusted", why: "it is not a state file this version understands" }
				: { kind: "ok", entries };
		} catch {
			return { kind: "untrusted", why: "it could not be read" };
		}
	}

	/**
	 * Looks at the saved state: at start, and again whenever it was found untrustworthy (so repairing or
	 * deleting the file is enough, with no restart). An untrustworthy file is not an empty one: the gate
	 * then behaves as it does for invalid rules, nothing is reported or run, until it is fixed.
	 */
	function checkStateFile() {
		const found = readStateFile();
		if (found.kind === "untrusted") {
			if (stateProblem === null) {
				log(
					`[supervisor] the report gate's saved state at ${statePath} can't be trusted (${found.why}), so no session is reported and no launch or action runs. Repair its permissions (a plain file only you can read, in a directory only you can write to): that keeps what the gate knows. Or delete it: sessions that are already running then become unknown to this supervisor, get no closing report, and stay live on the dashboard until the sweep.`,
				);
			}
			stateProblem = found.why;
			return;
		}
		if (stateProblem !== null) log("[supervisor] the report gate's saved state is usable again");
		stateProblem = null;
		if (found.kind === "ok") {
			for (const [id, rec] of found.entries.slice(-maxTracked)) {
				sessions.set(id, rec);
				if (rec.excluded) anyExcluded = true;
				if (rec.interactive) anyInteractive = true;
			}
		}
	}

	const STATE_UNTRUSTED: LoadExcludeRulesResult = {
		state: "invalid",
		rules: [],
		reason: "the report gate's saved state cannot be trusted",
	};

	let lastState: LoadExcludeRulesResult["state"] = "none";

	/** The rules as the gate must judge by: the file's, unless the saved state is untrustworthy, which counts as invalid. */
	function currentRules(): LoadExcludeRulesResult {
		if (stateProblem !== null) checkStateFile();
		const now = stateProblem !== null ? STATE_UNTRUSTED : rules.current();
		lastState = now.state;
		return now;
	}

	function expandHome(cwd: string): string {
		if (cwd === "~") return deps.home;
		return cwd.startsWith("~/") ? join(deps.home, cwd.slice(2)) : cwd;
	}

	function noteCwd(id: string, cwd: string, keep: readonly string[] = []): boolean {
		if (!id || id.length > MAX_SESSION_ID_LENGTH || typeof cwd !== "string" || !cwd) {
			// Nothing can be remembered for this one. Before the gate existed such a launch went ahead,
			// and with no rules file it still does; with rules it can't be judged, so it is refused.
			return currentRules().state === "none";
		}
		const known = sessions.get(id);
		if (known && (known.cwd !== undefined || known.excluded)) return true;
		const rec = track(id, keep);
		if (!rec) return false;
		if (cwd.length <= MAX_CWD_LENGTH) rec.cwd = expandHome(cwd);
		persist(currentRules().state);
		return true;
	}

	function noteLaunch(
		launchId: string,
		correlationId: string,
		cwd: string,
		opts?: { interactive?: boolean },
	): boolean {
		const noted =
			noteCwd(launchId, cwd, [correlationId]) &&
			noteCwd(correlationId, cwd, [launchId, correlationId]);
		if (noted && opts?.interactive) {
			const rec = sessions.get(correlationId);
			if (rec && !rec.interactive) {
				rec.interactive = true;
				anyInteractive = true;
				persist(currentRules().state);
			}
		}
		return noted;
	}

	function markExcluded(id: string | null | undefined) {
		const rec = id ? sessions.get(id) : undefined;
		if (!rec || rec.excluded) return;
		rec.excluded = true;
		anyExcluded = true;
		// What is left of an excluded session is only that it is excluded: not where it was.
		rec.cwd = undefined;
		persist();
	}

	function covered(cwd: string, state: LoadExcludeRulesResult): boolean {
		return evaluateExclusion({ cwd, skip: undefined, rules: state }).excluded;
	}

	function judge(
		id: string | null | undefined,
		state: LoadExcludeRulesResult,
		actionCwd?: string,
	): ReportVerdict {
		if (state.state === "invalid") return "blocked";
		const rec = id ? sessions.get(id) : undefined;
		if (rec?.excluded) return "excluded";
		if (state.state === "none") return "send";
		if (rec?.cwd === undefined) {
			markExcluded(id);
			return "excluded";
		}
		if (covered(rec.cwd, state)) {
			markExcluded(id);
			return "excluded";
		}
		if (actionCwd !== undefined) {
			const named = expandHome(actionCwd);
			if (covered(named, state)) {
				markExcluded(id);
				return "excluded";
			}
			if (!sameDirectory(rec.cwd, named)) return "refused";
		}
		return "send";
	}

	/** One signature check per decision: two stat calls, and a read only when the rules changed. */
	function decide(id: string | null | undefined, actionCwd?: string): ReportVerdict {
		return judge(id, currentRules(), actionCwd);
	}

	function decideDirectory(cwd: string | undefined): ReportVerdict {
		const state = currentRules();
		if (state.state === "invalid") return "blocked";
		if (state.state === "none") return "send";
		return cwd === undefined || covered(expandHome(cwd), state) ? "excluded" : "send";
	}

	/** Called only once a report about this session was delivered. `done` is given for a state report: terminal releases the session, anything else makes it live again. */
	function markReported(id: string, done?: boolean) {
		const rec = track(id);
		if (!rec) {
			log("[supervisor] too many live sessions to follow; a later exclusion cannot close this one");
			return;
		}
		const wasDone = rec.done === true;
		if (rec.reported && (done === undefined || done === wasDone)) return;
		rec.reported = true;
		if (done !== undefined) {
			if (done) rec.done = true;
			else rec.done = undefined;
		}
		persist();
	}

	/** The single contentless closing report for a session this gate has reported on; retried by the next scan if it could not be delivered. */
	async function closeIfNeeded(sessionId: string): Promise<void> {
		const rec = sessions.get(sessionId);
		if (!rec || !isLive(rec)) return;
		const inFlight = closing.get(sessionId);
		if (inFlight) return inFlight;
		const attempt = (async () => {
			try {
				await post("/managed-session-state", closingStateBody(sessionId));
				rec.closed = true;
				persist();
			} catch (error) {
				log(
					`[supervisor] couldn't send the closing report for an excluded session (will retry): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		})();
		closing.set(sessionId, attempt);
		try {
			await attempt;
		} finally {
			closing.delete(sessionId);
		}
	}

	/** Which of the two things that fail closed is the one that did, so a local check can say so (never a path). */
	const invalidCause = () => (stateProblem !== null ? "state_file" : "exclude_file");

	function writeStamp(rulesState: string, cause?: "exclude_file" | "state_file") {
		const path = join(deps.home, SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH);
		if (!deps.home || !existsSync(dirname(path))) return;
		const stamp = JSON.stringify({
			version: deps.version ?? "",
			rulesState,
			...(cause ? { cause } : {}),
			at: new Date(now()).toISOString(),
		});
		try {
			writePrivateFileAtomicNoFollow(path, `${stamp}\n`);
		} catch (error) {
			if (!stampWarned) {
				stampWarned = true;
				log(
					`[supervisor] couldn't write the exclude-state stamp: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	}

	async function refuseControlAction(actionId: string): Promise<void> {
		if (currentRules().state === "invalid" || controlRefused.has(actionId)) return;
		controlRefused.add(actionId);
		if (controlRefused.size > maxTracked) {
			const oldest = controlRefused.values().next().value;
			if (oldest !== undefined) controlRefused.delete(oldest);
		}
		await post(`/control-actions/${actionId}/status`, controlRefusalBody());
	}

	// ── offline outbox ──

	/** A report goes behind what is already queued when the server is unreachable, the session has queued reports (order!), or the outbox has not yet listed what an earlier run left. */
	function queueBehind(id: string): boolean {
		if (!outbox?.enabled) return false;
		return offline || !outbox.listed() || outbox.hasPending(id);
	}

	function keep(
		id: string,
		kind: "state" | "events",
		text: string,
		attempted: boolean,
		deliveryId: string | undefined,
		cause?: unknown,
	): { outcome: "queued" } {
		const kept = outbox?.append(id, { kind, body: text, attempted, deliveryId });
		if (kept === "queued") return { outcome: "queued" };
		// Nothing could keep it: the caller is told, as it would be without an outbox.
		throw cause ?? new Error("The offline outbox couldn't keep this report.");
	}

	/** The wait before this session's next send after a failure; a non-escalating one (back-pressure) doesn't grow the next wait. */
	function noteSessionFailure(id: string, error: unknown, escalate: boolean): number {
		const previous = backoffs.get(id) ?? { untilMs: 0, failures: 0 };
		const retryAfter = error instanceof SupervisorRequestError ? error.retryAfterMs : undefined;
		const wait = escalate
			? sessionBackoffMs(previous.failures, retryAfter, random)
			: Math.max(retryAfter ?? 0, 1_000);
		backoffs.set(id, {
			untilMs: now() + wait,
			failures: previous.failures + (escalate ? 1 : 0),
		});
		return wait;
	}

	/** Sends a state or events report now, or keeps it when the server can't take it. */
	async function deliver(
		id: string,
		kind: "state" | "events",
		path: string,
		text: string,
		headers: Record<string, string> | undefined,
		deliveryId?: string,
	): Promise<{ outcome: "sent"; result: unknown } | { outcome: "queued" }> {
		if (queueBehind(id)) return keep(id, kind, text, false, deliveryId);
		try {
			const result = await sendText(path, text, headers);
			backoffs.delete(id);
			return { outcome: "sent", result };
		} catch (error) {
			if (!outbox?.enabled) throw error;
			const failure = classifyReportFailure(error);
			// A 401 or 403 that isn't the server's own credential wording comes from something in front of it:
			// the report is kept as back-pressure, and the whole flush holds off, as for a queued one.
			const edge = failure === "stop" && isEdgeRejection(error);
			if (failure !== "network" && failure !== "server" && failure !== "backoff" && !edge)
				throw error;
			if (failure === "network") markOffline();
			else {
				const wait = noteSessionFailure(id, error, failure === "server");
				if (edge) edgeHoldUntilMs = now() + wait;
			}
			return keep(id, kind, text, true, deliveryId, error);
		}
	}

	/** A 401 or 403 that isn't the server's own credential rejection. */
	function isEdgeRejection(error: unknown): boolean {
		return (
			error instanceof SupervisorRequestError && (error.status === 401 || error.status === 403)
		);
	}

	/** Whether the server has a record of this session from us: events for one it has never heard of can't be stored. */
	const serverKnows = (id: string) => sessions.get(id)?.reported === true;

	/**
	 * Sends the session's oldest queued state report ahead of the events before it, as it is: it is the one
	 * that creates the session on a server with no row for it, and the server reads a creating report
	 * differently from a later one (a title names the session, an agent type sticks), so it is neither folded
	 * nor reordered with the reports after it, which stay queued in their order.
	 */
	async function sendCreator(
		id: string,
		creator: OutboxEntry,
	): Promise<"sent" | "network" | "failed"> {
		try {
			await sendText("/managed-session-state", creator.body, replayHeader(true));
		} catch (error) {
			if (classifyReportFailure(error) === "network") {
				markOffline();
				return "network";
			}
			return "failed";
		}
		outbox?.remove(id, creator.seq, "delivered");
		markReported(id, terminalOf(creator.body));
		backoffs.delete(id);
		backoffBudgets.delete(id);
		return "sent";
	}

	/**
	 * What to do with a queue head whose send failed. `continue` goes on to the next entry, `next` leaves
	 * this session for the next pass, `all` ends the pass.
	 */
	async function afterFailure(
		id: string,
		head: OutboxEntry,
		error: unknown,
	): Promise<"continue" | "next" | "all"> {
		if (!outbox) return "next";
		const failure = classifyReportFailure(error);
		let network = failure === "network";
		if (failure === "credential") {
			// A rejection the tripwire has not confirmed (the first, or any over plain http to a non-local server,
			// where none is ever acted on): the entry stays and is not counted against, and the session waits out
			// a backoff instead of being tried again by the next flush 3 s later.
			noteSessionFailure(id, error, true);
			return "next";
		}
		if (failure === "session") {
			outbox.purge(id, { countLost: true });
			return "next";
		}
		if (failure === "entry") {
			outbox.remove(id, head.seq, "lost");
			return "continue";
		}
		if (failure === "other") {
			log(
				`[supervisor] a queued report couldn't be sent for a local reason; will retry: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "next";
		}
		const status = error instanceof SupervisorRequestError ? error.status : 0;
		// A 500 for events of a session the server has no row for yet: the state report that creates it may be
		// queued behind them, so it goes first.
		const missingRow =
			failure === "server" && status === 500 && head.kind !== "state" && !serverKnows(id);
		if (missingRow) {
			const creator = outbox.queuedStates(id)[0];
			if (creator) {
				const result = await sendCreator(id, creator);
				if (result === "sent") return "continue";
				if (result === "network") network = true;
			}
		}
		// No answer to a replay send. One stuck entry must not stall everyone else's replay, and a genuine
		// outage must cost nothing: the first such failure in a pass backs this session off without counting
		// it and moves on; a second means the server is gone, so the pass ends and the gate goes offline.
		if (network && ++passNetworkFailures >= 2) {
			markOffline();
			return "all";
		}
		// A 401 or 403 that isn't the server's own credential wording comes from something in front of it (a
		// proxy, an auth edge, a captive portal) and says nothing about this report.
		const edge = failure === "stop" && isEdgeRejection(error);
		// The server's own back-pressure, those, and a row-less 500 are waiting, not failing. They count only
		// once a head has waited longer than the budget.
		const waiting = network || failure === "backoff" || missingRow || edge;
		let counts = !waiting;
		if (counts) {
			noteSessionFailure(id, error, true);
		} else {
			const wait = noteSessionFailure(id, error, network || missingRow || edge);
			const budget = backoffBudgets.get(id);
			const spent = (budget?.seq === head.seq ? budget.waitedMs : 0) + wait;
			backoffBudgets.set(id, { seq: head.seq, waitedMs: spent });
			counts = spent > BACKOFF_BUDGET_MS;
			if (network) {
				// Counts only if the server took a send since this head last failed: a heartbeat can answer while
				// every replay times out, which is the host's connection, not this entry.
				const movedOn = successEpoch > (networkFailEpochs.get(id) ?? -1);
				networkFailEpochs.set(id, successEpoch);
				counts = counts && movedOn;
			}
			// The edge is in front of every session: the whole pass waits, not just this one.
			if (edge) edgeHoldUntilMs = now() + wait;
		}
		const verdict = outbox.recordFailure(id, head.seq, now(), { counts });
		if (verdict === "poisoned") {
			log("[supervisor] a queued report kept failing and was dropped");
			backoffBudgets.delete(id);
			return "continue";
		}
		return edge ? "all" : "next";
	}

	function terminalOf(body: string): boolean | undefined {
		try {
			return isTerminalReport(JSON.parse(body) as ManagedSessionStateInput);
		} catch {
			return undefined;
		}
	}

	/** One send for a session, on its chain: judge, take the head, send it, settle the answer. */
	async function flushStep(id: string, budget: { left: number }): Promise<"sent" | "next" | "all"> {
		if (!outbox) return "next";
		const verdict = decide(id);
		if (verdict === "blocked") return "all";
		if (verdict === "excluded") {
			outbox.purge(id);
			await closeIfNeeded(id);
			return "next";
		}
		if (verdict !== "send") return "next";
		const wait = backoffs.get(id);
		if (wait && now() < wait.untilMs) return "next";
		const head = outbox.head(id);
		if (head === null || head === "held") return "next";
		if (head.kind !== "state" && !outbox.markAttempted(id, head.seq)) return "next";
		budget.left--;
		try {
			if (head.kind === "state") {
				await sendText("/managed-session-state", head.body, replayHeader(true));
			} else {
				await sendText(`/managed-sessions/${id}/events`, head.body, {
					...(head.deliveryId ? { [DELIVERY_ID_HEADER]: head.deliveryId } : {}),
					...replayHeader(true),
				});
			}
		} catch (error) {
			const next = await afterFailure(id, head, error);
			return next === "continue" ? "sent" : next;
		}
		outbox.remove(id, head.seq, "delivered");
		markReported(id, head.kind === "state" ? terminalOf(head.body) : undefined);
		backoffs.delete(id);
		backoffBudgets.delete(id);
		return "sent";
	}

	/**
	 * One session's turn in a flush: its sends, one at a time, up to its share. The session's chain is taken
	 * for each send, not for the whole turn, so a live report for it waits for at most one send.
	 */
	async function flushSession(id: string, budget: { left: number }): Promise<"next" | "all"> {
		let sentHere = 0;
		while (sentHere < FLUSH_MAX_PER_SESSION && budget.left > 0) {
			const step = await serialize(id, () => flushStep(id, budget));
			if (step === "sent") {
				sentHere++;
				continue;
			}
			return step;
		}
		return "next";
	}

	async function flushPass(): Promise<void> {
		if (!outbox?.enabled || offline) return;
		if (now() < edgeHoldUntilMs) return;
		if (settling && outbox.sessions().length > 0) {
			settling = false;
			await new Promise<void>((resolve) =>
				schedule(resolve, Math.round(random() * RECONNECT_JITTER_MS)),
			);
			if (offline) return;
		}
		outbox.ageOut(now());
		if (!flushOpen) {
			outbox.beginFlush();
			flushOpen = true;
		}
		for (const dir of outbox.unknownDirs()) outbox.purgeDir(dir);
		const budget = { left: FLUSH_MAX_PER_PASS };
		passNetworkFailures = 0;
		for (const id of [...networkFailEpochs.keys()]) {
			if (!outbox.hasPending(id)) networkFailEpochs.delete(id);
		}
		for (const id of outbox.sessions()) {
			if (budget.left <= 0 || offline) break;
			if ((await flushSession(id, budget)) === "all") break;
		}
		if (flushOpen && outbox.summary().pending === 0) {
			outbox.endFlush(new Date(now()).toISOString());
			flushOpen = false;
		}
	}

	function flush(): Promise<void> {
		if (flushing) return flushing;
		flushing = flushPass().finally(() => {
			flushing = null;
		});
		return flushing;
	}

	checkStateFile();

	return {
		noteCwd: (id, cwd) => noteCwd(id, cwd),
		noteLaunch,
		isInteractiveLaunch: (id) => sessions.get(id)?.interactive === true,
		verdict: decide,
		verdictForDirectory: decideDirectory,
		rulesState: () => currentRules().state,

		async reportState(body, opts) {
			const id = body.sessionId;
			return serialize(id, async () => {
				const verdict = decide(id);
				if (verdict === "send") {
					const headers = replayHeader(opts?.replay);
					const delivery = await deliver(
						id,
						"state",
						"/managed-session-state",
						JSON.stringify(body),
						Object.keys(headers).length > 0 ? headers : undefined,
					);
					if (delivery.outcome === "queued") return { ...DROPPED_STATE_RESULT, outcome: "queued" };
					markReported(id, isTerminalReport(body));
					return {
						...((delivery.result as StateReportResult | undefined) ?? DROPPED_STATE_RESULT),
						outcome: "sent",
					};
				}
				if (verdict === "excluded") {
					if (outbox?.hasPending(id)) outbox.purge(id);
					await closeIfNeeded(id);
				}
				// A copy: the shared dropped result is never written to.
				return {
					...DROPPED_STATE_RESULT,
					outcome: verdict === "excluded" ? "excluded" : "blocked",
				};
			});
		},

		async reportEvents(sessionId, events, opts) {
			return serialize(sessionId, async () => {
				const verdict = decide(sessionId);
				if (verdict === "send") {
					// One body, built once: a resend of the same delivery id carries the same bytes.
					const stampedAt = new Date(now()).toISOString();
					const text = JSON.stringify({
						events: events.map((event) => ({
							...event,
							// What the server would refuse (an over-long content) is cut here, not lost with its batch.
							content: clampEventContent(event.content),
							occurredAt: event.occurredAt ?? stampedAt,
						})),
					});
					const deliveryId = opts?.deliveryId ?? randomUUID();
					const delivery = await deliver(
						sessionId,
						"events",
						`/managed-sessions/${sessionId}/events`,
						text,
						{ [DELIVERY_ID_HEADER]: deliveryId, ...replayHeader(opts?.replay) },
						deliveryId,
					);
					if (delivery.outcome === "queued") return "queued";
					markReported(sessionId);
					return "sent";
				}
				if (verdict === "excluded") {
					if (outbox?.hasPending(sessionId)) outbox.purge(sessionId);
					await closeIfNeeded(sessionId);
					return "excluded";
				}
				return "blocked";
			});
		},

		async reportResumeState(body) {
			const id = body.sessionId;
			return serialize(id, async () => {
				const verdict = decide(id);
				if (verdict === "excluded") {
					await closeIfNeeded(id);
					return "excluded";
				}
				if (verdict !== "send") return "blocked";
				await sendApproval("/managed-session-state", JSON.stringify(body));
				markReported(id, isTerminalReport(body));
				return "sent";
			});
		},

		async refuseResume(actionId, error) {
			if (currentRules().state === "invalid") return;
			await post(`/control-actions/${actionId}/status`, { status: "failed", error });
		},

		forgetLaunch(launchId, sessionId) {
			let changed = false;
			for (const key of [launchId, sessionId]) {
				const rec = sessions.get(key);
				if (!rec || rec.excluded || rec.reported) continue;
				sessions.delete(key);
				changed = true;
			}
			if (changed) persist();
		},

		queuedState(id) {
			if (!outbox?.enabled) return "none";
			if (!(outbox.listed() ? outbox.hasPending(id) : true)) return "none";
			return outbox.head(id) === "held" ? "held" : "pending";
		},

		async reportApproval(sessionId, body) {
			const verdict = decide(sessionId);
			if (verdict !== "send") return { outcome: verdict === "excluded" ? "excluded" : "blocked" };
			const response = parseApprovalReportResponse(
				await sendApproval(`/managed-sessions/${sessionId}/approvals`, JSON.stringify(body)),
			);
			if (!response) throw unreadableApprovalAnswer();
			return { outcome: "sent", response };
		},

		async syncApprovals(entries) {
			const sendable = (item: { sessionId: string }) => decide(item.sessionId) === "send";
			const live = entries.live.filter(sendable).map(({ approvalId, revision }) => ({
				approvalId,
				revision,
			}));
			const resolved = entries.resolved
				.filter(sendable)
				.map(({ approvalId, outcome, sentDecision }) => ({ approvalId, outcome, sentDecision }));
			if (live.length === 0 && resolved.length === 0) return { outcome: "empty" };
			const response = parseApprovalSyncResponse(
				await sendApproval(
					"/approvals/sync",
					JSON.stringify({ v: 1, live, resolved }),
					CODEX_SYNC_TIMEOUT_MS,
				),
			);
			if (!response) throw unreadableApprovalAnswer();
			return { outcome: "sent", response };
		},

		excludesPath(path) {
			const state = currentRules();
			if (state.state === "invalid") return true;
			return state.state === "none" ? false : covered(expandHome(path), state);
		},

		excludeScope() {
			const state = currentRules();
			if (state.state === "invalid") return { state: "invalid" };
			if (state.state === "none") return { state: "none" };
			return { state: "ok", paths: state.rules.map((rule) => rule.resolved) };
		},

		async reportLaunchStatus(launchId, body) {
			if (decide(launchId) === "send") await post(`/launches/${launchId}/status`, body);
		},

		async refuseLaunch(launchId) {
			await post(`/launches/${launchId}/status`, launchRefusalBody());
		},

		refuseControlAction,

		async reportControlStatus(actionId, sessionId, body, actionCwd) {
			const verdict = sessionId ? decide(sessionId) : decideDirectory(actionCwd);
			if (verdict === "send") {
				const answer = (await post(`/control-actions/${actionId}/status`, body)) as {
					action?: { status?: unknown } | null;
				} | null;
				const status = answer?.action?.status;
				return {
					outcome: "sent",
					action: typeof status === "string" ? { status } : null,
				};
			}
			if (verdict === "excluded") await refuseControlAction(actionId);
			return { outcome: verdict };
		},

		async scan() {
			if (stateProblem !== null) checkStateFile();
			const state = stateProblem !== null ? STATE_UNTRUSTED : rules.rescan();
			writeStamp(state.state, state.state === "invalid" ? invalidCause() : undefined);
			lastState = state.state;
			if (unsaved && state.state !== "none") persist();
			if (state.state === "invalid") return;
			for (const [sessionId, rec] of [...sessions]) {
				if (!isLive(rec)) continue;
				if (judge(sessionId, state) === "excluded") {
					await serialize(sessionId, () => closeIfNeeded(sessionId));
				}
			}
			// What the outbox holds for a session a rule now covers goes too, held entries included.
			for (const sessionId of outbox?.sessions() ?? []) {
				if (judge(sessionId, state) !== "excluded") continue;
				await serialize(sessionId, async () => {
					outbox?.purge(sessionId);
					await closeIfNeeded(sessionId);
				});
			}
		},

		flush,
		noteServerUnreachable: markOffline,
		noteServerReachable() {
			tripwire?.reset();
			markReachable();
		},
		noteServerContact: markReachable,
		isOffline: () => offline,
	};
}

/** What an earlier run saved, validated entry by entry; null when the file is not the gate's. Bad entries are dropped, which can only make a session unknown (and so quiet). */
function readSavedSessions(parsed: unknown): [string, SessionRecord][] | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const file = parsed as { version?: unknown; sessions?: unknown };
	if (file.version !== GATE_STATE_VERSION) return null;
	if (typeof file.sessions !== "object" || file.sessions === null) return null;
	const out: [string, SessionRecord][] = [];
	for (const [id, raw] of Object.entries(file.sessions)) {
		if (!id || id.length > MAX_SESSION_ID_LENGTH || typeof raw !== "object" || raw === null)
			continue;
		const entry = raw as Record<string, unknown>;
		const rec: SessionRecord = {};
		if (entry.excluded === true) rec.excluded = true;
		else if (typeof entry.cwd === "string" && entry.cwd && entry.cwd.length <= MAX_CWD_LENGTH) {
			rec.cwd = entry.cwd;
		}
		if (entry.reported === true) rec.reported = true;
		if (entry.closed === true) rec.closed = true;
		if (entry.done === true) rec.done = true;
		if (entry.interactive === true) rec.interactive = true;
		out.push([id, rec]);
	}
	return out;
}
