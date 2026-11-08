/**
 * Where a fork's finished turns and resulted calls are observed (AGEN-119..123 Track 0, S3; the body is
 * AGEN-123's). The stream runtime calls `onTurnFinished` exactly once per turn, from every way a turn can
 * end, and `onCallResulted` when a call's result arrives and its row has been queued.
 *
 * The observer sends what each call ran to the server for its owner to open, through the report gate and
 * nowhere else (F17, F20, F55):
 *  - only a call whose `detailVerdict` is `send`. That verdict was decided from the intact input when the call
 *    was recorded; nothing here looks at the input again to judge it;
 *  - only to a server that offers `fork_tool_detail`;
 *  - per call, after a 1 s debounce or 240 KiB, whichever comes first, in bodies split by serialised size
 *    under 240 KiB; the calls that never resulted (stopped, fatal, exit) go when the turn ends;
 *  - live only: a failed send is counted and dropped, never retried or kept, and never throws into the stream.
 * `detailInput`, `detailResult` and `detailPaths` are read only here and in the stream's assignment.
 */
import { type ForkCallOutcome, reportedForkTool } from "../../shared/claude-fork-copy.js";
import {
	FORK_TOOL_DETAIL,
	FORK_TOOL_DETAIL_LIMITS,
	type ForkToolCallReport,
	type ForkToolCallsReportBody,
} from "../../shared/fork-tool-calls.js";
import { callRowKind } from "./claude-turn-rows.js";
import {
	DETAIL_RESULT_CAP_BYTES,
	type ToolCallRecord,
	cutDetailResult,
} from "./fork-tool-record.js";

/** Every way a turn ends. `interrupted` is AGEN-119's: a `result` that an interrupt produced. */
export type TurnEnding =
	| "result"
	| "stopped"
	| "first_prompt_failed"
	| "fatal"
	| "exit"
	| "interrupted";

export type ObservedTurn = {
	actionId: string;
	ended: TurnEnding;
	/** The calls that were not already handed to `onCallResulted` (stopped, fatal or exited before a result). */
	calls: readonly ToolCallRecord[];
};

export interface ForkTurnObserver {
	onTurnFinished(turn: ObservedTurn): void;
	onCallResulted(call: ToolCallRecord): void;
}

/** What the observer needs from the host; all of it optional so a bare `forkTurnObserver(id)` observes nothing. */
export interface ForkTurnObserverDeps {
	/** The report gate's send. Absent: nothing is sent. */
	send?: (sessionId: string, body: ForkToolCallsReportBody) => Promise<unknown>;
	/** Whether the server offers a feature right now. Absent: it doesn't. */
	serverHas?: (feature: string) => boolean;
	/** Counts only: never a command, path or output. */
	log?: (line: string) => void;
	debounceMs?: number;
	batchBytes?: number;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** The record's input as text, up to the host cap; null when there is none or it can't be written. */
function inputText(
	call: ToolCallRecord,
): { text: string | null; truncated: boolean } | "unwritable" {
	if (call.detailInput === undefined) return { text: null, truncated: false };
	try {
		const cut = cutDetailResult(JSON.stringify(call.detailInput, null, 2) ?? null);
		return { text: cut.text, truncated: cut.bytes > DETAIL_RESULT_CAP_BYTES };
	} catch {
		return "unwritable";
	}
}

/** The report for one call, or null when the server could not store it (a tool name outside the fork's). */
export function toolCallReport(
	call: ToolCallRecord,
	ended: TurnEnding | null,
): ForkToolCallReport | null {
	const tool = reportedForkTool(call.name);
	if (tool === null) return null;
	const input = inputText(call);
	if (input === "unwritable") return null;
	// A call cut short by a person's Stop turn is `stopped`; one that never resulted otherwise reads as callRowKind says.
	const outcome: ForkCallOutcome =
		ended === "interrupted" && !call.resulted ? "stopped" : callRowKind(call);
	return {
		toolUseId: call.toolUseId,
		turnActionId: call.turnActionId,
		tool,
		outcome,
		fromSubagent: call.agentId !== null,
		input: input.text,
		inputTruncated: input.truncated,
		output: call.detailResult,
		outputTruncated: call.detailResultBytes > DETAIL_RESULT_CAP_BYTES,
	};
}

/** The reports split into bodies whose serialised size is under `limit`; a call too big for any body is counted as dropped. */
export function splitIntoBodies(
	reports: readonly ForkToolCallReport[],
	limit: number,
): { bodies: ForkToolCallReport[][]; dropped: number } {
	const envelope = byteLength(JSON.stringify({ v: 1, calls: [] }));
	const bodies: ForkToolCallReport[][] = [];
	let current: ForkToolCallReport[] = [];
	let size = envelope;
	let dropped = 0;
	for (const report of reports) {
		const own = byteLength(JSON.stringify(report)) + 1;
		if (envelope + own > limit) {
			dropped++;
			continue;
		}
		if (
			current.length > 0 &&
			(size + own > limit || current.length >= FORK_TOOL_DETAIL_LIMITS.callsPerReport)
		) {
			bodies.push(current);
			current = [];
			size = envelope;
		}
		current.push(report);
		size += own;
	}
	if (current.length > 0) bodies.push(current);
	return { bodies, dropped };
}

/** The observer for a session. A no-op until given somewhere to send. */
export function forkTurnObserver(
	sessionId: string,
	deps: ForkTurnObserverDeps = {},
): ForkTurnObserver {
	if (!deps.send || !deps.serverHas) return { onTurnFinished() {}, onCallResulted() {} };
	const sendBody = deps.send;
	const serverHas = deps.serverHas;
	const log = deps.log ?? (() => {});
	const debounceMs = deps.debounceMs ?? FORK_TOOL_DETAIL_LIMITS.debounceMs;
	const batchBytes = deps.batchBytes ?? FORK_TOOL_DETAIL_LIMITS.batchBytes;
	let queue: ForkToolCallReport[] = [];
	let queuedBytes = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let sending: Promise<void> = Promise.resolve();

	function flush(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (queue.length === 0) return;
		const taken = queue;
		queue = [];
		queuedBytes = 0;
		// One send at a time, in order; a failure is counted and the next body still goes.
		sending = sending.then(async () => {
			const { bodies, dropped } = splitIntoBodies(taken, batchBytes);
			let failed = dropped;
			for (const calls of bodies) {
				try {
					await sendBody(sessionId, { v: 1, calls });
				} catch {
					failed += calls.length;
				}
			}
			if (failed > 0) log(`[fork-detail] ${failed} tool call(s) of ${sessionId} were not sent`);
		});
	}

	function enqueue(report: ForkToolCallReport): void {
		queue.push(report);
		queuedBytes += byteLength(JSON.stringify(report)) + 1;
		if (queuedBytes >= batchBytes) {
			flush();
			return;
		}
		if (!timer) {
			timer = setTimeout(flush, debounceMs);
			timer.unref?.();
		}
	}

	const offered = () => serverHas(FORK_TOOL_DETAIL);

	return {
		onCallResulted(call) {
			if (call.detailVerdict !== "send" || !offered()) return;
			const report = toolCallReport(call, null);
			if (report) enqueue(report);
		},
		onTurnFinished(turn) {
			if (offered()) {
				for (const call of turn.calls) {
					if (call.detailVerdict !== "send") continue;
					const report = toolCallReport(call, turn.ended);
					if (report) enqueue(report);
				}
			}
			flush();
		},
	};
}
