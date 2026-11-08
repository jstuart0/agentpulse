/**
 * One long-lived stream-json `claude` per takeover fork (AGEN-117 T1, T3, T5, T8, T10, T16, T18).
 *
 * A fork is a process, not a per-prompt run: only a live process gives a request, an answer, an interrupt and
 * a cancel. This module owns that process for its whole life:
 *
 *  - Admission: a slot is reserved synchronously before any await and released on every refusal, exit and
 *    failed start. A ninth concurrent fork is refused `host_busy`.
 *  - Start: `initialize` (its `account` must agree with the mode the login probes picked), then the fork's
 *    own `agents --json` entry must show the new session id and not the source's, and the source transcript
 *    must be unchanged. No user line has been written by then, to a probe or to the fork.
 *  - A turn is one user line the host sent. Before every line: `agents --json` must not show the session at
 *    another pid. At the first line, `init` must show the id, `default` permissions, the version, the
 *    capability, exactly the six tools and no MCP servers or slash commands (and, under `restricted`, no
 *    messaging socket or memory paths).
 *  - Every line is judged: another session id or permission mode is fatal; so is a turn nobody sent (a
 *    lifecycle line for a uuid the host never stamped, an `init`, `assistant`, `user` or request with no
 *    turn open, or a second `result`). Fatal means the child is stopped, nothing is answered after, and the
 *    session reads `degraded`.
 *  - No tool input leaves this module in a row, an event or a report. The approval path (a later phase)
 *    owns the request text; here a request is handed to it or declined.
 *
 * Reports go through the callbacks the control-action handler gives (the report gate); nothing in a fork's
 * timeline comes from a hook.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { forkChildEnv } from "../../shared/launch-env-policy.js";
import {
	CLAUDE_API_ERROR_MESSAGE,
	CLAUDE_FORK_BUSY_ERROR,
	CLAUDE_FORK_CHANGED_SYNC_ERROR,
	CLAUDE_FORK_CHECK_FAILED_ERROR,
	CLAUDE_FORK_EXITED_SYNC_ERROR,
	CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR,
	CLAUDE_FORK_MCP_CHANGED_SYNC_ERROR,
	CLAUDE_FORK_NO_RUNTIME_ERROR,
	CLAUDE_FORK_PEER_SYNC_ERROR,
	CLAUDE_FORK_SLASH_MESSAGE,
	CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR,
	CLAUDE_FORK_TERMINAL_FOUND_ERROR,
	CLAUDE_FORK_UNSTOPPABLE_SYNC_ERROR,
	CLAUDE_LOGIN_LOST_ERROR,
	HOST_RESTARTED_TURN_ERROR,
	STOPPED_BY_PERSON_ERROR,
} from "../../shared/managed-messages.js";
import type { ClaudeForkMode } from "../../shared/session-resume.js";
import {
	CLAUDE_INTERRUPT_RESULT_WAIT_MS,
	INTERRUPTED_BEFORE_SEND_CODE,
	INTERRUPTED_STATUS,
	INTERRUPTED_TERMINAL_REASONS,
	STOPPED_BEFORE_SEND,
	TURN_ERRORED_AFTER_STOP,
	TURN_STOPPED_BY_PERSON,
} from "../../shared/stop-turn.js";
import { disposeRuntimesAndExit } from "../services/fatal-exit.js";
import { reportInSessionSafely } from "../services/report-resilience.js";
import { listClaudeAgentEntries } from "./claude-agents.js";
import {
	type ForkRejectCode,
	type ForkToolPolicy,
	forkToolPolicy,
	isAppliedMcpTool,
} from "./claude-fork-tools.js";
import { accountAgreesWithMode, describeLoginForLog } from "./claude-login-mode.js";
import {
	type ClaudeProcess,
	type ClaudeStopTimings,
	FORK_STOP_TIMINGS,
	spawnClaude,
} from "./claude-process.js";
import type { LaunchCallbacks } from "./claude-shared.js";
import {
	type TurnOutcomeKind,
	callRowPayload,
	callRowText,
	refusedTurnText,
	unaskedTurnText,
} from "./claude-turn-rows.js";
import {
	CLAUDE_CANCEL,
	CLAUDE_CAN_USE_TOOL,
	type ClaudeLinkOptions,
	type ClaudeMessage,
	denyResponse,
} from "./claude-wire.js";
import type { JsonRpcServerRequest } from "./codex-rpc.js";
import {
	type DetailJudge,
	type ToolCallRecord,
	cutDetailResult,
	detailPathsOf,
	newToolCallRecord,
} from "./fork-tool-record.js";
import type { ObservedTurn, TurnEnding } from "./fork-turn-observer.js";

export const MAX_CLAUDE_STREAM_RUNTIMES = 8;
/** How long a fork's own `agents --json` entry may take to appear. */
export const OWN_ID_WAIT_MS = 5_000;
const OWN_ID_POLL_MS = 250;
/** The transcript tail read for an injected message. */
const PEER_TAIL_BYTES = 256 * 1024;
export const PEER_TURN_TEXT_CAP = 1024;
/** How long a peer-tagged transcript line is waited for: attempts and the pause between them. */
const PEER_TEXT_ATTEMPTS = 4;
const PEER_TEXT_WAIT_MS = 150;
/** How many of the host's own prompts are remembered, to tell them from an injected one in the transcript's tail. */
const MAX_SENT_TEXTS = 64;
/** A request the host declined itself writes at most this many warning rows a turn. */
const MAX_WARNINGS_PER_TURN = 3;

const MARKER = { claudeStreamRuntime: true } as const;
const REQUIRED_CAPABILITY = "interrupt_receipt_v1";

/** The words a request is declined with when no card can be shown for it. Fixed: the model sees them. */
export const CLAUDE_LOCAL_DECLINE_TEXT =
	"AgentPulse could not show this request to a person, so it was declined.";
const LOCAL_DECLINE_WARNING =
	"AgentPulse declined a request from Claude because it could not be shown to a person.";
const TURN_ERROR_MESSAGE = "Claude ended this turn with an error.";
const TURN_COMPLETED_CONTENT = "Claude finished this turn.";
const PROMPT_NOT_RECORDED = "AgentPulse couldn't record this prompt, so nothing was sent.";

// ---- refusals ----

export type ClaudeStartRefusalKind =
	| "host_busy"
	| "claude_not_logged_in"
	| "rejected"
	| "source_changed"
	| "liveness_unknown";

/** A fork that was not started. Nothing was written to any conversation. */
export class ClaudeStartRefusal extends Error {
	constructor(
		readonly kind: ClaudeStartRefusalKind,
		detail?: string,
	) {
		super(detail ? `${kind}: ${detail}` : kind);
		this.name = "ClaudeStartRefusal";
	}
}

/** A prompt the host did not send. `message` is the fixed sentence the action carries. */
export class ClaudePromptRefusal extends Error {
	constructor(
		readonly kind:
			| "slash"
			| "busy"
			| "terminal_found"
			| "check_failed"
			| "no_runtime"
			| "stopping"
			| "not_recorded"
			| "interrupted_before_send",
		message: string,
	) {
		super(message);
		this.name = "ClaudePromptRefusal";
	}
}

/** The report gate would not let the prompt's event out (an exclude rule covers the session). */
export class ClaudePromptWithheld extends Error {
	constructor() {
		super("The prompt was withheld by the report gate.");
		this.name = "ClaudePromptWithheld";
	}
}

// ---- the approval seam (the tracker plugs in here in a later phase) ----

export type ClaudeApprovalContext = {
	/** Writes the answer for a held request. False when it was answered already or the runtime is gone. */
	answer(requestId: string, body: unknown): boolean;
	/** The tracker saw something else decide this call before the person did. */
	markDecidedElsewhere(toolUseId: string): void;
	/** The running prompt's action id: the approval row's turn. */
	turnId: string;
	/** The request's `input` occurs unchanged in the line it came in on, so echoing it back says what Claude sent. */
	inputStable: boolean;
};

/** What a `tool_result` line said about how its call was decided and how it ended (T10's evidence). */
export type ClaudeToolResultInfo = {
	isError: boolean;
	nonExecutionKind: string | null;
	decisionSource: string | null;
	/** The result's text when it is a string or text blocks; null otherwise. */
	content: string | null;
};

export interface ClaudeApprovalPort {
	/** A request inside a turn this host sent, for one of the six tools. The port answers through `ctx.answer`. */
	onToolRequest(call: JsonRpcServerRequest, ctx: ClaudeApprovalContext): void | Promise<void>;
	/** Claude cancelled a request (something else decided, or an interrupt). */
	cancel(requestId: string): void;
	/** A `tool_result` for a call arrived. */
	toolResult(toolUseId: string, info?: ClaudeToolResultInfo): void;
	/** The turn ended: nothing held for it can still be answered. */
	turnEnded(): void;
	/** Stop is about to wait: no answer may be issued after this. */
	fence(): void;
	/**
	 * A person stopped the running turn (AGEN-119): decline what it holds and refuse its new requests until
	 * `turnEnded` or `liftTurnFence`. The session stays alive, so nothing here disposes.
	 */
	fenceTurn(): void;
	/** The turn did not stop in time: its later requests get cards again, as the server's predicate says. */
	liftTurnFence(): void;
	/** The runtime is gone: close what is held (`runtime_gone`). */
	dispose(): void;
}

// ---- outcome of a turn ----

export type TurnOutcome =
	| { ok: true }
	| {
			ok: false;
			code:
				| "api_error"
				| "login_lost"
				| "turn_error"
				| "exited"
				| "stopped"
				| "interrupted"
				| "first_prompt_failed"
				| "fatal";
			error: string;
	  };

/**
 * What `interruptTurn` found. `interrupted`: the turn ended as a person's stop (`beforeSend` when the prompt
 * was cancelled before anything reached Claude). `not_interrupted`: no turn by that id, or it ended its own way.
 * `didnt_stop`: Claude did not end the turn in time. `not_sent`: the interrupt could not be written.
 */
export type InterruptResult =
	| { status: "interrupted"; beforeSend?: true }
	| { status: "not_interrupted" }
	| { status: "didnt_stop" }
	| { status: "not_sent" };

export type SendPromptResult = {
	/** Resolves once, when the turn ends. */
	done: Promise<TurnOutcome>;
	metadata: Record<string, unknown>;
};

// ---- slots ----

const slots = new Set<string>();
const runtimes = new Map<string, ClaudeStreamRuntime>();

/** Reserves a slot synchronously. Throws `host_busy` past the cap, `rejected` for an id already held. */
function reserveSlot(sessionId: string, max: number): () => void {
	if (slots.has(sessionId))
		throw new ClaudeStartRefusal("rejected", "that session is already running here");
	if (slots.size >= max) throw new ClaudeStartRefusal("host_busy");
	slots.add(sessionId);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		slots.delete(sessionId);
	};
}

/**
 * Reserves a fork's slot synchronously, before any await, so two takeovers can't both pass a count and probe
 * logins for a ninth runtime. Throws `host_busy` past the cap. The returned function gives the slot back; a
 * start that is handed it as `reservedSlot` owns it from then on.
 */
export function reserveClaudeStreamSlot(sessionId: string, max?: number): () => void {
	return reserveSlot(sessionId, max ?? MAX_CLAUDE_STREAM_RUNTIMES);
}

export function hasClaudeStreamRuntime(sessionId: string): boolean {
	return runtimes.has(sessionId) || slots.has(sessionId);
}

export function claudeStreamRuntimeCount(): number {
	return slots.size;
}

export function getClaudeStreamRuntime(sessionId: string): ClaudeStreamRuntime | undefined {
	return runtimes.get(sessionId);
}

/** Stops every fork this process holds, and waits for them (the fatal-credential exit and tests). */
export async function disposeAllClaudeStreamRuntimes(
	timings: Partial<ClaudeStopTimings> = { interruptMs: 0, stdinCloseMs: 2_000 },
): Promise<void> {
	await Promise.all(
		[...runtimes.values()].map((runtime) => runtime.dispose(timings).catch(() => {})),
	);
}

/** Test hook: forget every slot and runtime (the processes are the test's to stop). */
export function _resetClaudeStreamForTest(): void {
	slots.clear();
	runtimes.clear();
}

// ---- the runtime ----

type RuntimeState = "starting" | "settling" | "live" | "stopping" | "gone";

type Turn = {
	actionId: string;
	uuid: string;
	text: string;
	first: boolean;
	phase: "checking" | "sent";
	initSeen: boolean;
	resultSeen: boolean;
	loginLost: boolean;
	calls: Map<string, ToolCallRecord>;
	/** A person asked this turn to stop and the host sent the interrupt (AGEN-119). */
	interruptRequested: boolean;
	/** A person asked for the stop before the prompt was sent: `sendPrompt` sends nothing (F37). */
	cancelBeforeSend: boolean;
	/** Settled by `sendPrompt` once it knows whether the cancel took: true, nothing was sent; false, it failed another way. */
	sendCancelled: { promise: Promise<boolean>; settle: (cancelled: boolean) => void };
	/** The one answer every `interruptTurn` for this turn gets (a repeated press shares the first). */
	interruptOutcome: Promise<InterruptResult> | null;
	/** Resolves when the turn ends, however it ends. */
	done: Promise<TurnOutcome>;
	/** The end of this turn was handed to the observer. */
	observed: boolean;
	/** Each call's `detailVerdict`, being decided off the hot path; awaited before a record reaches the observer. */
	verdicts: Map<string, Promise<void>>;
	/** Calls already handed to `onCallResulted`. */
	delivered: Set<string>;
	/** Calls whose result arrived after the interrupt was requested: their rows wait for the real outcome. */
	held: ToolCallRecord[];
	/** Tool-use ids a request was already made for this turn: a second request for one is declined. */
	requestedToolUses: Set<string>;
	/** ManagedWarning rows written this turn, capped. */
	warnings: number;
	resolve: (outcome: TurnOutcome) => void;
};

export type ClaudeStreamOptions = {
	sessionId: string;
	/** The session this fork continues. Absent for an in-place resume. */
	source?: string;
	/** The source transcript, judged unchanged across the start. */
	sourceFile?: string | null;
	mode: ClaudeForkMode;
	executable: string;
	/** From `forkArgv` or `inPlaceArgv`, never assembled here. */
	args: string[];
	/** The proved, canonical directory the fork runs in. */
	cwd: string;
	/** The supervisor's environment; the child's is derived from it (session markers stripped). */
	env: Readonly<Record<string, string | undefined>>;
	/** The version the binary reported before the spawn; `init.claude_code_version` must equal it. */
	expectedVersion: string | null;
	callbacks: LaunchCallbacks;
	/** Where Claude keeps its projects (for the peer message). Default `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
	configDir?: string;
	approvals?: ClaudeApprovalPort | null;
	/** What the fork's Claude may do. Default: no options. The same policy built `args`. */
	policy?: ForkToolPolicy;
	/** Called once per turn, whichever way it ends (see `fork-turn-observer.ts`). A throw is logged and swallowed. */
	onTurnFinished?: (turn: ObservedTurn) => void;
	/** Called when a call's result has arrived and its row is queued. */
	onCallResulted?: (call: ToolCallRecord) => void;
	/** Decides each call's `detailVerdict` from its intact input. Absent: `withhold`. */
	detailJudge?: DetailJudge;
	/** Undoes what preparing the fork's options wrote. Called once, when the fork ends for good. */
	cleanup?: () => void | Promise<void>;
	maxRuntimes?: number;
	/** How long `interruptTurn` waits for the turn's `result`. Default `CLAUDE_INTERRUPT_RESULT_WAIT_MS`; tests shorten it. */
	interruptWaitMs?: number;
	timings?: ClaudeStopTimings;
	link?: ClaudeLinkOptions;
	ownIdWaitMs?: number;
	/**
	 * The directory `agents --json` runs in. A neutral, private one: run in the conversation's own repository,
	 * Claude Code would load that repository's settings (AGEN-117 P5-B3). Default: `cwd`.
	 */
	agentsCwd?: string;
	/** A slot the caller reserved before its probes (`reserveClaudeStreamSlot`); released by the runtime or on a failed start. */
	reservedSlot?: () => void;
	log?: (line: string) => void;
	/** Where the per-prompt and start `agents --json` checks run. Default: the real listing. */
	listAgents?: typeof listClaudeAgentEntries;
	/** The reach options for the stop ladder (tests give it their own process table). */
	stopReach?: NonNullable<Parameters<ClaudeProcess["stop"]>[0]>["reach"];
};

const isRecord = (value: unknown): value is Record<string, any> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** A `tool_result`'s text: a string, or the text blocks of an array joined; null for anything else. */
function resultText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string")
			parts.push(block.text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

function forHostLog(value: unknown): string {
	const text = typeof value === "string" ? value : value instanceof Error ? value.message : "";
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) out += char;
		if (out.length >= 300) break;
	}
	return out;
}

/** How a turn's outcome reads to a call row. */
function turnOutcomeOf(outcome: TurnOutcome): TurnOutcomeKind {
	if (outcome.ok) return "completed";
	if (outcome.code === "stopped") return "stopped";
	if (outcome.code === "interrupted") return "interrupted";
	if (
		outcome.code === "fatal" ||
		outcome.code === "first_prompt_failed" ||
		outcome.code === "exited"
	) {
		return "fatal";
	}
	return "failed";
}

export class ClaudeStreamRuntime {
	state: RuntimeState = "starting";
	private turn: Turn | null = null;
	private firstPromptDone = false;
	private readonly ownUuids = new Set<string>();
	private readonly sentTexts: string[] = [];
	private fataling = false;
	/** A stop found something left running: the runtime stays held (map, slot) until a later stop confirms it gone. */
	private unstoppable = false;
	private stopRequested = false;
	private sourceBefore: { size: number; mtimeMs: number } | null = null;
	private readonly callbacks: LaunchCallbacks;
	private readonly log: (line: string) => void;
	private readonly listAgents: typeof listClaudeAgentEntries;
	private readonly port: ClaudeApprovalPort | null;
	private readonly policy: ForkToolPolicy;
	private cleaned = false;
	private readonly agentsEnv: Record<string, string>;
	/** Resolves once, when the process has ended and everything it owed the server was reported. */
	readonly closed: Promise<void>;
	private closeResolve!: () => void;

	constructor(
		readonly options: ClaudeStreamOptions,
		readonly proc: ClaudeProcess,
		private readonly releaseSlot: () => void,
	) {
		this.callbacks = options.callbacks;
		this.log = options.log ?? ((line) => console.warn(line));
		this.listAgents = options.listAgents ?? listClaudeAgentEntries;
		this.port = options.approvals ?? null;
		this.policy = options.policy ?? forkToolPolicy();
		this.agentsEnv = forkChildEnv(options.env);
		this.closed = new Promise<void>((resolve) => {
			this.closeResolve = resolve;
		});
		proc.link.onMessage((message) => this.onMessage(message));
		proc.link.client.onServerRequest((call) => this.onRequest(call));
		proc.link.client.onNotification((n) => {
			if (n.method === CLAUDE_CANCEL) {
				const id = (n.params as { request_id?: unknown } | undefined)?.request_id;
				if (typeof id === "string") this.port?.cancel(id);
			}
		});
		void proc.exited.then(() => this.onExit());
	}

	get sessionId() {
		return this.options.sessionId;
	}
	get pid() {
		return this.proc.pid;
	}
	get mode() {
		return this.options.mode;
	}
	get turnRunning() {
		return this.turn !== null;
	}

	/** Right before the success report: from here an exit is reported `degraded`. */
	beginSettle(): void {
		if (this.state === "starting") this.state = "settling";
	}

	/** The server committed the takeover. */
	settled(): void {
		if (this.state === "settling" || this.state === "starting") this.state = "live";
	}

	/** Read through a getter: the state changes across the awaits of a prompt, which narrowing can't see. */
	private get isGone(): boolean {
		return this.state === "gone";
	}

	/** True when a report about this session may leave the machine yet. */
	private get reporting(): boolean {
		return this.state === "settling" || this.state === "live" || this.state === "stopping";
	}

	// ---- reports ----

	private async report(op: string, fn: () => Promise<unknown>): Promise<void> {
		await reportInSessionSafely("claude-stream", this.sessionId, op, fn, disposeRuntimesAndExit);
	}

	private async reportEvents(events: Parameters<LaunchCallbacks["reportEvents"]>[0]) {
		if (!this.reporting) return undefined;
		return await this.callbacks.reportEvents(events);
	}

	private reportEventsSafely(op: string, events: Parameters<LaunchCallbacks["reportEvents"]>[0]) {
		return this.report(op, async () => {
			await this.reportEvents(events);
		});
	}

	private reportIdle(over: Record<string, unknown> = {}) {
		return this.report("idle", async () => {
			if (!this.reporting) return;
			await this.callbacks.reportState({
				sessionId: this.sessionId,
				agentType: "claude_code",
				managedState: "managed",
				status: "idle",
				...over,
			});
		});
	}

	// ---- prompts ----

	/**
	 * Sends a person's prompt as a turn. Refuses (a thrown `ClaudePromptRefusal` with the fixed sentence the
	 * action carries) rather than queue: one turn runs at a time, and the host is the authority on busy.
	 */
	async sendPrompt(text: string, actionId: string): Promise<SendPromptResult> {
		if (this.state !== "settling" && this.state !== "live") {
			throw new ClaudePromptRefusal("no_runtime", CLAUDE_FORK_NO_RUNTIME_ERROR);
		}
		if (this.stopRequested) throw new ClaudePromptRefusal("stopping", CLAUDE_FORK_NO_RUNTIME_ERROR);
		if (/^\s*\//.test(text)) throw new ClaudePromptRefusal("slash", CLAUDE_FORK_SLASH_MESSAGE);
		if (this.turn) throw new ClaudePromptRefusal("busy", CLAUDE_FORK_BUSY_ERROR);

		// Claimed before the first await, so a second prompt in the same tick sees a turn and is refused.
		const uuid = crypto.randomUUID();
		let resolve!: (outcome: TurnOutcome) => void;
		const done = new Promise<TurnOutcome>((r) => {
			resolve = r;
		});
		let settleCancel!: (cancelled: boolean) => void;
		const sendCancelled = new Promise<boolean>((r) => {
			settleCancel = r;
		});
		const turn: Turn = {
			actionId,
			uuid,
			text,
			first: !this.firstPromptDone,
			phase: "checking",
			initSeen: false,
			resultSeen: false,
			loginLost: false,
			calls: new Map(),
			interruptRequested: false,
			cancelBeforeSend: false,
			sendCancelled: { promise: sendCancelled, settle: settleCancel },
			interruptOutcome: null,
			done,
			observed: false,
			verdicts: new Map(),
			delivered: new Set(),
			held: [],
			requestedToolUses: new Set(),
			warnings: 0,
			resolve,
		};
		this.turn = turn;
		const release = (): void => {
			if (this.turn === turn) this.turn = null;
		};

		let recorded = false;
		try {
			await this.assertNotOpenElsewhere();
			if (this.turn !== turn || this.isGone) {
				throw new ClaudePromptRefusal("no_runtime", CLAUDE_FORK_NO_RUNTIME_ERROR);
			}
			if (turn.first) await this.noteSourceAtFirstPrompt();

			// Recorded first: if the gate throws or withholds, nothing is sent.
			let outcome: Awaited<ReturnType<LaunchCallbacks["reportEvents"]>> | undefined;
			try {
				outcome = await this.reportEvents([
					{
						eventType: "HeadlessPromptSubmitted",
						category: "prompt",
						content: text,
						rawPayload: { source: "agentpulse_workspace", ...MARKER },
					},
				]);
			} catch (error) {
				this.log(
					`[claude-stream] couldn't record a prompt (session=${this.sessionId}): ${forHostLog(error)}`,
				);
				throw new ClaudePromptRefusal("not_recorded", PROMPT_NOT_RECORDED);
			}
			if (outcome !== "sent" && outcome !== "queued") throw new ClaudePromptWithheld();
			recorded = true;
			if (this.turn !== turn || this.isGone || this.stopRequested) {
				throw new ClaudePromptRefusal("stopping", CLAUDE_FORK_NO_RUNTIME_ERROR);
			}
		} catch (error) {
			release();
			turn.sendCancelled.settle(false);
			// The server may hold a turn start for a prompt that will not be sent (a recorded prompt the process
			// never got, or a gate that threw after the server heard): an idle report ends the working state it
			// set. A stop or a dead process reports its own end.
			if (
				(recorded || (error instanceof ClaudePromptRefusal && error.kind === "not_recorded")) &&
				!this.stopRequested &&
				!this.fataling &&
				!this.isGone
			) {
				await this.reportIdle();
			}
			throw error;
		}

		// A person stopped the turn before the prompt got here: nothing is sent, and the server's turn ends as
		// any interrupted turn does (not an idle report, which would leave the acknowledgement undone).
		if (turn.cancelBeforeSend) {
			release();
			await this.reportEventsSafely("interrupted-before-send", [
				{
					eventType: "HeadlessPromptFailed",
					category: "system_event" as const,
					content: TURN_STOPPED_BY_PERSON,
					rawPayload: {
						status: INTERRUPTED_STATUS,
						code: INTERRUPTED_BEFORE_SEND_CODE,
						...MARKER,
					},
				},
			]);
			void this.observeTurn(turn, "interrupted");
			turn.sendCancelled.settle(true);
			turn.resolve({ ok: false, code: "interrupted", error: STOPPED_BEFORE_SEND });
			throw new ClaudePromptRefusal("interrupted_before_send", STOPPED_BEFORE_SEND);
		}
		turn.phase = "sent";
		this.ownUuids.add(uuid);
		this.sentTexts.push(text);
		if (this.sentTexts.length > MAX_SENT_TEXTS) this.sentTexts.shift();
		this.proc.link.sendUser(text, uuid);
		await this.proc.link.flush();
		return {
			done,
			metadata: { mode: "claude_stream", forkMode: this.mode, turnUuid: uuid },
		};
	}

	/** Refuses unless no other process lists this conversation; failure to ask also refuses. */
	private async assertNotOpenElsewhere(): Promise<void> {
		const listing = await this.listAgents({
			executable: this.options.executable,
			cwd: this.options.agentsCwd ?? this.options.cwd,
			env: this.agentsEnv,
		});
		if (!listing.ok) {
			this.log(`[claude-stream] agents check failed (session=${this.sessionId}): ${listing.why}`);
			throw new ClaudePromptRefusal("check_failed", CLAUDE_FORK_CHECK_FAILED_ERROR);
		}
		const other = listing.entries.some(
			(entry) => entry.sessionId === this.sessionId && entry.pid !== this.proc.pid,
		);
		if (other) throw new ClaudePromptRefusal("terminal_found", CLAUDE_FORK_TERMINAL_FOUND_ERROR);
	}

	/** The source transcript changing after the preflight is logged beside the turn, not a reason to stop it. */
	private async noteSourceAtFirstPrompt(): Promise<void> {
		const before = this.sourceBefore;
		const file = this.options.sourceFile;
		if (!before || !file) return;
		const now = await statOrNull(file);
		if (!now || now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
			this.log(
				`[claude-stream] the source transcript changed since the start (session=${this.sessionId}); the turn goes on`,
			);
		}
	}

	/** Called by the start sequence with the source's stat from before the spawn. */
	noteSourceBefore(stat: { size: number; mtimeMs: number } | null): void {
		this.sourceBefore = stat;
	}

	// ---- lines ----

	private onMessage(message: ClaudeMessage): void {
		if (this.state === "gone" || this.fataling) return;
		const type = message.type;
		// The first prompt's `init` is judged by the first-prompt assertions (N goes `failed`, not resumable).
		if (
			type === "system" &&
			message.subtype === "init" &&
			this.turn?.first &&
			!this.turn.initSeen
		) {
			this.onInit(message);
			return;
		}
		// The id rule: any line naming another session (a /clear swaps the id inside a running process).
		const lineSession = message.session_id;
		if (typeof lineSession === "string" && lineSession !== "" && lineSession !== this.sessionId) {
			this.raise("id_changed");
			return;
		}
		if (type === "conversation_reset") {
			this.raise("id_changed");
			return;
		}
		if (type === "command_lifecycle") {
			const uuid = message.command_uuid;
			// A line for a uuid the host never stamped is a turn somebody else sent.
			if (typeof uuid === "string" ? !this.ownUuids.has(uuid) : !this.turn) this.raise("peer_turn");
			return;
		}
		if (type === "system") {
			if (message.subtype === "init") this.onInit(message);
			return;
		}
		if (type === "assistant" || type === "user") {
			const turn = this.turn;
			const line = this.policy.classifyLine(message);
			if (typeof line === "object") {
				this.raise(line.reject);
				return;
			}
			// A line with no turn open is a turn nobody sent; a subagent still working after its turn is its own
			// ending (not a stranger's). The fork's own lines in the moment between its `result` and the end of
			// the turn are accepted as before: Claude prints its closing text there (recorded, 2.1.318
			// `key-restricted-clean`).
			if (!turn || (turn.resultSeen && line === "subagent")) {
				this.raise(line === "subagent" ? "subagent_after_turn" : "peer_turn");
				return;
			}
			const subagent = line === "subagent";
			if (type === "assistant") this.onAssistant(message, subagent);
			else this.onToolResults(message, subagent);
			return;
		}
		if (type === "result") {
			const turn = this.turn;
			if (!turn || turn.resultSeen) {
				this.raise("peer_turn");
				return;
			}
			this.onResult(turn, message);
		}
		// stream_event, rate_limit_event and the rest say nothing a takeover acts on.
	}

	private onInit(message: ClaudeMessage): void {
		const turn = this.turn;
		if (!turn) {
			this.raise("peer_turn");
			return;
		}
		const uuids = message.user_message_uuids;
		if (Array.isArray(uuids) && !uuids.includes(turn.uuid)) {
			this.raise("peer_turn");
			return;
		}
		if (turn.first && !turn.initSeen) {
			// The first init is judged whole: a mismatch fails this prompt and the session (not resumable).
			const problem = this.firstPromptProblem(message);
			if (problem) {
				this.log(
					`[claude-stream] first prompt assertion failed (session=${this.sessionId}): ${problem}`,
				);
				this.raiseFirstPrompt(turn);
				return;
			}
			this.firstPromptDone = true;
		} else if (message.permissionMode !== "default") {
			this.raise("mode_changed");
			return;
		}
		turn.initSeen = true;
	}

	/** What the first `init` must show; the code names the failed rule in the host log only. */
	private firstPromptProblem(init: ClaudeMessage): string | null {
		if (init.session_id !== this.sessionId) return "session_id";
		if (init.permissionMode !== "default") return "permission_mode";
		const expected = this.options.expectedVersion;
		if (expected && init.claude_code_version !== expected) return "version";
		if (!Array.isArray(init.capabilities) || !init.capabilities.includes(REQUIRED_CAPABILITY)) {
			return "capability";
		}
		const toolsProblem = this.policy.initToolsProblem(init);
		if (toolsProblem !== null) return toolsProblem;
		if (!Array.isArray(init.slash_commands) || init.slash_commands.length !== 0)
			return "slash_commands";
		if (this.options.mode === "restricted") {
			if ("messaging_socket_path" in init || "memory_paths" in init)
				return "restricted_not_in_effect";
		}
		return null;
	}

	private onAssistant(message: ClaudeMessage, subagent = false): void {
		const turn = this.turn;
		if (!turn) return;
		const inner = isRecord(message.message) ? message.message : null;
		const content = Array.isArray(inner?.content) ? (inner?.content as unknown[]) : [];
		const texts: string[] = [];
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === "tool_use" && typeof block.id === "string") {
				if (!turn.calls.has(block.id)) this.recordCall(turn, block, message, subagent);
			} else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				texts.push(block.text);
			}
		}
		// A subagent's words are never the fork's own: the watcher's human gate reads them as Claude's.
		if (subagent) return;
		if (inner?.model === "<synthetic>" && /not logged in/i.test(texts.join(" "))) {
			turn.loginLost = true;
			return;
		}
		if (texts.length > 0) {
			void this.reportEventsSafely(
				"assistant",
				texts.map((text) => ({
					eventType: "HeadlessAssistantMessage",
					category: "assistant_message" as const,
					content: text,
					rawPayload: { source: "claude_stream", ...MARKER },
				})),
			);
		}
	}

	/** Records one `tool_use` block, and starts deciding its detail verdict from the intact input. */
	private recordCall(
		turn: Turn,
		block: Record<string, unknown>,
		message: ClaudeMessage,
		subagent: boolean,
	): void {
		const id = block.id as string;
		const name = typeof block.name === "string" ? block.name : "";
		const call = newToolCallRecord({
			toolUseId: id,
			name,
			detailInput: block.input,
			detailPaths: detailPathsOf(block.input),
			agentId: subagent && typeof message.agent_id === "string" ? message.agent_id : null,
			parentToolUseId:
				typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null,
		});
		turn.calls.set(id, call);
		const judge = this.options.detailJudge;
		turn.verdicts.set(
			id,
			(judge ? judge(name, block.input) : Promise.resolve("withhold" as const)).then(
				(verdict) => {
					call.detailVerdict = verdict;
				},
				() => {
					call.detailVerdict = "withhold";
				},
			),
		);
	}

	private onToolResults(message: ClaudeMessage, _subagent = false): void {
		const turn = this.turn;
		if (!turn) return;
		const inner = isRecord(message.message) ? message.message : null;
		const content = Array.isArray(inner?.content) ? (inner?.content as unknown[]) : [];
		const metas = Array.isArray(message.tool_result_meta)
			? (message.tool_result_meta as unknown[])
			: [];
		for (const block of content) {
			if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string")
				continue;
			const call = turn.calls.get(block.tool_use_id);
			if (!call || call.resulted) continue;
			const meta = metas.find((m) => isRecord(m) && m.id === block.tool_use_id);
			call.resulted = true;
			call.isError = block.is_error === true;
			if (isRecord(meta)) {
				call.nonExecutionKind =
					typeof meta.non_execution_kind === "string" ? meta.non_execution_kind : null;
				const source = isRecord(meta.permission_decision) ? meta.permission_decision.source : null;
				call.decisionSource = typeof source === "string" ? source : null;
			}
			const text = resultText(block.content);
			const cut = cutDetailResult(text);
			call.detailResult = cut.text;
			call.detailResultBytes = cut.bytes;
			this.port?.toolResult(call.toolUseId, {
				isError: call.isError,
				nonExecutionKind: call.nonExecutionKind,
				decisionSource: call.decisionSource,
				content: text,
			});
			// Once a stop was asked for, a result is not yet "failed" or "ran": its row and its detail wait for
			// the real outcome of the turn (AGEN-119). Calls that resulted before keep their live row.
			if (turn.interruptRequested) {
				turn.held.push(call);
				continue;
			}
			this.emitResultedCall(turn, call, "running");
		}
	}

	/** The row of a call whose result has arrived, then the observer's `onCallResulted` once its verdict is in. */
	private emitResultedCall(turn: Turn, call: ToolCallRecord, outcome: TurnOutcomeKind): void {
		void this.reportEventsSafely("tool-row", [this.callRow(call, outcome)]);
		turn.delivered.add(call.toolUseId);
		void this.observeCall(turn, call);
	}

	private callRow(call: ToolCallRecord, outcome: TurnOutcomeKind) {
		return this.rowEvent(
			callRowText(call, this.policy.naming, { turnOutcome: outcome }),
			"call",
			callRowPayload(call, { turnOutcome: outcome }),
		);
	}

	private async observeCall(turn: Turn, call: ToolCallRecord): Promise<void> {
		await turn.verdicts.get(call.toolUseId);
		try {
			this.options.onCallResulted?.(call);
		} catch (error) {
			this.log(
				`[claude-stream] the call observer threw (session=${this.sessionId}): ${forHostLog(error)}`,
			);
		}
	}

	/** Hands the end of a turn to the observer once, whichever way it ended. */
	private async observeTurn(turn: Turn, ended: TurnEnding): Promise<void> {
		if (turn.observed) return;
		turn.observed = true;
		const calls = [...turn.calls.values()].filter((c) => !turn.delivered.has(c.toolUseId));
		await Promise.allSettled([...turn.verdicts.values()]);
		try {
			this.options.onTurnFinished?.({ actionId: turn.actionId, ended, calls });
		} catch (error) {
			this.log(
				`[claude-stream] the turn observer threw (session=${this.sessionId}): ${forHostLog(error)}`,
			);
		}
	}

	/** Test seam: marks the running turn as one a person asked to stop (AGEN-119 sets it in production). */
	_setInterruptRequestedForTest(value: boolean): void {
		if (this.turn) this.turn.interruptRequested = value;
	}

	private rowEvent(content: string, kind: string, extra: Record<string, unknown> = {}) {
		return {
			eventType: "HeadlessStatus",
			category: "progress_update" as const,
			content,
			rawPayload: { source: "claude_stream", kind, ...MARKER, ...extra },
		};
	}

	private onResult(turn: Turn, result: ClaudeMessage): void {
		turn.resultSeen = true;
		if (this.stopRequested) {
			// The interrupt of a person's Stop ends the turn: the Stop reports `stopped`, and an idle report here would undo it.
			this.port?.turnEnded();
			this.turn = null;
			void this.observeTurn(turn, "stopped");
			turn.resolve({ ok: false, code: "stopped", error: STOPPED_BY_PERSON_ERROR });
			return;
		}
		const apiError = result.terminal_reason === "api_error";
		const failed = apiError || result.is_error === true;
		// "Stopped by a person" is decided from the result itself, never from the flag alone (F38): the turn may
		// have finished on its own just before the interrupt landed.
		const interrupted =
			turn.interruptRequested &&
			result.is_error === true &&
			typeof result.terminal_reason === "string" &&
			INTERRUPTED_TERMINAL_REASONS.includes(result.terminal_reason);
		const outcome: TurnOutcome = interrupted
			? { ok: false, code: "interrupted", error: TURN_STOPPED_BY_PERSON }
			: !failed
				? { ok: true }
				: turn.loginLost
					? { ok: false, code: "login_lost", error: CLAUDE_LOGIN_LOST_ERROR }
					: apiError
						? { ok: false, code: "api_error", error: CLAUDE_API_ERROR_MESSAGE }
						: turn.interruptRequested
							? { ok: false, code: "turn_error", error: TURN_ERRORED_AFTER_STOP }
							: { ok: false, code: "turn_error", error: TURN_ERROR_MESSAGE };
		void this.finishTurn(turn, outcome);
	}

	/**
	 * A person's Stop turn (AGEN-119): ends what the turn is doing and keeps the process, the session and the
	 * lock-holding prompt. Nothing is signalled. Asked again for the same turn, it shares the first answer.
	 */
	interruptTurn(targetActionId: string): Promise<InterruptResult> {
		const turn = this.turn;
		if (
			!turn ||
			turn.actionId !== targetActionId ||
			this.stopRequested ||
			this.fataling ||
			this.isGone
		) {
			return Promise.resolve({ status: "not_interrupted" });
		}
		if (turn.interruptOutcome) return turn.interruptOutcome;
		const run = (
			turn.phase === "sent" ? this.interruptSentTurn(turn) : this.cancelUnsentTurn(turn)
		).then((result) => {
			// "Try again" is offered after a stop that didn't take: the next press starts a fresh attempt.
			if (result.status === "didnt_stop" || result.status === "not_sent")
				turn.interruptOutcome = null;
			return result;
		});
		turn.interruptOutcome = run;
		return run;
	}

	/** The prompt has not reached Claude: `sendPrompt` checks the flag right before it writes the user line (F37). */
	private async cancelUnsentTurn(turn: Turn): Promise<InterruptResult> {
		turn.cancelBeforeSend = true;
		return (await turn.sendCancelled.promise)
			? { status: "interrupted", beforeSend: true }
			: { status: "not_interrupted" };
	}

	private async interruptSentTurn(turn: Turn): Promise<InterruptResult> {
		turn.interruptRequested = true;
		this.port?.fenceTurn();
		const waitMs = this.options.interruptWaitMs ?? CLAUDE_INTERRUPT_RESULT_WAIT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let failed!: () => void;
		const notSent = new Promise<"not_sent">((resolve) => {
			failed = () => resolve("not_sent");
		});
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), waitMs);
			timer.unref?.();
		});
		this.proc.link.interrupt().catch(() => failed());
		const settled = await Promise.race([turn.done, notSent, timeout]);
		clearTimeout(timer);
		if (settled === "timeout" || settled === "not_sent") {
			// Claude did not stop: the turn goes on as it was, and its later requests get cards again (the
			// server's fence ignores a failed interrupt, so the host's must too).
			turn.interruptRequested = false;
			this.port?.liftTurnFence();
			return { status: settled === "timeout" ? "didnt_stop" : "not_sent" };
		}
		return !settled.ok && settled.code === "interrupted"
			? { status: "interrupted" }
			: { status: "not_interrupted" };
	}

	/** The one place a turn ends: rows, the marked end event, the idle report, then the action's outcome. */
	private async finishTurn(turn: Turn, outcome: TurnOutcome): Promise<void> {
		if (this.turn !== turn) return;
		// Held requests for this turn can no longer be answered.
		this.port?.turnEnded();
		const calls = [...turn.calls.values()];
		const turnOutcome = turnOutcomeOf(outcome);
		const rows = [];
		// Calls whose result arrived after an interrupt was asked for get their row, and their `onCallResulted`,
		// now that the turn's real outcome is known (AGEN-119).
		for (const call of turn.held) {
			rows.push(this.callRow(call, turnOutcome));
			turn.delivered.add(call.toolUseId);
			void this.observeCall(turn, call);
		}
		for (const call of calls) {
			if (!call.resulted) rows.push(this.callRow(call, turnOutcome));
		}
		const naming = this.policy.naming;
		const unasked = unaskedTurnText(calls, this.mode, naming);
		if (unasked) rows.push(this.rowEvent(unasked, "turn_unasked"));
		const refused = refusedTurnText(calls, naming);
		if (refused) rows.push(this.rowEvent(refused, "turn_refused"));
		rows.push({
			eventType: outcome.ok ? "HeadlessPromptCompleted" : "HeadlessPromptFailed",
			category: "system_event" as const,
			content: outcome.ok ? TURN_COMPLETED_CONTENT : outcome.error,
			rawPayload: { status: outcome.ok ? "completed" : outcome.code, ...MARKER },
		});
		await this.reportEventsSafely("turn-end", rows);
		this.turn = null;
		await this.reportIdle();
		await this.observeTurn(
			turn,
			!outcome.ok && outcome.code === "interrupted" ? "interrupted" : "result",
		);
		turn.resolve(outcome);
	}

	private async failFirstPrompt(turn: Turn): Promise<void> {
		if (this.fataling) return;
		this.fataling = true;
		this.port?.dispose();
		void this.observeTurn(turn, "first_prompt_failed");
		turn.resolve({
			ok: false,
			code: "first_prompt_failed",
			error: CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR,
		});
		this.turn = null;
		await this.proc.stop(this.fatalStopOptions);
		await this.report("first-prompt-failed", async () => {
			if (!this.reporting) return;
			await this.callbacks.reportState({
				sessionId: this.sessionId,
				agentType: "claude_code",
				managedState: "failed",
				status: "failed",
			});
		});
		this.finish();
	}

	// ---- requests ----

	private onRequest(call: JsonRpcServerRequest): void {
		if (this.state === "gone" || this.fataling) return;
		// Precedence: a request with no turn the host sent is fatal, with no local tool response written.
		const turn = this.turn;
		if (!turn || turn.phase !== "sent") {
			this.raise("peer_turn");
			return;
		}
		if (call.method !== CLAUDE_CAN_USE_TOOL) {
			this.answer(call.id as string, denyResponse(CLAUDE_LOCAL_DECLINE_TEXT));
			return;
		}
		const params = isRecord(call.params) ? call.params : {};
		const toolName = typeof params.tool_name === "string" ? params.tool_name : "";
		const toolUseId = typeof params.tool_use_id === "string" ? params.tool_use_id : "";
		const record = toolUseId ? turn.calls.get(toolUseId) : undefined;
		const requestId = call.id as string;
		// A request that is not the shape recorded (no tool name, no tool-use id, an input that is not an
		// object), one for a tool-use id already asked about this turn, one from a subagent (`agent_id` in any
		// form) and one for a tool outside the six are never shown to a person: declined here, by its own id.
		const malformed = toolName === "" || toolUseId === "" || !isRecord(params.input);
		const duplicate = toolUseId !== "" && turn.requestedToolUses.has(toolUseId);
		if (toolUseId !== "") turn.requestedToolUses.add(toolUseId);
		if (record && !duplicate) record.requested = true;
		// Checks no policy can loosen: a tool the policy does not list (an `mcp__` tool counts only for an applied
		// server) is declined. A request carrying `agent_id` also needs the policy's say-so, which by default is no.
		const listed =
			this.policy.tools.includes(toolName) || isAppliedMcpTool(toolName, this.policy.applied);
		const outsideTheSet =
			!listed || ("agent_id" in params && this.policy.requestAllowed(params) !== "allow");
		if (malformed || duplicate || outsideTheSet || !this.port) {
			this.declineLocally(requestId, duplicate ? undefined : record);
			return;
		}
		const ctx: ClaudeApprovalContext = {
			answer: (id, body) => this.answer(id, body, record),
			markDecidedElsewhere: (id) => {
				const target = turn.calls.get(id);
				if (target) target.decidedElsewhere = true;
			},
			turnId: turn.actionId,
			inputStable: this.proc.link.requestInputStable(requestId),
		};
		// The approval path throwing, in step or later, is a decline by its own id: never an error reply (the model
		// would read its text) and never a dead runtime.
		try {
			Promise.resolve(this.port.onToolRequest(call, ctx)).catch((error) => {
				this.log(
					`[claude-stream] the approval path rejected (session=${this.sessionId}): ${forHostLog(error)}`,
				);
				this.declineLocally(requestId, record);
			});
		} catch (error) {
			this.log(
				`[claude-stream] the approval path threw (session=${this.sessionId}): ${forHostLog(error)}`,
			);
			this.declineLocally(requestId, record);
		}
	}

	private declineLocally(requestId: string, record: ToolCallRecord | undefined): void {
		const wrote = this.answer(requestId, denyResponse(CLAUDE_LOCAL_DECLINE_TEXT), record);
		if (record && wrote) record.declinedLocally = true;
		const turn = this.turn;
		if (!wrote || !turn || turn.warnings >= MAX_WARNINGS_PER_TURN) return;
		turn.warnings++;
		void this.reportEventsSafely("decline-warning", [
			{
				eventType: "ManagedWarning",
				category: "system_event",
				content: LOCAL_DECLINE_WARNING,
				rawPayload: { source: "claude_stream", ...MARKER },
			},
		]);
	}

	/** The only writer of a tool answer. Refuses once the runtime is fatal, stopping or gone. */
	private answer(requestId: string, body: unknown, record?: ToolCallRecord): boolean {
		if (this.state === "gone" || this.fataling) return false;
		const wrote = this.proc.link.client.respond(requestId, body);
		if (wrote && record && isRecord(body))
			record.answer = body.behavior === "allow" ? "allow" : "deny";
		return wrote;
	}

	// ---- ending ----

	private raise(kind: "id_changed" | "mode_changed" | ForkRejectCode): void {
		this.fatal(kind).catch((error) => {
			this.log(
				`[claude-stream] ending a fork failed (session=${this.sessionId}): ${forHostLog(error)}`,
			);
		});
	}

	private raiseFirstPrompt(turn: Turn): void {
		this.failFirstPrompt(turn).catch((error) => {
			this.log(
				`[claude-stream] failing a first prompt failed (session=${this.sessionId}): ${forHostLog(error)}`,
			);
		});
	}

	/** A process that misbehaved is not asked politely twice: straight to stdin, then the signals. */
	private get fatalStopOptions() {
		return {
			timings: { ...(this.options.timings ?? {}), interruptMs: 0 },
			reach: this.options.stopReach,
		};
	}

	private async fatal(kind: "id_changed" | "mode_changed" | ForkRejectCode): Promise<void> {
		if (this.fataling || this.state === "gone") return;
		this.fataling = true;
		this.log(`[claude-stream] protocol violation (session=${this.sessionId}): ${kind}`);
		// Nothing is answered after this: the tracker closes what it holds, the client stops writing.
		this.port?.dispose();
		const turn = this.turn;
		this.proc.link.transportClosed(new Error("fatal"));
		// Stopped before anything is read: the stranger's turn must not run on while the text is looked for.
		const stopped = await this.proc.stop(this.fatalStopOptions).catch(() => ({ gone: false }));
		// Not confirmed ended (CX2-1): the fork stays held, so a Resume cannot start a second one beside it.
		this.unstoppable = !stopped.gone;
		let peerTurnText: string | undefined;
		if (kind === "peer_turn" && stopped.gone) peerTurnText = await this.readPeerText();
		const words = this.unstoppable
			? CLAUDE_FORK_UNSTOPPABLE_SYNC_ERROR
			: kind === "peer_turn"
				? CLAUDE_FORK_PEER_SYNC_ERROR
				: kind === "mcp_servers_changed"
					? CLAUDE_FORK_MCP_CHANGED_SYNC_ERROR
					: kind === "subagent_after_turn"
						? CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR
						: CLAUDE_FORK_CHANGED_SYNC_ERROR;
		const events = [];
		if (turn) {
			events.push({
				eventType: "HeadlessPromptFailed",
				category: "system_event" as const,
				content: words,
				rawPayload: { status: kind, ...MARKER },
			});
		}
		if (events.length > 0) await this.reportEventsSafely("fatal-end", events);
		await this.report("fatal-degraded", async () => {
			if (!this.reporting) return;
			await this.callbacks.reportState({
				sessionId: this.sessionId,
				agentType: "claude_code",
				managedState: "degraded",
				status: "idle",
				providerSyncState: "failed",
				providerSyncError: words,
				...(peerTurnText !== undefined ? { peerTurnText } : {}),
			});
		});
		this.turn = null;
		if (turn) void this.observeTurn(turn, "fatal");
		turn?.resolve({ ok: false, code: "fatal", error: words });
		if (!this.unstoppable) this.finish();
	}

	/** The process ended by itself (or by our ladder): report once, whatever state it was in. */
	private async onExit(): Promise<void> {
		if (this.state === "gone") return;
		// A fatal ending finishes itself. A stop usually does too, but one that found something left running
		// (gone: false) must not leave the slot held for good once the child itself has gone: the ladder is asked
		// again (it runs the table check, and signals what is still there), and the slot is freed if all is gone.
		if (this.fataling) {
			// The exit of a fork that could not be stopped: ask again, and let go only once everything is gone.
			if (this.unstoppable) {
				void this.proc
					.stop({ timings: { interruptMs: 0 }, reach: this.options.stopReach })
					.then((result) => {
						if (result.gone) this.finish();
					})
					.catch(() => {});
			}
			return;
		}
		if (this.stopRequested) {
			void this.proc
				.stop({ timings: { interruptMs: 0 }, reach: this.options.stopReach })
				.then((result) => {
					if (result.gone) this.finish();
				})
				.catch(() => {});
			return;
		}
		this.fataling = true;
		this.port?.dispose();
		const turn = this.turn;
		this.log(
			`[claude-stream] the process exited (session=${this.sessionId}, stderr=${this.proc.stderrBytes()} bytes, not logged)`,
		);
		if (turn) {
			await this.reportEventsSafely("exit-turn", [
				{
					eventType: "HeadlessPromptFailed",
					category: "system_event",
					content: HOST_RESTARTED_TURN_ERROR,
					rawPayload: { status: "exited", ...MARKER },
				},
			]);
		}
		await this.report("exit-degraded", async () => {
			if (!this.reporting) return;
			await this.callbacks.reportState({
				sessionId: this.sessionId,
				agentType: "claude_code",
				managedState: "degraded",
				status: "idle",
				providerSyncState: "failed",
				providerSyncError: CLAUDE_FORK_EXITED_SYNC_ERROR,
			});
		});
		this.turn = null;
		if (turn) void this.observeTurn(turn, "exit");
		turn?.resolve({ ok: false, code: "exited", error: CLAUDE_FORK_EXITED_SYNC_ERROR });
		this.finish();
	}

	private finish(): void {
		if (this.state === "gone") return;
		this.state = "gone";
		runtimes.delete(this.sessionId);
		this.releaseSlot();
		this.runCleanup();
		this.closeResolve();
	}

	/** Undoes what preparing the fork's options wrote, once, whichever way the fork ended. Never throws. */
	runCleanup(): void {
		if (this.cleaned) return;
		this.cleaned = true;
		try {
			const result = this.options.cleanup?.();
			if (result instanceof Promise) {
				result.catch((error) =>
					this.log(
						`[claude-stream] cleanup failed (session=${this.sessionId}): ${forHostLog(error)}`,
					),
				);
			}
		} catch (error) {
			this.log(`[claude-stream] cleanup failed (session=${this.sessionId}): ${forHostLog(error)}`);
		}
	}

	/**
	 * Stops the fork (a person's Stop): fence the approvals first, then interrupt, close stdin, SIGTERM and
	 * SIGKILL. The caller reports `stopped`; a prompt in flight fails with the Stop's words.
	 */
	async stop(timings?: Partial<ClaudeStopTimings>): Promise<{ gone: boolean; checked: boolean }> {
		this.stopRequested = true;
		if (this.state !== "gone") this.state = this.state === "starting" ? "starting" : "stopping";
		const turn = this.turn;
		const result = await this.proc.stop({
			timings: { ...this.options.timings, ...timings },
			before: () => this.port?.fence(),
			reach: this.options.stopReach,
		});
		this.port?.dispose();
		this.turn = null;
		if (turn) void this.observeTurn(turn, "stopped");
		turn?.resolve({ ok: false, code: "stopped", error: STOPPED_BY_PERSON_ERROR });
		if (result.gone) this.finish();
		return result;
	}

	/**
	 * Ends the process with no report: the start sequence refused, or the host is exiting. A process that is not
	 * confirmed gone leaves the runtime held (CX2-1); the answer says so.
	 */
	async dispose(timings?: Partial<ClaudeStopTimings>): Promise<{ gone: boolean }> {
		this.stopRequested = true;
		this.port?.dispose();
		const result = await this.proc
			.stop({
				timings: { ...this.options.timings, ...timings },
				reach: this.options.stopReach,
			})
			.catch(() => ({ gone: false }));
		const turn = this.turn;
		if (turn) void this.observeTurn(turn, "exit");
		turn?.resolve({ ok: false, code: "exited", error: CLAUDE_FORK_EXITED_SYNC_ERROR });
		this.turn = null;
		if (result.gone) this.finish();
		else this.unstoppable = true;
		return { gone: result.gone };
	}

	/** Whether a stop found something it could not end: the runtime is still held and a later stop may release it. */
	get heldUnstoppable() {
		return this.unstoppable && this.state !== "gone";
	}

	// ---- the injected message ----

	/** The last text this process's transcript holds that the host did not send, capped: the last one found, not necessarily the one that stopped the session. Never throws. */
	/**
	 * The stranger's message, from the transcript, once the process has ended. Only a line Claude itself tags as
	 * a peer's (`origin.kind === "peer"`) counts: a fork's transcript begins with the source's copied history, and
	 * the last line the host did not send can be one of the person's own earlier prompts (measured, canary
	 * `peer-inject`). The tag is written a moment after the stream shows the turn, so it is waited for briefly.
	 * When none appears the answer is the empty string, which the server stores as "message not captured".
	 */
	private async readPeerText(): Promise<string> {
		for (let attempt = 0; attempt < PEER_TEXT_ATTEMPTS; attempt++) {
			const text = this.readPeerTextOnce();
			if (text !== undefined) return text;
			await new Promise((resolve) => setTimeout(resolve, PEER_TEXT_WAIT_MS));
		}
		return "";
	}

	private readPeerTextOnce(): string | undefined {
		try {
			const configDir = this.options.configDir ?? defaultConfigDir(this.options.env);
			if (configDir === null) return undefined;
			return readPeerTurnText({
				configDir,
				sessionId: this.sessionId,
				sentTexts: this.sentTexts,
				peerOnly: true,
			});
		} catch {
			return undefined;
		}
	}
}

// ---- the injected message's text ----

/**
 * Where Claude keeps its projects for this supervisor: the configured directory, else `~/.claude`. Null when
 * that is not an absolute path (no HOME, a relative setting): a relative path would be read against whatever
 * directory the supervisor happens to be in.
 */
export function defaultConfigDir(env: Readonly<Record<string, string | undefined>>): string | null {
	const dir = env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, ".claude") : "");
	return isAbsolute(dir) ? dir : null;
}

/** Plain text of a transcript `user` line's content: a string, or the text blocks of an array. Null for a tool result. */
function userLineText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string")
			parts.push(block.text);
		else if (isRecord(block) && block.type === "tool_result") return null;
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * The last top-level `user` line in the session's transcript whose text the host did not send, cut to
 * 1 KiB. Found by exactly one `projects/<dir>/<session>.jsonl` under the config directory (a fork shares its
 * source's project directory), and read from its tail only. Undefined when nothing qualifies.
 */
export function readPeerTurnText(input: {
	configDir: string;
	sessionId: string;
	sentTexts: readonly string[];
	/** Count only lines Claude itself tags as sent by a peer (`origin.kind === "peer"`): a fork's copied history never is. */
	peerOnly?: boolean;
}): string | undefined {
	const projects = join(input.configDir, "projects");
	const matches = readdirSync(projects, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(projects, entry.name, `${input.sessionId}.jsonl`))
		.filter((candidate) => existsSync(candidate));
	if (matches.length !== 1) return undefined;
	const fd = openSync(matches[0] as string, "r");
	let text: string;
	let cut = false;
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - PEER_TAIL_BYTES);
		cut = start > 0;
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		text = buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
	const lines = text.split("\n");
	if (cut) lines.shift(); // a cut first line is not a line
	let found: string | undefined;
	for (const line of lines) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || parsed.type !== "user" || parsed.isSidechain === true) continue;
		if (input.peerOnly && !(isRecord(parsed.origin) && parsed.origin.kind === "peer")) continue;
		const lineText = userLineText(isRecord(parsed.message) ? parsed.message.content : null);
		if (lineText === null || lineText.trim() === "") continue;
		if (input.sentTexts.includes(lineText)) continue;
		found = lineText;
	}
	return found === undefined ? undefined : found.slice(0, PEER_TURN_TEXT_CAP);
}

async function statOrNull(path: string): Promise<{ size: number; mtimeMs: number } | null> {
	try {
		const info = await stat(path);
		return { size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}

// ---- starting a fork ----

/**
 * Starts the long-lived process for a fork (or an in-place resume) and runs the checks that need no user
 * line. On success the runtime is `starting` and registered; the caller reports the takeover, calling
 * `beginSettle()` just before and `settled()` after the server commits. On any refusal the child is dead,
 * nothing was written to any conversation, and the slot is free.
 */
export async function startClaudeStream(
	options: ClaudeStreamOptions,
): Promise<ClaudeStreamRuntime> {
	const release =
		options.reservedSlot ??
		reserveSlot(options.sessionId, options.maxRuntimes ?? MAX_CLAUDE_STREAM_RUNTIMES);
	let runtime: ClaudeStreamRuntime | undefined;
	let proc: ClaudeProcess | undefined;
	try {
		const sourceBefore = options.sourceFile ? await statOrNull(options.sourceFile) : null;
		const startLog = options.log ?? ((line: string) => console.warn(line));
		proc = await spawnClaude({
			executable: options.executable,
			args: options.args,
			cwd: options.cwd,
			env: forkChildEnv(options.env),
			link: {
				...options.link,
				// A control request of a subtype the link doesn't carry is answered with an error, and logged by name.
				onUnsupportedRequest: (subtype) =>
					startLog(
						`[claude-stream] declined a control request of an unsupported subtype (session=${options.sessionId}, subtype=${forHostLog(subtype)})`,
					),
			},
			timings: options.timings ?? FORK_STOP_TIMINGS,
		});
		runtime = new ClaudeStreamRuntime(options, proc, release);
		runtime.noteSourceBefore(sourceBefore);

		let account: unknown;
		try {
			const answer = await proc.link.initialize();
			account = isRecord(answer) ? answer.account : undefined;
		} catch {
			throw new ClaudeStartRefusal("rejected", "initialize");
		}
		const log = options.log ?? ((line: string) => console.warn(line));
		log(`[claude-stream] the fork's login: ${describeLoginForLog(account)} (mode=${options.mode})`);
		if (!accountAgreesWithMode(account, options.mode)) {
			throw new ClaudeStartRefusal("claude_not_logged_in");
		}
		await verifyOwnId(runtime, options);
		if (options.sourceFile) {
			const after = await statOrNull(options.sourceFile);
			if (
				(sourceBefore === null) !== (after === null) ||
				(sourceBefore &&
					after &&
					(sourceBefore.size !== after.size || sourceBefore.mtimeMs !== after.mtimeMs))
			) {
				throw new ClaudeStartRefusal("source_changed");
			}
		}
		runtimes.set(options.sessionId, runtime);
		return runtime;
	} catch (error) {
		let gone = true;
		if (runtime) {
			gone = (await runtime.dispose({ interruptMs: 0, stdinCloseMs: 1_000 })).gone;
			// Not confirmed ended (CX2-1): held under its id, with its slot, so nothing starts beside it.
			if (!gone) runtimes.set(options.sessionId, runtime);
		} else if (proc) {
			gone = (
				await proc
					.stop({ timings: { interruptMs: 0, stdinCloseMs: 1_000 } })
					.catch(() => ({ gone: false }))
			).gone;
		}
		if (gone) release();
		// A runtime cleans up when it finishes; one that never existed (a failed spawn) has nobody to do it.
		if (runtime) {
			if (gone) runtime.runCleanup();
		} else {
			void Promise.resolve()
				.then(() => options.cleanup?.())
				.catch(() => {});
		}
		if (error instanceof ClaudeStartRefusal) throw error;
		throw new ClaudeStartRefusal("rejected", "start");
	}
}

/**
 * The fork's own `agents --json` entry (matched by the pid of the child we started) must show the new id
 * and not the source's, within a few seconds. Fail closed: "can't tell" never proceeds.
 */
async function verifyOwnId(
	runtime: ClaudeStreamRuntime,
	options: ClaudeStreamOptions,
): Promise<void> {
	const list = options.listAgents ?? listClaudeAgentEntries;
	const env = forkChildEnv(options.env);
	const deadline = Date.now() + (options.ownIdWaitMs ?? OWN_ID_WAIT_MS);
	let lastWhy: string | null = null;
	while (true) {
		const listing = await list({
			executable: options.executable,
			cwd: options.agentsCwd ?? options.cwd,
			env,
		});
		if (!listing.ok) {
			lastWhy = listing.why;
		} else {
			const own = listing.entries.find((entry) => entry.pid === runtime.pid);
			if (own) {
				if (options.source && own.sessionId === options.source) {
					throw new ClaudeStartRefusal("rejected", "the fork shows the source's id");
				}
				if (own.sessionId !== options.sessionId) throw new ClaudeStartRefusal("rejected", "own id");
				return;
			}
			lastWhy = "no entry for the child";
		}
		if (Date.now() >= deadline) {
			throw new ClaudeStartRefusal(
				lastWhy?.startsWith("no entry") ? "rejected" : "liveness_unknown",
				lastWhy ?? "",
			);
		}
		await Bun.sleep(OWN_ID_POLL_MS);
	}
}

// ---- the control-action surface ----

/** A prompt for a fork this host holds no process for: one `degraded` report so the server offers Resume, then a refusal. */
async function reportNoRuntime(sessionId: string, callbacks: LaunchCallbacks): Promise<void> {
	try {
		await callbacks.reportState({
			sessionId,
			agentType: "claude_code",
			managedState: "degraded",
			status: "idle",
			providerSyncState: "failed",
			providerSyncError: CLAUDE_FORK_EXITED_SYNC_ERROR,
		});
	} catch (error) {
		console.error(
			`[claude-stream] couldn't report a fork with no runtime (session=${sessionId}): ${forHostLog(error)}`,
		);
	}
}

export async function promptClaudeStreamSession(
	action: { sessionId: string; prompt: string; actionId: string },
	callbacks: LaunchCallbacks,
): Promise<SendPromptResult> {
	const runtime = runtimes.get(action.sessionId);
	if (!runtime) {
		await reportNoRuntime(action.sessionId, callbacks);
		throw new ClaudePromptRefusal("no_runtime", CLAUDE_FORK_NO_RUNTIME_ERROR);
	}
	// The server only claims a prompt for a session whose rows exist, so one arriving for a runtime still
	// `settling` is proof the takeover settled even though its answer never got here (AGEN-117 T5).
	runtime.settled();
	return await runtime.sendPrompt(action.prompt, action.actionId);
}

/** Stops the fork for a session: `hadChild` is whether this host held one. */
export async function stopClaudeStreamSession(
	sessionId: string,
	timings?: Partial<ClaudeStopTimings>,
): Promise<{ hadChild: boolean; gone: boolean; unchecked: boolean }> {
	const runtime = runtimes.get(sessionId);
	if (!runtime) return { hadChild: false, gone: true, unchecked: false };
	runtime.settled(); // a Stop claimed for N is proof of settle, as a prompt is
	const result = await runtime.stop(timings);
	return { hadChild: true, gone: result.gone, unchecked: !result.checked };
}

/** A person's Stop turn for the fork of a session (AGEN-119): no fork held here is `not_interrupted`. */
export async function interruptClaudeStreamSession(
	sessionId: string,
	targetActionId: string,
): Promise<InterruptResult> {
	const runtime = runtimes.get(sessionId);
	if (!runtime) return { status: "not_interrupted" };
	return runtime.interruptTurn(targetActionId);
}
