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

/**
 * Answer limits, applied before validation (code points; items per section). Chosen so a stored
 * summary (the answer plus a fact for every id it cites) is at most 64 KB by construction: at
 * these caps, with the most evidence facts they allow, the ready body measures about 61 KB
 * (`session-summary-view.test.ts`, TC-5.54). Raise one only with that test.
 */
export const MAX_SECTION_ITEMS = 10;
export const MAX_NEXT_ACTIONS = 5;
export const OVERVIEW_MAX_CHARS = 800;
/** An item's text, and a validation's `what`. */
export const ITEM_MAX_CHARS = 300;
/** An outcome's `explanation`, a decision's `why`, a validation's `detail`. */
export const ITEM_DETAIL_MAX_CHARS = 250;
export const HANDOFF_MAX_CHARS = 3000;
/** Evidence ids kept per item. */
export const MAX_EVIDENCE_PER_ITEM = 3;

/** A repair trailer's wording is fixed text; nothing from the answer is ever put in it. */
export const TRUNCATION_TRAILER =
	"Your answer was cut off. Answer again more briefly: at most 8 items per section.";
