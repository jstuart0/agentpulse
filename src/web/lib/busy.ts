import { ApiError } from "./api.js";
import { BUSY_CODE } from "./network-retry.js";

/** How many busy answers in a row are waited out silently before the failure is shown. */
export const BUSY_BANNER_AFTER = 3;
const BUSY_DEFAULT_WAIT_MS = 3_000;
const BUSY_MIN_WAIT_MS = 1_000;
const BUSY_MAX_WAIT_MS = 60_000;

/**
 * How long to wait before asking again when the server answered "busy" (503
 * with the busy code and, usually, a Retry-After); null for any other failure.
 * A busy server is shedding load, not down: keep what is on screen and ask
 * again after the time it stated.
 */
export function busyWaitMs(err: unknown): number | null {
	if (!(err instanceof ApiError) || err.status !== 503 || err.code !== BUSY_CODE) return null;
	const stated =
		err.retryAfterSeconds === null ? BUSY_DEFAULT_WAIT_MS : err.retryAfterSeconds * 1000;
	return Math.min(Math.max(stated, BUSY_MIN_WAIT_MS), BUSY_MAX_WAIT_MS);
}
