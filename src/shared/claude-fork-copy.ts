/**
 * The words about a continued Claude Code session (AGEN-117) that the server writes into a row and the
 * dashboard shows on the page, so both read one source. Small on purpose: the dashboard's main bundle may
 * not pull in `session-resume.ts`, and a screen that shows a fork needs these sentences.
 *
 * `{Sname}` is a name (the observed session's display name, cleaned); the id of that session is a separate
 * thing and is never worded here. A mode is `restricted` (the person's own Claude settings are not used) or
 * `ask` (they still apply), picked by the host per fork from the login Claude Code reported.
 */
import { cleanHostText } from "./clean-host-text.js";

export type ForkMode = "ask" | "restricted";

/**
 * The logins the host starts a fork under `restricted` for. It mirrors `KNOWN_RESTRICTED_LOGINS`
 * (`supervisor/providers/claude-login-mode.ts`, which the web may not import): `claude-login-mode.test.ts` fails
 * when the two disagree, so adding the token entry there forces this list, and every sentence below, to change
 * with it (V-5: copy follows the table).
 */
export const RESTRICTED_LOGIN_KINDS: readonly ("api_key" | "token")[] = ["api_key"];

/** "an API key", or "a subscription token or an API key" once the token entry ships. */
export function restrictedLoginPhrase(
	kinds: readonly ("api_key" | "token")[] = RESTRICTED_LOGIN_KINDS,
): string {
	return kinds.includes("token") ? "a subscription token or an API key" : "an API key";
}

/** What `ask` covers: every login the table has no entry for, a token among them until it has one. */
export function askLoginPhrase(
	kinds: readonly ("api_key" | "token")[] = RESTRICTED_LOGIN_KINDS,
): string {
	return kinds.includes("token")
		? "any other login"
		: "a subscription token, an apiKeyHelper or any other login";
}

/** What to give the supervisor to have a fork's settings ignored. */
export function restrictedLoginAdvice(
	kinds: readonly ("api_key" | "token")[] = RESTRICTED_LOGIN_KINDS,
): string {
	return kinds.includes("token")
		? "a subscription token from `claude setup-token` or an API key"
		: "an API key";
}

/** Used where a name is unknown: the lookup hasn't answered, or the host sent none. */
export const ORIGINAL_SESSION_FALLBACK = "the original session";
const THIS_MACHINE = "this machine";
const NAME_MAX_CHARS = 80;

/** A name for a sentence: cleaned and short, or the fallback. Never trusted as markup, never printed raw. */
export function forkSentenceName(name: string | null | undefined, fallback: string): string {
	// Backticks turn into apostrophes: a name is never allowed to open or close a code span in the sentence
	// around it, whatever draws that sentence.
	return cleanHostText(name, NAME_MAX_CHARS)?.replaceAll("`", "'") ?? fallback;
}

/**
 * What applies in a fork, by the mode it started under. It names the allow rules and the hooks plainly for
 * `ask`, because those are what answer before a person does there, and it never calls anything "enforced".
 */
export function forkModeLine(
	mode: ForkMode,
	machine: string | null | undefined,
	sourceName: string | null | undefined,
	sourceGone = false,
): string {
	const where = forkSentenceName(machine, THIS_MACHINE);
	if (mode === "restricted") {
		return `Your Claude settings on ${where} aren't used in this session, because the supervisor's Claude Code logs in with ${restrictedLoginPhrase()}. That includes your own CLAUDE.md and your hooks.`;
	}
	const again = sourceGone
		? "start a new session"
		: `continue ${forkSentenceName(sourceName, ORIGINAL_SESSION_FALLBACK)} again`;
	return `Your Claude settings on ${where} still apply in this session, because the supervisor's Claude Code logs in a way that needs them. Commands your settings allow, and anything a hook there answers, run without asking you. To have them ignored instead, give the supervisor ${restrictedLoginAdvice()}, then end this session and ${again}.`;
}

/** The first sentence of a fork's first row: what this session is. */
export const FORK_FIRST_ROW_LEAD =
	"Continued from an earlier session. Claude remembers that conversation, but its history stays there. Send a prompt to carry on.";

/** N's first timeline row: the lead, then which settings apply, so the person knows before sending anything. */
export function forkFirstRowContent(
	mode: ForkMode,
	machine: string | null | undefined,
	sourceName: string | null | undefined,
): string {
	return `${FORK_FIRST_ROW_LEAD} ${forkModeLine(mode, machine, sourceName)}`;
}

/** The start of the per-turn row for calls that ran with no card (T18). The web matches on it to show the row in Conversation. */
export const TURN_UNASKED_PREFIX = "Ran without asking you this turn:";
/** The start of the per-turn row for calls the harness refused on its own account. */
export const TURN_REFUSED_PREFIX = "Claude tried this and was refused:";

/** Whether a `HeadlessStatus` row's text is one of the two per-turn summaries. */
export function isForkTurnSummary(content: string | null | undefined): boolean {
	return (
		typeof content === "string" &&
		(content.startsWith(TURN_UNASKED_PREFIX) || content.startsWith(TURN_REFUSED_PREFIX))
	);
}
