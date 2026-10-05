/**
 * AGEN-69 phase 5: the limits of the summary service (plan D-19), in one file
 * beside `limits.ts` (the evidence path's) and `prompt-limits.ts` (the call's).
 */
import { estimateTokens } from "../llm/types.js";
import { LEDGER_CHAR_BUDGET, TOP_FILES } from "./limits.js";
import { SUMMARY_CALL_OPTIONS } from "./prompt-limits.js";
import { SESSION_SUMMARY_SYSTEM_PROMPT } from "./prompt.js";

/** A new attempt waits this long after the last one began (not after an interrupted one). */
export const SUMMARY_COOLDOWN_SECONDS = 30;
/** A `generating` row older than this reads as `failed / interrupted`: two 120 s calls plus the reads. */
export const SUMMARY_LEASE_SECONDS = 300;
/** Generations running at once in this process, counting one that is writing its result. */
export const MAX_CONCURRENT_GENERATIONS = 2;
/**
 * The too-little-activity probe (R-N) scans two bounded windows of the session's events: a prompt
 * in the oldest `ACTIVITY_PROMPT_OLDEST_WINDOW`, or a prompt or an action in the newest
 * `ACTIVITY_ACTION_WINDOW`. A session whose only prompt sits in the unscanned middle of a very
 * long history reads as "too little activity" until it has newer activity.
 */
export const ACTIVITY_ACTION_WINDOW = 5000;
export const ACTIVITY_PROMPT_OLDEST_WINDOW = 2000;
/** The stale probe scans at most this many events after a summary's last one; a full window makes the count a lower bound. */
export const STALE_SCAN_WINDOW = 500;
/** A caller refused a slot waits at most this long for a same-session request that holds one, then answers busy. */
export const JOIN_WAIT_BUDGET_MS = 5000;
/** Prompt text is scanned for typed URLs in slices of about this many characters, yielding the event loop between them. */
export const URL_SCAN_SLICE_CHARS = 32_768;
/** `releaseOwnSummaryClaims` returns after this long even if a write is still pending. */
export const SHUTDOWN_RELEASE_BUDGET_MS = 2000;

/** The breaker (Q-1): this many maximum-charged failures within the window, with no success since, close the door. */
export const BREAKER_FAILURES = 3;
export const BREAKER_WINDOW_MS = 10 * 60 * 1000;
/** ... until a call succeeds or this long after the last such failure. */
export const BREAKER_OPEN_MS = 5 * 60 * 1000;

export const BUSY_RETRY_AFTER_SECONDS = 5;
export const SCAN_BUSY_RETRY_AFTER_SECONDS = 1;
export const SHUTTING_DOWN_RETRY_AFTER_SECONDS = 5;

/**
 * An upper bound on the characters of one summary prompt: the system prompt,
 * the header with every agent-supplied field at its cap, the ledger at its
 * budget, the most-edited-files line, and 5% for redaction that rewrites text
 * to something longer. The reservation is priced from this, never from the
 * evidence, so the view and the reservation always agree (TC-5.4, TC-5.6).
 */
const HEADER_CHAR_BOUND = 6_000;
const FILES_LINE_CHAR_BOUND = TOP_FILES * 340;
const FENCE_CHAR_BOUND = 500;
export const MAX_PROMPT_CHARS =
	SESSION_SUMMARY_SYSTEM_PROMPT.length +
	HEADER_CHAR_BOUND +
	Math.ceil(LEDGER_CHAR_BUDGET * 1.05) +
	FILES_LINE_CHAR_BOUND +
	FENCE_CHAR_BOUND;

/** The most input tokens one summary call can carry, by the same estimate the adapters fall back on. */
export const MAX_INPUT_TOKENS = estimateTokens("x".repeat(MAX_PROMPT_CHARS));
/** The most output tokens one call can produce. */
export const MAX_OUTPUT_TOKENS = SUMMARY_CALL_OPTIONS.maxTokens;
