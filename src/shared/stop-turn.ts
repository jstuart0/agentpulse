/**
 * Stop turn (AGEN-119): ends what a fork's Claude is doing and keeps the session. Reserved by Track 0 so the
 * server, the host, the web and the MCP package read one set of codes, limits and sentences.
 */

/** The supervisor feature that says a host can interrupt a fork's turn. Appended to its feature lists by AGEN-119. */
export const CLAUDE_TURN_INTERRUPT = "claude_turn_interrupt";

/** Refusals `POST /sessions/:id/interrupt` adds to the stop and prompt codes. */
export const STOP_TURN_REFUSAL_CODES = [
	"interrupt_not_supported",
	"no_turn_running",
	"rate_limited",
] as const;
export type StopTurnRefusalCode = (typeof STOP_TURN_REFUSAL_CODES)[number];

/** How long the host waits for the turn's `result` after sending the interrupt. */
export const CLAUDE_INTERRUPT_RESULT_WAIT_MS = 30_000;
/** A queued interrupt older than this is failed at claim, not handed over. */
export const INTERRUPT_CLAIM_TTL_MS = 60_000;
/** The `terminal_reason` values of a `result` that an interrupt produced (measured, 2.1.319). */
export const INTERRUPTED_TERMINAL_REASONS: readonly string[] = ["aborted_tools"];

/** F10: the words of the prompt action and the end event of a turn a person stopped. */
export const TURN_STOPPED_BY_PERSON = "Turn stopped by a person.";
/** F9: the interrupt's failure when the turn did not end in time. */
export const TURN_DIDNT_STOP =
	"Claude didn't stop within 30 seconds and is still working. Try again, or end the session.";
/** F38: a `result` that is an error but not an interrupt's. */
export const TURN_ERRORED_AFTER_STOP = "The turn ended with an error after you asked it to stop.";
/** F37: the prompt action's failure when the stop came before the prompt was sent. */
export const STOPPED_BEFORE_SEND =
	"Stopped before Claude got the prompt. Your text is back in the box.";
/** F54: an interrupt whose target had already ended. */
export const TURN_ALREADY_ENDED = "The turn had already ended.";
/** F54: an interrupt that End session overtook. */
export const SESSION_ENDED_FIRST = "The session was ended.";
/** F11: a queued interrupt nobody claimed in time. */
export const interruptExpiredMessage = (host: string): string =>
	`${host} didn't pick up the stop within a minute, so it was dropped. The turn may still be running.`;
