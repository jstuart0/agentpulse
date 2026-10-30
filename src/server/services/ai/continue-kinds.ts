/**
 * The kinds of next step a Continue decision can name. A leaf module, so the
 * decision parser can know them without pulling in the send path.
 */

/** The kinds of next step the watcher can name. `proceed` is a suggestion for a person only. */
export const CONTINUE_KINDS = [
	"proceed",
	"retry_failed_step",
	"run_tests",
	"summarize_status",
] as const;
export type ContinueKind = (typeof CONTINUE_KINDS)[number];

/** The kinds the auto policy may send. `proceed` is not one: an unattended "keep going" approves whatever the agent was about to do. */
export const AUTO_CONTINUE_KINDS = ["retry_failed_step", "run_tests", "summarize_status"] as const;
export type AutoContinueKind = (typeof AUTO_CONTINUE_KINDS)[number];

/** A model's `continueKind`, or null when it names none of them. An unknown value is dropped, not an error. */
export function parseContinueKind(value: unknown): ContinueKind | null {
	return typeof value === "string" && (CONTINUE_KINDS as readonly string[]).includes(value)
		? (value as ContinueKind)
		: null;
}
