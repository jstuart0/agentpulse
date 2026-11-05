/**
 * What delete and archive say while a takeover of the session is open. Its own module, re-exported by
 * session-resume.ts, so the dashboard's shared error table can read it without pulling every sentence of the
 * take-over feature into the main bundle.
 */
export const TAKEOVER_IN_PROGRESS_MESSAGE =
	"This session is being taken over. Try again when that's finished.";
