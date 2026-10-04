/**
 * AGEN-69 phase 4: limits for the prompt, the answer and what the server
 * stores. Kept apart from `limits.ts` (the evidence path's limits).
 */

/** The model call, primary and repair alike. */
export const SUMMARY_CALL_OPTIONS = {
	maxTokens: 4000,
	temperature: 0.2,
	timeoutMs: 120_000,
	disableReasoning: true,
} as const;

/** Agent-supplied identity fields in the user prompt (code points). */
export const DETAIL_FIELD_CAP = 200;
/** Agent-supplied free text in the user prompt: current task, plan summary, notes. */
export const DETAIL_TEXT_CAP = 1000;

/** Answer limits, applied before validation (code points; items per section). */
export const MAX_SECTION_ITEMS = 20;
export const MAX_NEXT_ACTIONS = 5;
export const OVERVIEW_MAX_CHARS = 1200;
export const ITEM_MAX_CHARS = 600;
export const HANDOFF_MAX_CHARS = 4000;
/** Evidence ids kept per item. */
export const MAX_EVIDENCE_PER_ITEM = 12;

/** A repair trailer's wording is fixed text; nothing from the answer is ever put in it. */
export const TRUNCATION_TRAILER =
	"Your answer was cut off. Answer again more briefly: at most 8 items per section.";
