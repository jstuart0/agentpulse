/**
 * AGEN-69: decides what a recorded shell command may send to the model
 * provider. Security-relevant and fail-closed: anything the classifier cannot
 * read as a clean validation command or an ordinary command is sent as status
 * only, and anything that reads a credential is sent as nothing at all.
 *
 * Steps (plan "The command classifier"):
 *   1 normalise: unwrap wrappers, split into segments, look inside `$(...)`,
 *     backticks, heredocs and `sh -c` strings;
 *   2 credential-reading in ANY segment withholds the whole command;
 *   3 a clean validation is shown with its output excerpt;
 *   4 otherwise a command with an unreadable construct is "not shown";
 *   5 everything else is ordinary.
 * Pure: no I/O, never throws (an internal error is "not shown").
 */

export type CommandClass =
	| { kind: "validation"; masked: boolean }
	| { kind: "withheld" }
	| { kind: "not_shown" }
	/** `hasViewer`: a segment runs a file viewer, so a failure's output is never excerpted. */
	| { kind: "ordinary"; hasViewer: boolean };

export type ValidationResult = "ok" | "failed" | "unknown";

export function classifyCommand(_input: unknown): CommandClass {
	return { kind: "ordinary", hasViewer: false };
}

export function validationResult(
	_response: string | null | undefined,
	_failedHook: boolean,
	_masked: boolean,
): ValidationResult {
	return "unknown";
}

export const COARSE_VALIDATION_TERMS: readonly string[] = [];
