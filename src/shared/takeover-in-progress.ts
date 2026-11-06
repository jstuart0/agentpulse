/**
 * What delete and archive say while a takeover of the session is open. Its own module, re-exported by
 * session-resume.ts, so the dashboard's shared error table can read it without pulling every sentence of the
 * take-over feature into the main bundle.
 */
/** What delete and archive say about a continued session that may still have a process (AGEN-117 T17). */
export const END_SESSION_FIRST_MESSAGE =
	"This session may still be running. End it first, then delete or archive it.";

export const TAKEOVER_IN_PROGRESS_MESSAGE =
	"This session is being taken over. Try again when that's finished.";
