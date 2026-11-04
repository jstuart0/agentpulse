/**
 * Answers every request the Codex app-server makes of us (AGEN-87, D5, D10, D11, D16, D17). A request the
 * app-server sends and nobody answers hangs the turn with no sign anywhere, so this is the one place that
 * decides what each method gets, and the rule is default-deny: **a request is declined unless the
 * server issued an accept for that exact held request, at the revision that was held, in a sync response
 * that arrived within 3 s, on this runtime, with the rules, the protocol verdict and the Stop fence still
 * allowing it.** Exactly one function, `deliverAccept`, can write `accept` to Codex; everything else that
 * answers a request writes `decline`, `cancel` or the empty answer that measures as a refusal.
 *
 * Boundary, stated plainly: this host supplies both the text a person is shown and the process that runs.
 * Nothing here can make a compromised host honest; it makes sure a stale view, a changed revision, a
 * replay, a late response or a second answer can't turn into a command running.
 *
 * Nothing the agent wrote (a command, a path, Codex's reason) is put into a warning; warnings carry fixed
 * text and fixed codes only. A request is never kept for later: it is reported live or declined.
 */
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
	type ApprovalDecision,
	CODEX_APPROVALS_SERVER_FEATURE,
	CODEX_APPROVAL_LIMITS,
	CODEX_APPROVAL_TTL_MS,
	CODEX_FILE_DIFF_WAIT_MS,
	CODEX_REPORT_MIN_REMAINING_MS,
	CODEX_RESOLVED_WAIT_MS,
	CODEX_SESSION_UNKNOWN_RETRY_MS,
	CODEX_SLOW_SYNC_RESPONSE_MS,
	CODEX_TRACKER_DEADLINE_MS,
	type CodexApprovalResolved,
	TRACKER_OUTCOME_TABLE,
	type TrackerOutcome,
} from "../../shared/codex-approvals.js";
import type { ReportGate } from "../services/report-gate.js";
import { SupervisorRequestError, classifyReportFailure } from "../services/report-resilience.js";
import {
	type BufferedChange,
	COMMAND_APPROVAL_METHOD,
	FILE_CHANGE_APPROVAL_METHOD,
	type ParsedApproval,
	buildReportBody,
	parseApprovalParams,
	readFileChanges,
	sameChanges,
} from "./codex-approval-params.js";
import type { ApprovalsVerdict, Verdict } from "./codex-protocol.js";
import {
	type JsonRpcId,
	type JsonRpcNotification,
	type JsonRpcServerRequest,
	RPC_METHOD_NOT_FOUND,
	type RpcClient,
	type RpcTimers,
} from "./codex-rpc.js";

/** An approval that arrives before the protocol verdict is held this long, then declined. */
export const VERDICT_WAIT_MS = 5_000;
/** Approvals held at once, across every runtime on this host. Past it, a request is declined at once. */
export const MAX_OPEN_APPROVALS = 64;
/** A finished request whose outcome the server never acknowledged is dropped after this long. */
const OUTCOME_KEEP_MS = 10 * 60 * 1000;
const SYNC_BACKOFF_BASE_MS = 1_000;
const SYNC_BACKOFF_MAX_MS = 30_000;
/** File changes remembered per runtime, by item id, while a request for them may still arrive. */
const MAX_BUFFERED_ITEMS = 64;

type Answer =
	| { kind: "result"; result: unknown }
	| { kind: "error"; code: number; message: string };

type MethodSpec = {
	/** What the warning calls the thing Codex asked for. */
	label: string;
	/** Approvals can be held for the verdict; the rest are answered the moment they arrive. */
	approval: boolean;
	answer: Answer;
};

const METHOD_NOT_FOUND: Answer = {
	kind: "error",
	code: RPC_METHOD_NOT_FOUND,
	message: "Method not found",
};

/**
 * Every server-request method Codex 0.163.0 can send (`__fixtures__/codex-0.163/methods.json`), and what
 * each gets. A method not in this table is answered `-32601`.
 */
const METHODS: Record<string, MethodSpec> = {
	[COMMAND_APPROVAL_METHOD]: {
		label: "to run a command",
		approval: true,
		answer: { kind: "result", result: { decision: "decline" } },
	},
	[FILE_CHANGE_APPROVAL_METHOD]: {
		label: "to change files",
		approval: true,
		answer: { kind: "result", result: { decision: "decline" } },
	},
	"item/permissions/requestApproval": {
		label: "for extra permissions",
		approval: false,
		answer: { kind: "result", result: { permissions: {} } },
	},
	"item/tool/requestUserInput": {
		label: "for input",
		approval: false,
		answer: { kind: "result", result: { answers: {} } },
	},
	"mcpServer/elicitation/request": {
		label: "for an MCP server's question",
		approval: false,
		answer: { kind: "result", result: { action: "decline" } },
	},
	applyPatchApproval: {
		label: "to change files",
		approval: false,
		answer: { kind: "result", result: { decision: "denied" } },
	},
	execCommandApproval: {
		label: "to run a command",
		approval: false,
		answer: { kind: "result", result: { decision: "denied" } },
	},
	"item/tool/call": {
		label: "to call a client tool",
		approval: false,
		answer: { kind: "result", result: { contentItems: [], success: false } },
	},
	"account/chatgptAuthTokens/refresh": {
		label: "for a new sign-in token",
		approval: false,
		answer: METHOD_NOT_FOUND,
	},
	"attestation/generate": {
		label: "for an attestation",
		approval: false,
		answer: METHOD_NOT_FOUND,
	},
	"currentTime/read": {
		label: "for the time",
		approval: false,
		answer: METHOD_NOT_FOUND,
	},
};

/** The methods the table answers, for the test that holds it equal to what Codex declares. */
export const HANDLED_SERVER_METHODS: readonly string[] = Object.keys(METHODS).sort();

/**
 * What a server's decision word means to Codex: the closed table (D6). A word that isn't in it, and
 * every decision that would outlive the one approval (the session-wide and policy-amendment ones, which are
 * never offered and never sent), becomes a decline.
 */
const WIRE_DECISION: Readonly<Record<ApprovalDecision, "accept" | "decline" | "cancel">> = {
	accept: "accept",
	decline: "decline",
	cancel: "cancel",
};
/** Decisions Codex defines that this host never sends. Listed so a reader sees they were considered. */
export const REFUSED_WIRE_DECISIONS: readonly string[] = [
	"acceptForSession",
	"acceptWithExecpolicyAmendment",
	"applyNetworkPolicyAmendment",
];

function toDecision(word: string): "accept" | "decline" | "cancel" {
	return Object.hasOwn(WIRE_DECISION, word) ? WIRE_DECISION[word as ApprovalDecision] : "decline";
}

/** Why a request was refused: a fixed vocabulary, safe to report. */
export type RefusalReason =
	| "approvals_not_enabled"
	| "protocol_unsupported"
	| "insecure_transport"
	| "verdict_timeout"
	| "over_capacity"
	| "fenced"
	| "out_of_scope"
	| "unknown_method"
	| "malformed_request"
	| "deadline"
	| "server_refused"
	| "too_many_pending"
	| "session_stopping"
	| "identity_conflict"
	| "session_not_owned";

const REASON_TAIL: Partial<Record<RefusalReason, string>> = {
	approvals_not_enabled: "Approvals can't be answered from AgentPulse for this session.",
	protocol_unsupported: "This Codex version's approval requests can't be answered from AgentPulse.",
	insecure_transport: "This host doesn't reach AgentPulse over https.",
	verdict_timeout: "AgentPulse couldn't check this Codex version in time.",
	over_capacity: "Too many requests were waiting on this host.",
	fenced: "The session was being stopped.",
	malformed_request: "The request wasn't in a form AgentPulse understands.",
	deadline: "Nobody answered in time.",
	server_refused: "AgentPulse's server wouldn't take it.",
	too_many_pending: "Too many requests were waiting for this session.",
	session_stopping: "The session was being stopped.",
	identity_conflict: "The request clashed with an earlier one.",
	session_not_owned: "This host doesn't own the session.",
};

export type ApprovalLaunch = {
	sessionId: string;
	/** The directory the thread runs in, supervisor-known: the base for a file change, which names none itself. */
	cwd?: string;
	/** Reports one fixed-text warning on the session. The tracker never hands it agent-written text. */
	warn(content: string, detail: { method: string; reason: string }): Promise<void>;
};

export type ApprovalHandle = {
	readonly sessionId: string;
	/** A fresh random id per attached connection; ids restart with each app-server, so this is what keeps two apart. */
	readonly epoch: string;
};

/** The narrow part of the report gate the tracker uses (and nothing else: it holds no way to send). */
export type ApprovalGatePort = Pick<
	ReportGate,
	"verdict" | "excludesPath" | "reportApproval" | "syncApprovals" | "isOffline"
>;

type Outcome = { outcome: TrackerOutcome; sentDecision: ApprovalDecision | null; acked: boolean };

type Held = {
	state: State;
	key: string;
	id: JsonRpcId;
	method: string;
	params: unknown;
	parsed: ParsedApproval | null;
	/** Receipt time on both clocks: its age is the larger of the two, since a monotonic clock stops in sleep. */
	monoAt: number;
	wallAt: number;
	/** Bumped synchronously on every change to what the person would be shown. */
	revision: number;
	reportedRevision: number;
	approvalId: string | null;
	/** What was written to Codex for it, once something has been. */
	sent: "accept" | "decline" | "cancel" | null;
	/** Codex resolved it without our answer, or the runtime went: nothing more may be written. */
	closedByCodex: boolean;
	terminal: boolean;
	terminalAtWall: number;
	outcomes: Outcome[];
	waiting: "verdict" | "diff" | null;
	verdictDeadline: number;
	verdictTimer: unknown;
	diffTimer: unknown;
	resolvedTimer: unknown;
	reporting: boolean;
	nextReportAt: number;
	reportFailures: number;
};

type State = {
	handle: ApprovalHandle;
	client: RpcClient;
	launch: ApprovalLaunch;
	verdict: Verdict | null;
	fenced: boolean;
	disposed: boolean;
	requests: Map<string, Held>;
	changes: Map<string, BufferedChange[]>;
	unsubscribe: Array<() => void>;
};

export type CodexApprovalTracker = {
	/** Call before `initialize`: every launch failure after it is covered by the client's close. */
	attachClient(client: RpcClient, launch: ApprovalLaunch): ApprovalHandle;
	setVerdict(handle: ApprovalHandle, verdict: Verdict): void;
	/**
	 * What the server said it can do (`register` and `heartbeat`). Absent or without `codex_approvals`
	 * means off: every unanswered request is declined and new ones are declined on arrival.
	 */
	setServerFeatures(features: readonly string[] | null | undefined): void;
	/**
	 * One beat: declines what is past its deadline, retries due reports, and polls the server when something
	 * is waiting on it. With nothing held and nothing unacknowledged it reads no clock and does no I/O.
	 */
	tick(): Promise<void>;
	/** Requests held and not yet answered to Codex, across every runtime. */
	pendingCount(): number;
	/** After this, nothing for the session is let through: held requests are declined. */
	fence(sessionId: string): void;
	/** Declines what is held, forgets the handle. Safe to call twice. */
	dispose(handle: ApprovalHandle): void;
};

export type TrackerOptions = {
	timers?: RpcTimers;
	/** Wall clock, epoch milliseconds. */
	now?: () => number;
	/** A clock that doesn't jump; its deltas and the wall clock's are both taken, and the larger wins. */
	monotonic?: () => number;
	verdictWaitMs?: number;
	maxOpen?: number;
	gate?: ApprovalGatePort;
};

const REAL_TIMERS: RpcTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const keyOf = (id: JsonRpcId) => JSON.stringify(id);
/** A diff belongs to one item on one thread: a notification for another thread's item of the same id is not it. */
const diffKey = (threadId: string, itemId: string) => JSON.stringify([threadId, itemId]);
/** One refusal warning per (session, method, reason) in this window; a flood of requests is not a flood of warnings. */
const WARN_COALESCE_MS = 30_000;
const WARN_COALESCE_MAX_KEYS = 256;
const IDLE: Promise<void> = Promise.resolve();

function warningText(spec: MethodSpec | undefined, reason: RefusalReason): string {
	if (!spec)
		return "Codex sent a request AgentPulse doesn't recognize. It was refused automatically.";
	if (spec.answer.kind !== "result") {
		return `Codex asked ${spec.label}. AgentPulse refused it automatically.`;
	}
	if (!spec.approval) return `Codex asked ${spec.label}. AgentPulse refused it automatically.`;
	const tail = REASON_TAIL[reason];
	return `Codex asked ${spec.label}. AgentPulse declined it automatically.${tail ? ` ${tail}` : ""}`;
}

function reasonForVerdict(verdict: Verdict | null): RefusalReason {
	if (!verdict) return "verdict_timeout";
	const state: ApprovalsVerdict = verdict.verdict;
	if (state === "insecure_transport") return "insecure_transport";
	if (state === "unsupported") return "protocol_unsupported";
	return "approvals_not_enabled";
}

export function createCodexApprovalTracker(options: TrackerOptions = {}): CodexApprovalTracker {
	const timers = options.timers ?? REAL_TIMERS;
	const now = options.now ?? Date.now;
	const monotonic = options.monotonic ?? (() => performance.now());
	const verdictWaitMs = options.verdictWaitMs ?? VERDICT_WAIT_MS;
	const maxOpen = options.maxOpen ?? MAX_OPEN_APPROVALS;
	const gate = options.gate;

	const states = new Set<State>();
	/** Every request not yet forgotten: held, answered and waiting on `resolved`, or finished and not yet acknowledged. */
	const all = new Set<Held>();
	/** The server's id for a request. Keyed by it, never by Codex's rpc id alone: two runtimes reuse the same ids. */
	const byApproval = new Map<string, Held>();
	const byHandle = new WeakMap<ApprovalHandle, State>();
	let serverEnabled = false;
	let syncing = false;
	let syncFailures = 0;
	let nextSyncAtWall = 0;

	const ageOf = (held: Held) => Math.max(monotonic() - held.monoAt, now() - held.wallAt, 0);

	// ---- the only writers to Codex ----

	/** The empty or refusing answer for a method that isn't an approval, or the decline default-deny gives. */
	function answerFromTable(state: State, id: JsonRpcId, spec: MethodSpec | undefined) {
		const chosen = spec?.answer ?? METHOD_NOT_FOUND;
		try {
			if (chosen.kind === "result") state.client.respond(id, chosen.result);
			else state.client.respondError(id, chosen.code, chosen.message);
		} catch {
			// A closed stdin is the child going away: there is nobody left to answer.
		}
	}

	/** Writes `decline` or `cancel`. Never `accept`: that is `deliverAccept`'s alone. */
	function writeRefusal(state: State, held: Held, decision: "decline" | "cancel"): boolean {
		if (held.sent !== null || held.closedByCodex) return false;
		let wrote = false;
		try {
			wrote = state.client.respond(held.id, { decision });
		} catch {
			// A closed stdin is the child going away.
		}
		if (wrote) held.sent = decision;
		return wrote;
	}

	/**
	 * The one place in the supervisor that tells Codex to run something. It is reached only from
	 * `applyAnswer`, and re-judges everything at the moment of the write, with nothing awaited between the
	 * checks and `respond`: the exact held request (by the server's id), the runtime it was held on, the
	 * revision that was held, the round trip of the response that carried it, the Stop fence, the
	 * protocol verdict, the server feature, and the exclude rules. Anything else is a decline.
	 */
	function deliverAccept(
		held: Held,
		answer: { approvalId: string; revision: number },
		roundTripMs: number,
	): void {
		const state = held.state;
		if (held.sent !== null || held.terminal || held.closedByCodex) return;
		// The answer must be for the request Codex is holding now, not an earlier one that shared its key.
		if (state.requests.get(held.key) !== held) {
			declineLocally(held, null, "declined_local");
			return;
		}
		if (excludedNow(held)) {
			declineLocally(held, null, "declined_local");
			return;
		}
		// What makes a held request safe to accept is kept true by the paths that end it, not re-checked
		// here: a fence, a runtime that closed or was disposed, a protocol verdict that isn't supported and
		// a server that stopped advertising approvals each decline every unanswered request and make it
		// terminal (returned from above). What is left to check is that the answer is for this request.
		const allowed =
			held.approvalId !== null &&
			answer.approvalId === held.approvalId &&
			declineOnlyOf(held).length === 0;
		if (!allowed) {
			declineLocally(held, null, "declined_local");
			return;
		}
		if (answer.revision !== held.revision) {
			declineLocally(held, null, "declined_revision_changed");
			return;
		}
		if (!(roundTripMs <= CODEX_SLOW_SYNC_RESPONSE_MS)) {
			declineLocally(held, null, "declined_slow_response");
			return;
		}
		// The line that runs a command. This guard repeats what the paths that end these conditions already
		// do (each declines every unanswered request and makes it terminal, returned from above), so no
		// test can make it fail on its own; it stays as the last word at the one place that writes `accept`.
		if (
			state.disposed ||
			state.fenced ||
			!serverEnabled ||
			(state.verdict?.verdict ?? null) !== "supported"
		) {
			declineLocally(held, null, "declined_local");
			return;
		}
		let wrote = false;
		try {
			wrote = state.client.respond(held.id, { decision: "accept" });
		} catch {
			// A closed stdin is the child going away.
		}
		if (!wrote) return;
		held.sent = "accept";
		afterSend(held);
	}

	// ---- outcomes ----

	function clearTimers(held: Held) {
		for (const name of ["verdictTimer", "diffTimer", "resolvedTimer"] as const) {
			if (held[name] !== undefined) timers.clear(held[name]);
			held[name] = undefined;
		}
		held.waiting = null;
	}

	function forget(held: Held) {
		clearTimers(held);
		all.delete(held);
		if (held.approvalId && byApproval.get(held.approvalId) === held)
			byApproval.delete(held.approvalId);
		if (held.state.requests.get(held.key) === held) held.state.requests.delete(held.key);
	}

	/** Forget a finished request once the server has acknowledged everything said about it. */
	function pruneIfDone(held: Held) {
		if (!held.terminal || held.reporting) return;
		if (held.approvalId === null || held.outcomes.every((entry) => entry.acked)) forget(held);
	}

	function record(held: Held, outcome: TrackerOutcome, sentDecision: ApprovalDecision | null) {
		held.outcomes.push({ outcome, sentDecision, acked: false });
		if (TRACKER_OUTCOME_TABLE[outcome].terminal) {
			held.terminal = true;
			held.terminalAtWall = now();
			clearTimers(held);
		}
		pruneIfDone(held);
	}

	/** After a response was written: say so, and wait (bounded) for Codex to confirm it took it. */
	function afterSend(held: Held) {
		const sent = held.sent;
		record(held, "respond_sent", sent);
		held.resolvedTimer = timers.set(() => {
			held.resolvedTimer = undefined;
			if (held.terminal) return;
			record(held, "resolved_timeout", held.sent);
		}, CODEX_RESOLVED_WAIT_MS);
	}

	const lastWarnedAt = new Map<string, number>();

	function warn(state: State, method: string, spec: MethodSpec | undefined, reason: RefusalReason) {
		const warnKey = JSON.stringify([state.launch.sessionId, spec ? method : "unknown", reason]);
		const at = now();
		const previous = lastWarnedAt.get(warnKey);
		if (previous !== undefined && at - previous >= 0 && at - previous < WARN_COALESCE_MS) return;
		if (lastWarnedAt.size >= WARN_COALESCE_MAX_KEYS) {
			for (const [key, when] of lastWarnedAt) {
				if (at - when >= WARN_COALESCE_MS || at < when) lastWarnedAt.delete(key);
			}
			if (lastWarnedAt.size >= WARN_COALESCE_MAX_KEYS) lastWarnedAt.clear();
		}
		lastWarnedAt.set(warnKey, at);
		void state.launch
			.warn(warningText(spec, reason), { method: spec ? method : "unknown", reason })
			.catch((error) => {
				console.error("[codex-approvals] could not report a refusal:", error);
			});
	}

	/**
	 * Declines a request this host decided on its own (a deadline, the fence, an exclusion, a bad answer),
	 * once, whoever gets there first. `reason` null says nothing to the session (an exclusion must not,
	 * and a decline the server asked for is already on its timeline).
	 */
	function declineLocally(
		held: Held,
		reason: RefusalReason | null,
		outcome: "declined_local" | "declined_slow_response" | "declined_revision_changed",
	) {
		if (held.terminal || held.sent !== null) return;
		if (!held.closedByCodex) writeRefusal(held.state, held, "decline");
		if (reason) warn(held.state, held.method, METHODS[held.method], reason);
		record(held, outcome, "decline");
	}

	// ---- exclusion (D10) ----

	function pathsOf(held: Held): string[] {
		const parsed = held.parsed;
		if (!parsed) return [];
		const base = parsed.cwd ?? held.state.launch.cwd ?? "";
		const resolveFrom = (path: string) => (base ? resolvePath(base, path) : path);
		const paths: string[] = [];
		if (parsed.cwd) paths.push(parsed.cwd);
		if (parsed.grantRoot) paths.push(resolveFrom(parsed.grantRoot));
		if (parsed.kind === "file_change") {
			for (const change of held.state.changes.get(diffKey(parsed.threadId, parsed.itemId)) ?? []) {
				paths.push(resolveFrom(change.path));
				if (change.movePath) paths.push(resolveFrom(change.movePath));
			}
		}
		return paths;
	}

	/** Why this request can't be approved, from what is held now (the parameters, and whether a diff is in hand). */
	function declineOnlyOf(held: Held): string[] {
		const parsed = held.parsed;
		if (!parsed) return ["unparsed"];
		const reasons: string[] = [...parsed.declineOnly];
		if (
			parsed.kind === "file_change" &&
			(held.state.changes.get(diffKey(parsed.threadId, parsed.itemId))?.length ?? 0) === 0
		) {
			reasons.push("no_diff");
		}
		return reasons;
	}

	/** The session, its directory, or any path the request names is covered by a rule, or the rules can't be trusted. */
	function excludedNow(held: Held): boolean {
		if (!gate) return false;
		if (gate.verdict(held.state.launch.sessionId) !== "send") return true;
		return pathsOf(held).some((path) => gate.excludesPath(path));
	}

	// ---- reporting ----

	function reportable(held: Held): boolean {
		return (
			!held.terminal &&
			held.sent === null &&
			!held.closedByCodex &&
			held.waiting === null &&
			held.parsed !== null &&
			!held.reporting &&
			(held.approvalId === null || held.revision > held.reportedRevision)
		);
	}

	function retryDelay(failures: number, retryAfterMs?: number) {
		const wait = Math.min(
			SYNC_BACKOFF_MAX_MS,
			SYNC_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
		);
		return Math.max(wait, retryAfterMs ?? 0);
	}

	/** The server's refusal codes that mean this request can never be answered here. */
	const FATAL_REFUSALS: Record<string, RefusalReason> = {
		too_many_pending: "too_many_pending",
		session_stopping: "session_stopping",
		identity_conflict: "identity_conflict",
		session_not_owned: "session_not_owned",
	};

	/**
	 * What a failed report does to the request (plan 5.2, with the two refusals the server added). The
	 * server's named refusal codes are judged first, since a 409 would otherwise read as `stop`.
	 *
	 *   network, server, backoff, credential   retry with 1, 2, 4 .. 30 s waits (Retry-After wins) until the deadline
	 *   409 session_unknown                    retry every 5 s until the deadline
	 *   409 too_many_pending / session_stopping decline, warn
	 *   409 identity_conflict                  decline, warn (the key now names another request; fail closed)
	 *   403 session_not_owned                  decline, warn (this host isn't the session's owner of record)
	 *   session, entry                         decline, warn
	 *   stop, other (a 404 after a rollback)   decline, warn, and approvals stay off until a heartbeat says otherwise
	 */
	function onReportFailure(held: Held, error: unknown) {
		const code = error instanceof SupervisorRequestError ? error.error : undefined;
		// The named refusal codes are judged before the class: a 409 would otherwise read as "stop".
		if (code === "session_unknown") {
			held.nextReportAt = now() + CODEX_SESSION_UNKNOWN_RETRY_MS;
			return;
		}
		if (code !== undefined && Object.hasOwn(FATAL_REFUSALS, code)) {
			declineLocally(held, FATAL_REFUSALS[code], "declined_local");
			return;
		}
		const failure = classifyReportFailure(error);
		switch (failure) {
			case "network":
			case "server":
			case "backoff":
			case "credential": {
				held.reportFailures++;
				const retryAfter = error instanceof SupervisorRequestError ? error.retryAfterMs : undefined;
				held.nextReportAt = now() + retryDelay(held.reportFailures, retryAfter);
				return;
			}
			case "session":
			case "entry":
				declineLocally(held, "server_refused", "declined_local");
				return;
			default:
				// stop and other (a 404 after a server rollback, an edge refusal): nothing here can be
				// answered until a heartbeat says the server can again.
				declineLocally(held, "server_refused", "declined_local");
				setServerEnabled(false);
		}
	}

	async function sendReport(held: Held): Promise<void> {
		if (!gate || !reportable(held) || now() < held.nextReportAt) return;
		const parsed = held.parsed as ParsedApproval;
		const age = ageOf(held);
		if (held.approvalId === null && CODEX_APPROVAL_TTL_MS - age < CODEX_REPORT_MIN_REMAINING_MS) {
			declineLocally(held, "deadline", "declined_local");
			return;
		}
		if (excludedNow(held)) {
			declineLocally(held, null, "declined_local");
			return;
		}
		if (gate.isOffline()) return;
		const revision = held.revision;
		const body = buildReportBody({
			runtimeEpoch: held.state.handle.epoch,
			rpcId: held.key,
			parsed,
			fallbackCwd: held.state.launch.cwd ?? null,
			changes:
				parsed.kind === "file_change"
					? (held.state.changes.get(diffKey(parsed.threadId, parsed.itemId)) ?? null)
					: null,
			ageMs: age,
			revision,
		});
		held.reporting = true;
		try {
			const result = await gate.reportApproval(held.state.launch.sessionId, body);
			if (result.outcome !== "sent") {
				declineLocally(held, null, "declined_local");
				return;
			}
			held.reportFailures = 0;
			held.approvalId = result.response.approvalId;
			held.reportedRevision = Math.max(held.reportedRevision, revision);
			if (all.has(held)) byApproval.set(held.approvalId, held);
		} catch (error) {
			if (!held.terminal) onReportFailure(held, error);
		} finally {
			held.reporting = false;
			pruneIfDone(held);
		}
	}

	// ---- the poll (D11) ----

	function syncEntries() {
		const live: Array<{ sessionId: string; approvalId: string; revision: number }> = [];
		const resolved: Array<CodexApprovalResolved & { sessionId: string }> = [];
		for (const held of all) {
			if (held.approvalId === null) continue;
			const sessionId = held.state.launch.sessionId;
			if (!held.terminal)
				live.push({ sessionId, approvalId: held.approvalId, revision: held.revision });
			for (const entry of held.outcomes) {
				if (!entry.acked) {
					resolved.push({
						sessionId,
						approvalId: held.approvalId,
						outcome: entry.outcome,
						sentDecision: entry.sentDecision,
					});
				}
			}
		}
		return { live, resolved };
	}

	function setServerEnabled(enabled: boolean) {
		if (serverEnabled === enabled) return;
		serverEnabled = enabled;
		if (enabled) return;
		for (const held of [...all]) {
			if (held.terminal || held.sent !== null || held.closedByCodex) continue;
			declineLocally(held, "approvals_not_enabled", "declined_local");
		}
	}

	function onSyncFailure(error: unknown) {
		const failure = classifyReportFailure(error);
		if (failure === "stop" || failure === "other" || failure === "entry" || failure === "session") {
			// What the server won't take can't be answered: decline what is waiting, and stay off until a
			// heartbeat says otherwise.
			for (const held of [...all]) {
				if (held.terminal || held.sent !== null || held.closedByCodex) continue;
				declineLocally(held, "server_refused", "declined_local");
			}
			setServerEnabled(false);
			return;
		}
		syncFailures++;
		const retryAfter = error instanceof SupervisorRequestError ? error.retryAfterMs : undefined;
		nextSyncAtWall = now() + retryDelay(syncFailures, retryAfter);
	}

	/** Applies one server answer to the request it names. Reached only with the answer's own id; an unknown id is ignored. */
	function applyAnswer(
		answer: { approvalId: string; decision: string; revision: number },
		roundTripMs: number,
	) {
		const held = byApproval.get(answer.approvalId);
		if (!held) return;
		// Repeat answers are idempotent, and a decline for a request already answered is ignored.
		if (held.terminal || held.sent !== null || held.closedByCodex) return;
		const decision = toDecision(answer.decision);
		if (decision === "accept") {
			deliverAccept(held, answer, roundTripMs);
			return;
		}
		if (writeRefusal(held.state, held, decision)) afterSend(held);
	}

	async function runSync(): Promise<void> {
		if (!gate || syncing || !serverEnabled || gate.isOffline()) return;
		if (now() < nextSyncAtWall) return;
		// A session a rule now covers is dropped before anything about it is said.
		for (const held of [...all]) {
			if (!held.terminal && held.sent === null && excludedNow(held)) {
				declineLocally(held, null, "declined_local");
			}
		}
		const entries = syncEntries();
		entries.live.splice(CODEX_APPROVAL_LIMITS.liveMax);
		entries.resolved.splice(CODEX_APPROVAL_LIMITS.resolvedMax);
		if (entries.live.length === 0 && entries.resolved.length === 0) return;
		syncing = true;
		const mono0 = monotonic();
		const wall0 = now();
		try {
			const result = await gate.syncApprovals(entries);
			if (result.outcome !== "sent") return;
			const roundTripMs = Math.max(monotonic() - mono0, now() - wall0, 0);
			syncFailures = 0;
			nextSyncAtWall = 0;
			const { response } = result;
			// Everything below is synchronous: nothing is awaited between the checks and a write to Codex.
			for (const ack of response.ack) {
				const held = byApproval.get(ack.approvalId);
				if (!held) continue;
				for (const entry of held.outcomes) {
					if (entry.outcome === ack.outcome) entry.acked = true;
				}
				pruneIfDone(held);
			}
			for (const id of response.closed) {
				const held = byApproval.get(id);
				if (!held) continue;
				if (held.sent === null && !held.closedByCodex) writeRefusal(held.state, held, "decline");
				// The row is closed on the server: nothing more is reported about it.
				forget(held);
			}
			for (const answer of response.answers) applyAnswer(answer, roundTripMs);
		} catch (error) {
			onSyncFailure(error);
		} finally {
			syncing = false;
		}
	}

	// ---- deadlines ----

	function runDeadlines() {
		const at = now();
		for (const held of [...all]) {
			if (held.terminal) {
				if (at - held.terminalAtWall >= OUTCOME_KEEP_MS) forget(held);
				continue;
			}
			if (held.waiting === "verdict") {
				if (at >= held.verdictDeadline) {
					declineLocally(held, "verdict_timeout", "declined_local");
				}
				continue;
			}
			if (held.sent !== null || held.closedByCodex) continue;
			if (ageOf(held) >= CODEX_TRACKER_DEADLINE_MS)
				declineLocally(held, "deadline", "declined_local");
		}
	}

	// ---- requests from Codex ----

	function proceed(held: Held) {
		const state = held.state;
		if (held.terminal) return;
		if (!gate || !serverEnabled) {
			declineLocally(held, "approvals_not_enabled", "declined_local");
			return;
		}
		const parsed = parseApprovalParams(held.method, held.params);
		if (!parsed) {
			declineLocally(held, "malformed_request", "declined_local");
			return;
		}
		held.parsed = parsed;
		if (
			parsed.kind === "file_change" &&
			!state.changes.has(diffKey(parsed.threadId, parsed.itemId))
		) {
			held.waiting = "diff";
			held.diffTimer = timers.set(() => {
				held.diffTimer = undefined;
				if (held.waiting !== "diff") return;
				held.waiting = null;
				kick(held);
			}, CODEX_FILE_DIFF_WAIT_MS);
			return;
		}
		kick(held);
	}

	function kick(held: Held) {
		void sendReport(held);
	}

	/**
	 * An rpc id is open until we have answered it or Codex has resolved it. A held request that is not
	 * finished, or finished with neither, still has its id open.
	 */
	function idStillOpen(earlier: Held): boolean {
		if (!earlier.terminal) return true;
		return earlier.sent === null && !earlier.closedByCodex;
	}

	/**
	 * Codex sent a second request on an id that is still open. Which request that id now means is
	 * unknowable, so neither is kept: one decline (safe for whichever Codex holds under the id) is written,
	 * the earlier request is finished, and the new one is neither held nor reported.
	 */
	function refuseRepeatedId(
		state: State,
		earlier: Held,
		call: JsonRpcServerRequest,
		spec: MethodSpec,
	) {
		let wrote = false;
		try {
			wrote = state.client.respond(call.id, { decision: "decline" });
		} catch {
			// A closed stdin is the child going away.
		}
		if (!earlier.terminal) {
			const sentBefore = earlier.sent;
			if (sentBefore === null && wrote) earlier.sent = "decline";
			if (sentBefore === null) record(earlier, "declined_local", "decline");
			// Something already sent for it (an accept awaiting Codex's confirmation) is now unknowable.
			else record(earlier, "resolved_timeout", sentBefore);
		}
		warn(state, call.method, spec, "identity_conflict");
	}

	function onRequest(state: State, call: JsonRpcServerRequest) {
		if (state.disposed) return;
		const spec = METHODS[call.method];
		if (!spec) {
			answerFromTable(state, call.id, undefined);
			warn(state, call.method, undefined, "unknown_method");
			return;
		}
		if (!spec.approval) {
			answerFromTable(state, call.id, spec);
			warn(state, call.method, spec, "out_of_scope");
			return;
		}
		if (state.fenced) {
			answerFromTable(state, call.id, spec);
			warn(state, call.method, spec, "fenced");
			return;
		}
		if (pendingCount() >= maxOpen) {
			answerFromTable(state, call.id, spec);
			warn(state, call.method, spec, "over_capacity");
			return;
		}
		if (state.verdict && state.verdict.verdict !== "supported") {
			answerFromTable(state, call.id, spec);
			warn(state, call.method, spec, reasonForVerdict(state.verdict));
			return;
		}
		const key = keyOf(call.id);
		const earlier = state.requests.get(key);
		if (earlier && idStillOpen(earlier)) {
			refuseRepeatedId(state, earlier, call, spec);
			return;
		}
		const held: Held = {
			state,
			key,
			id: call.id,
			method: call.method,
			params: call.params,
			parsed: null,
			monoAt: monotonic(),
			wallAt: now(),
			revision: 1,
			reportedRevision: 0,
			approvalId: null,
			sent: null,
			closedByCodex: false,
			terminal: false,
			terminalAtWall: 0,
			outcomes: [],
			waiting: null,
			verdictDeadline: 0,
			verdictTimer: undefined,
			diffTimer: undefined,
			resolvedTimer: undefined,
			reporting: false,
			nextReportAt: 0,
			reportFailures: 0,
		};
		all.add(held);
		state.requests.set(held.key, held);
		if (!state.verdict) {
			// No verdict yet: hold it, but never past the wait.
			held.waiting = "verdict";
			held.verdictDeadline = now() + verdictWaitMs;
			held.verdictTimer = timers.set(() => {
				if (held.waiting === "verdict") declineLocally(held, "verdict_timeout", "declined_local");
			}, verdictWaitMs);
			return;
		}
		proceed(held);
	}

	// ---- notifications from Codex ----

	/** Forgets a diff for an item whichever thread named it: used when a notification can't say which. */
	function dropItemChanges(state: State, itemId: string) {
		for (const key of [...state.changes.keys()]) {
			if ((JSON.parse(key) as [string, string])[1] === itemId) state.changes.delete(key);
		}
	}

	function changedItem(state: State, threadId: string, itemId: string, changes: BufferedChange[]) {
		const key = diffKey(threadId, itemId);
		const before = state.changes.get(key);
		if (state.changes.size >= MAX_BUFFERED_ITEMS && !before) {
			const oldest = state.changes.keys().next().value;
			if (oldest !== undefined) state.changes.delete(oldest);
		}
		state.changes.set(key, changes);
		if (before && sameChanges(before, changes)) return;
		for (const held of state.requests.values()) {
			if (held.terminal || held.sent !== null || held.closedByCodex) continue;
			if (
				held.parsed?.kind !== "file_change" ||
				held.parsed.itemId !== itemId ||
				held.parsed.threadId !== threadId
			) {
				// A request still waiting for its verdict has nothing parsed yet; it reads the buffer later.
				continue;
			}
			// Synchronous: from here the held revision no longer matches any answer for the old text.
			held.revision++;
			if (held.waiting === "diff") {
				if (held.diffTimer !== undefined) timers.clear(held.diffTimer);
				held.diffTimer = undefined;
				held.waiting = null;
			}
			kick(held);
		}
	}

	function onNotification(state: State, notification: JsonRpcNotification) {
		if (state.disposed) return;
		const params = notification.params as Record<string, unknown> | undefined;
		if (!params || typeof params !== "object") return;
		switch (notification.method) {
			case "item/started":
			case "item/completed": {
				const item = params.item as Record<string, unknown> | undefined;
				if (!item || item.type !== "fileChange" || typeof item.id !== "string") return;
				// Codex 0.163 puts `threadId` on every item notification in the recorded runs; one without it
				// can't be tied to a request, so it is no diff at all.
				const threadId = params.threadId;
				if (typeof threadId !== "string" || threadId === "") {
					dropItemChanges(state, item.id);
					return;
				}
				if (notification.method === "item/completed") {
					state.changes.delete(diffKey(threadId, item.id));
					return;
				}
				const changes = readFileChanges(item.changes);
				if (changes) changedItem(state, threadId, item.id, changes);
				else state.changes.delete(diffKey(threadId, item.id));
				return;
			}
			case "item/fileChange/patchUpdated": {
				if (typeof params.itemId !== "string") return;
				const threadId = params.threadId;
				if (typeof threadId !== "string" || threadId === "") {
					dropItemChanges(state, params.itemId);
					return;
				}
				const changes = readFileChanges(params.changes);
				// A patch we can't read in full is no patch: whatever was held can't be shown, so it is dropped.
				if (changes) changedItem(state, threadId, params.itemId, changes);
				else state.changes.delete(diffKey(threadId, params.itemId));
				return;
			}
			case "serverRequest/resolved": {
				const id = params.requestId;
				if (typeof id !== "string" && typeof id !== "number") return;
				const held = state.requests.get(keyOf(id));
				if (!held || held.terminal) return;
				if (held.sent !== null) {
					record(held, "resolved_after_response", held.sent);
					return;
				}
				// Codex settled it without our answer (the turn was interrupted): nothing more may be written.
				held.closedByCodex = true;
				record(held, "resolved_before_response", null);
				return;
			}
		}
	}

	// ---- runtime lifecycle ----

	function disposeState(state: State) {
		if (state.disposed) return;
		const clientOpen = !state.client.isClosed;
		state.disposed = true;
		for (const stop of state.unsubscribe) stop();
		states.delete(state);
		for (const held of [...state.requests.values()]) {
			if (held.terminal) continue;
			if (held.sent !== null) {
				record(held, "runtime_gone_after_response", held.sent);
			} else if (clientOpen && !held.closedByCodex) {
				// Still connected (an orderly dispose): decline what is held, and say so.
				declineLocally(held, null, "declined_local");
			} else {
				record(held, "runtime_gone", null);
			}
		}
		state.changes.clear();
	}

	function pendingCount(): number {
		let open = 0;
		for (const held of all) if (!held.terminal && held.sent === null && !held.closedByCodex) open++;
		return open;
	}

	return {
		attachClient(client, launch) {
			const handle: ApprovalHandle = { sessionId: launch.sessionId, epoch: randomUUID() };
			const state: State = {
				handle,
				client,
				launch,
				verdict: null,
				fenced: false,
				disposed: false,
				requests: new Map(),
				changes: new Map(),
				unsubscribe: [],
			};
			states.add(state);
			byHandle.set(handle, state);
			state.unsubscribe.push(client.onServerRequest((call) => onRequest(state, call)));
			state.unsubscribe.push(client.onNotification((n) => onNotification(state, n)));
			state.unsubscribe.push(client.onClose(() => disposeState(state)));
			return handle;
		},

		setVerdict(handle, verdict) {
			const state = byHandle.get(handle);
			if (!state || state.disposed) return;
			state.verdict = verdict;
			for (const held of [...state.requests.values()]) {
				if (held.terminal || held.sent !== null) continue;
				if (verdict.verdict !== "supported") {
					declineLocally(held, reasonForVerdict(verdict), "declined_local");
				} else if (held.waiting === "verdict") {
					if (held.verdictTimer !== undefined) timers.clear(held.verdictTimer);
					held.verdictTimer = undefined;
					held.waiting = null;
					proceed(held);
				}
			}
		},

		setServerFeatures(features) {
			setServerEnabled(
				Array.isArray(features) && features.includes(CODEX_APPROVALS_SERVER_FEATURE),
			);
		},

		tick() {
			if (all.size === 0) return IDLE;
			runDeadlines();
			if (all.size === 0) return IDLE;
			const work: Promise<void>[] = [];
			for (const held of [...all]) {
				if (reportable(held) && now() >= held.nextReportAt) work.push(sendReport(held));
			}
			work.push(runSync());
			return Promise.all(work).then(() => undefined);
		},

		pendingCount,

		fence(sessionId) {
			for (const state of states) {
				if (state.handle.sessionId !== sessionId) continue;
				state.fenced = true;
				for (const held of [...state.requests.values()]) {
					if (held.terminal || held.sent !== null || held.closedByCodex) continue;
					declineLocally(held, "fenced", "declined_local");
				}
			}
		},

		dispose(handle) {
			const state = byHandle.get(handle);
			if (state) disposeState(state);
		},
	};
}

// ---- the one tracker a supervisor runs ----

let shared: CodexApprovalTracker | null = null;
let fallback: CodexApprovalTracker | null = null;

/** Installs the tracker managed Codex runtimes attach to. Unconfigured means the default-deny one. */
export function configureCodexApprovals(tracker: CodexApprovalTracker | null): void {
	shared = tracker;
}

export function sharedCodexApprovals(): CodexApprovalTracker {
	if (shared) return shared;
	fallback ??= createCodexApprovalTracker();
	return fallback;
}
