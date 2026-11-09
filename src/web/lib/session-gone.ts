import { apiErrorCode } from "./api-errors.js";
import { ApiError } from "./api.js";

/** The server's own body for a session it doesn't have. */
const SESSION_NOT_FOUND = "Session not found";

/**
 * True only for the server saying the session doesn't exist: a 404 whose body is its own
 * `{error:"Session not found"}`. A 403 comes from viewer gates (a forced password change) and a bare 404 can
 * come from a proxy; neither may close a tab.
 */
export function isSessionGone(err: unknown): boolean {
	return err instanceof ApiError && err.status === 404 && apiErrorCode(err) === SESSION_NOT_FOUND;
}

/**
 * Asks about each id, `concurrency` at a time, and returns the ones the server says are gone (in the order
 * given). Any other failure keeps the id.
 */
export async function checkSessions(
	ids: string[],
	check: (id: string) => Promise<unknown>,
	{ concurrency }: { concurrency: number },
): Promise<string[]> {
	const gone = new Set<string>();
	let next = 0;
	async function worker() {
		while (next < ids.length) {
			const id = ids[next++] as string;
			try {
				await check(id);
			} catch (err) {
				if (isSessionGone(err)) gone.add(id);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
	return ids.filter((id) => gone.has(id));
}
