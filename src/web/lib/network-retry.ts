/**
 * What to do when a request fails before any answer comes back. Pure: the
 * request wrapper and the reachability notice call these and carry out the
 * answer.
 *
 * A failed fetch is ambiguous in a browser: it is what an expired single
 * sign-on session looks like (the redirect is blocked), and it is also what an
 * unreachable server looks like. One reload per visit window covers the first;
 * anything after that is treated as an outage, which gets a visible notice and
 * a growing wait instead of another reload. With no way to remember the reload
 * (storage unavailable), the reload is never tried.
 */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
export const AUTH_BOUNCE_WINDOW_MS = 60_000;

/** Wait before retry number `attempt` (1-based): 1 s, 2 s, 4 s, then 30 s at most. */
export function retryDelayMs(attempt: number): number {
	if (!Number.isFinite(attempt) || attempt < 1) return RETRY_BASE_MS;
	const exponent = Math.min(Math.floor(attempt) - 1, 30);
	return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
}

/** Whether a reload to pick up a fresh sign-in is still worth trying. */
export function shouldBounceForAuth(lastBounceAt: number | null, now: number): boolean {
	if (lastBounceAt === null) return true;
	return now - lastBounceAt >= AUTH_BOUNCE_WINDOW_MS;
}

export const AUTH_BOUNCE_STORAGE_KEY = "agentpulse.authBounceAt";

/** When the last auth reload happened, null when none is recorded, "unavailable" when storage can't say. */
export type LastBounce = number | null | "unavailable";

export function readLastBounce(storage: Pick<Storage, "getItem">): LastBounce {
	try {
		const raw = storage.getItem(AUTH_BOUNCE_STORAGE_KEY);
		const value = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(value) ? value : null;
	} catch {
		return "unavailable";
	}
}

/**
 * Whether the time was stored. When it can't be, a reload would be followed by
 * another one with nothing to say it already happened, so the caller must not
 * reload.
 */
export function recordBounce(storage: Pick<Storage, "setItem">, now: number): boolean {
	try {
		storage.setItem(AUTH_BOUNCE_STORAGE_KEY, String(now));
		return true;
	} catch {
		return false;
	}
}

export type FetchFailureDecision = { action: "reload" } | { action: "retry" };

/** What to do about a request that got no answer. A retry waits as long as the visible notice's probes say (retryDelayMs of the probes so far), not as long as the number of requests that failed. */
export function decideFetchFailure(input: {
	lastBounceAt: LastBounce;
	now: number;
}): FetchFailureDecision {
	if (input.lastBounceAt === "unavailable") return { action: "retry" };
	return shouldBounceForAuth(input.lastBounceAt, input.now)
		? { action: "reload" }
		: { action: "retry" };
}

/** A wait longer than this is not believed: the generic message is used instead of "wait about 400 minutes". */
export const RETRY_AFTER_MAX_SECONDS = 3_600;

/** "Sun Nov  6 08:49:37 1994": the HTTP date form with no zone, which is UTC by definition. */
const ASCTIME_DATE = /^[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * The wait a Retry-After header asks for, in whole seconds: a number of
 * seconds, or an HTTP date (all three forms; the zoneless asctime form is read
 * as UTC, whatever the browser's zone). Null when absent, unusable, not finite
 * or longer than an hour.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
	const text = header?.trim();
	if (!text) return null;
	let seconds: number;
	if (/^\d+$/.test(text)) {
		seconds = Number(text);
	} else {
		if (/^[-+.\d]+$/.test(text)) return null;
		const at = Date.parse(ASCTIME_DATE.test(text) ? `${text} UTC` : text);
		if (Number.isNaN(at)) return null;
		seconds = Math.ceil((at - nowMs) / 1000);
	}
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > RETRY_AFTER_MAX_SECONDS) return null;
	return seconds;
}

export const IDENTITY_PATH = "/auth/me";
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
/** The code a server that is shedding load answers with: "try again shortly", not an outage. */
export const BUSY_CODE = "busy";
/** The code a server that is draining answers with: it is restarting on purpose, not down. */
export const SHUTTING_DOWN_CODE = "shutting_down";

/**
 * Whether an answered request still says the server is not serving: a gateway
 * error (what a proxy answers while the app is down) other than a deliberate
 * "busy" or "shutting_down", or, for the identity check that the whole app waits on, any 5xx or a
 * 429. Everything else is an answer and counts as the server being reachable.
 */
export function isOutageResponse(status: number, code: string | null, path: string): boolean {
	if (path === IDENTITY_PATH) return status >= 500 || status === 429;
	return GATEWAY_STATUSES.has(status) && code !== BUSY_CODE && code !== SHUTTING_DOWN_CODE;
}
