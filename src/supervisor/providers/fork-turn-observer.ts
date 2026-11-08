/**
 * Where a fork's finished turns and resulted calls are observed (AGEN-119..123 Track 0, S3). The stream
 * runtime calls `onTurnFinished` exactly once per turn, from every way a turn can end, and `onCallResulted`
 * when a call's result arrives and its row has been queued. Track 0's observer does nothing; AGEN-123 owns the
 * body (it sends call detail, live only, through the report gate).
 */
import type { ToolCallRecord } from "./fork-tool-record.js";

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

export interface ForkTurnObserverDeps {
	/** AGEN-123 gives the observer the report gate here. */
	readonly reserved?: never;
}

/** The observer for a session. A no-op until AGEN-123. */
export function forkTurnObserver(
	_sessionId: string,
	_deps: ForkTurnObserverDeps = {},
): ForkTurnObserver {
	return { onTurnFinished() {}, onCallResulted() {} };
}
