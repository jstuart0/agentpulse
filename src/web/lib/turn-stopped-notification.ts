/**
 * The browser notification for a session that stopped working. The flag it watches (`isWorking`
 * going false) flips for a finished turn and a failed one alike, so the words claim only that the
 * session stopped. The agent's own `currentTask` is not used: it is whatever the agent last said.
 */
export interface StoppedSession {
	sessionId: string;
	displayName?: string | null;
	cwd?: string | null;
}

export interface BrowserNotification {
	title: string;
	body?: string;
}

const SHORT_ID_CHARS = 8;
const MAX_PART_CHARS = 80;

/** Control and format characters (bidi overrides, zero-width) stripped, then cut: both come from the sender. */
function clean(text: string): string {
	const stripped = text.replace(/[\p{Cc}\p{Cf}]/gu, "");
	return stripped.length > MAX_PART_CHARS ? `${stripped.slice(0, MAX_PART_CHARS)}…` : stripped;
}

/** The last directory of a POSIX or Windows path, or null when there isn't one. */
function lastDirectory(cwd: string | null | undefined): string | null {
	const segments = (cwd ?? "").split(/[\\/]/).filter((segment) => segment !== "");
	const last = segments.at(-1);
	return last ? clean(last) || null : null;
}

export function turnStoppedNotification(session: StoppedSession): BrowserNotification {
	const name = clean(session.displayName ?? "") || session.sessionId.slice(0, SHORT_ID_CHARS);
	const directory = lastDirectory(session.cwd);
	return directory
		? { title: `${name} stopped`, body: `In ${directory}` }
		: { title: `${name} stopped` };
}
