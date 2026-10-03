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
 * A host with no rules file pays nothing for any of this. While there are no rules
 * and nothing is excluded, the gate keeps its memory in the process only (no state
 * file is created or written), and a full memory forgets its oldest session instead
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
import {
	constants,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	type LoadExcludeRulesResult,
	MAX_CWD_LENGTH,
	checkWindowsSecurityAt,
	evaluateExclusion,
} from "../../shared/exclude-rules.js";
import { SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH } from "../../shared/hook-headers.js";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import type {
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	Session,
} from "../../shared/types.js";
import { type RulesWatch, createRulesWatch } from "./exclude-rules-watch.js";

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
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

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
};

export type StateReportResult = { session: Session; managedSession: ManagedSession };

export interface ReportGateDeps {
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
}

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
	noteLaunch(launchId: string, correlationId: string, cwd: string): boolean;
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
	reportState(body: ManagedSessionStateInput): Promise<StateReportResult>;
	reportEvents(sessionId: string, events: ManagedSessionEventInput[]): Promise<void>;
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
	): Promise<void>;
	/** Refreshes the rules (also following moved symlinks), writes the stamp, and closes any reported session a rule now covers. Called on a timer. */
	scan(): Promise<void>;
}

/** What a provider reads from a state report that was dropped: nothing it can use, but nothing that makes it throw. */
const DROPPED_STATE_RESULT = {
	session: { displayName: "" },
	managedSession: {},
} as unknown as StateReportResult;

/**
 * The body of a heartbeat, given what the gate says about the rules: only "invalid" is said (it is the one
 * state somebody has to act on). Every other state sends no body, so the wire never tells the server
 * whether a host uses exclusion; the server reads a heartbeat with no body as "nothing to act on" and
 * clears an earlier warning.
 */
export function heartbeatBody(state: "none" | "ok" | "invalid"): string | undefined {
	return state === "invalid" ? JSON.stringify({ excludeRulesState: "invalid" }) : undefined;
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

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
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

type DirectoryStat = { isDirectory(): boolean; uid: number; mode: number };
type FileStat = { isFile(): boolean; nlink: number; size: number; uid: number; mode: number };

/** A directory this account owns that nobody else can write into (POSIX; Windows is judged by its ACL instead). */
export function isTrustedDirectoryStat(st: DirectoryStat, uid: number | undefined): boolean {
	if (!st.isDirectory()) return false;
	if (uid !== undefined && st.uid !== uid) return false;
	return (st.mode & 0o022) === 0;
}

/** A plain file with one link, within the size bound, that only this account can read or write (POSIX). */
export function isTrustedStateFileStat(st: FileStat, uid: number | undefined): boolean {
	return (
		st.isFile() &&
		st.nlink === 1 &&
		st.size <= MAX_GATE_STATE_BYTES &&
		(uid === undefined || st.uid === uid) &&
		(st.mode & 0o077) === 0
	);
}

function trustedDirectory(dir: string): boolean {
	try {
		const st = lstatSync(dir);
		if (process.platform === "win32")
			return st.isDirectory() && checkWindowsSecurityAt(dir) === null;
		return isTrustedDirectoryStat(st, process.getuid?.());
	} catch {
		return false;
	}
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

	const post = (path: string, body: unknown) =>
		deps.request(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

	const isLive = (rec: SessionRecord) =>
		rec.reported === true && rec.closed !== true && rec.done !== true;

	/** Whether any session is excluded: that exclusion must outlive a restart, so from then on the gate saves whether or not rules exist. */
	let anyExcluded = false;
	/** The memory changed while saving was skipped (no rules, nothing excluded); the next scan with rules in place saves it. */
	let unsaved = false;

	function liveCount(): number {
		let live = 0;
		for (const rec of sessions.values()) if (isLive(rec)) live++;
		return live;
	}

	/** Makes room for one more session by forgetting one that no longer needs the gate (never one in `keep`); false when there is none. */
	function evictOne(keep: readonly string[]): boolean {
		let fallback: string | undefined;
		for (const [id, rec] of sessions) {
			if (isLive(rec) || keep.includes(id)) continue;
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
				const oldest = [...sessions.keys()].find((key) => !keep.includes(key));
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
		if (!anyExcluded && state === "none") {
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
		const dir = dirname(statePath);
		try {
			lstatSync(dir);
		} catch (error) {
			return isMissing(error)
				? { kind: "absent" }
				: { kind: "untrusted", why: "its directory cannot be inspected" };
		}
		if (!trustedDirectory(dir)) {
			// Nothing in a directory others can write into is believed; no file there is no problem (nothing is saved there either).
			try {
				lstatSync(statePath);
			} catch (error) {
				return isMissing(error)
					? { kind: "absent" }
					: { kind: "untrusted", why: "its directory is not private to this account" };
			}
			return { kind: "untrusted", why: "its directory is not private to this account" };
		}
		let fd: number;
		try {
			fd = openSync(statePath, constants.O_RDONLY | O_NOFOLLOW);
		} catch (error) {
			return isMissing(error)
				? { kind: "absent" }
				: { kind: "untrusted", why: "it cannot be opened as a plain file" };
		}
		try {
			const st = fstatSync(fd);
			const trusted =
				process.platform === "win32"
					? st.isFile() && st.nlink === 1 && st.size <= MAX_GATE_STATE_BYTES
					: isTrustedStateFileStat(st, process.getuid?.());
			if (!trusted)
				return { kind: "untrusted", why: "it is not a private plain file of this account" };
			const entries = readSavedSessions(JSON.parse(readFileSync(fd, "utf-8")));
			return entries === null
				? { kind: "untrusted", why: "it is not a state file this version understands" }
				: { kind: "ok", entries };
		} catch {
			return { kind: "untrusted", why: "it could not be read" };
		} finally {
			closeSync(fd);
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

	function noteLaunch(launchId: string, correlationId: string, cwd: string): boolean {
		return (
			noteCwd(launchId, cwd, [correlationId]) &&
			noteCwd(correlationId, cwd, [launchId, correlationId])
		);
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

	checkStateFile();

	return {
		noteCwd: (id, cwd) => noteCwd(id, cwd),
		noteLaunch,
		verdict: decide,
		verdictForDirectory: decideDirectory,
		rulesState: () => currentRules().state,

		async reportState(body) {
			const id = body.sessionId;
			const verdict = decide(id);
			if (verdict === "send") {
				const result = (await post("/managed-session-state", body)) as StateReportResult;
				markReported(id, isTerminalReport(body));
				return result;
			}
			if (verdict === "excluded") await closeIfNeeded(id);
			return DROPPED_STATE_RESULT;
		},

		async reportEvents(sessionId, events) {
			const verdict = decide(sessionId);
			if (verdict === "send") {
				await post(`/managed-sessions/${sessionId}/events`, { events });
				markReported(sessionId);
			} else if (verdict === "excluded") {
				await closeIfNeeded(sessionId);
			}
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
				await post(`/control-actions/${actionId}/status`, body);
			} else if (verdict === "excluded") {
				await refuseControlAction(actionId);
			}
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
				if (judge(sessionId, state) === "excluded") await closeIfNeeded(sessionId);
			}
		},
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
		out.push([id, rec]);
	}
	return out;
}
