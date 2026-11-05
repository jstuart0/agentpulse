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

/** The last directory of a POSIX or Windows path, or null when there isn't one. */
function lastDirectory(cwd: string | null | undefined): string | null {
	const segments = (cwd ?? "").split(/[\\/]/).filter((segment) => segment !== "");
	return segments.at(-1) ?? null;
}

export function turnStoppedNotification(session: StoppedSession): BrowserNotification {
	const name = session.displayName || session.sessionId.slice(0, SHORT_ID_CHARS);
	const directory = lastDirectory(session.cwd);
	return directory
		? { title: `${name} stopped`, body: `In ${directory}` }
		: { title: `${name} stopped` };
}
