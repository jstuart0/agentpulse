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
/** The too-little-activity probe looks for an action in this many newest events (a prompt counts anywhere). */
export const ACTIVITY_ACTION_WINDOW = 5000;
/** `releaseOwnSummaryClaims` returns after this long even if a write is still pending. */
export const SHUTDOWN_RELEASE_BUDGET_MS = 2000;

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
