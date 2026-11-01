/**
 * F25/D6/F31/D7 (2026-09-29-deliver-supervisor-auth-routing): shared
 * in-session-reporting resilience for the supervisor client.
 *
 * D6 made in-session reportState/reportEvents rejections (a 403
 * session_not_owned, or any 5xx) log-and-continue instead of crashing the
 * process. D7 narrows that: a 401 means the supervisor's credential itself
 * was rejected (revoked or rotated, typically during incident response) —
 * silently continuing would mask a condition every subsequent report call
 * will also hit, so 401 is fatal. 403 and 5xx stay log-and-continue.
 */

/**
 * Thrown by src/supervisor/index.ts's request() on any non-2xx response.
 * Carries the HTTP status so callers can distinguish a fatal credential
 * rejection (401) from an in-session ownership rejection (403) or a
 * transient server error (5xx). `error` (codex r2 F43) is the response
 * body's own `error` field when the body was JSON and had one — best
 * effort, undefined for a non-JSON or empty body — so callers can log the
 * server's actual reason (e.g. "insufficient_scope",
 * "session_not_owned") alongside the raw status.
 */
export class SupervisorRequestError extends Error {
	readonly status: number;
	readonly statusText: string;
	readonly error?: string;
	/** The server's `Retry-After`, in milliseconds (at most an hour), when it sent a usable one. */
	readonly retryAfterMs?: number;

	constructor(status: number, statusText: string, error?: string, retryAfterMs?: number) {
		super(`Supervisor request failed: ${status} ${statusText}`);
		this.name = "SupervisorRequestError";
		this.status = status;
		this.statusText = statusText;
		this.error = error;
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * The request never got an answer: the connection failed, was reset or timed out. Not an HTTP
 * response, so it carries no status; it says the server (or the path to it) is unreachable.
 */
export class SupervisorNetworkError extends Error {
	constructor(cause?: unknown) {
		super(
			`Supervisor request failed: network error${
				cause instanceof Error && cause.name ? ` (${cause.name})` : ""
			}`,
		);
		this.name = "SupervisorNetworkError";
		this.cause = cause;
	}
}

const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * A `Retry-After` header value (delta-seconds or an HTTP date) as milliseconds from `nowMs`, or
 * undefined when it is missing, unusable or negative. Capped at an hour so a hostile or broken server
 * can't park a session's queue for longer.
 */
export function parseRetryAfterMs(
	value: string | null | undefined,
	nowMs: number,
): number | undefined {
	if (!value) return undefined;
	const text = value.trim();
	let ms: number;
	if (/^\d+$/.test(text)) ms = Number(text) * 1000;
	else {
		const date = Date.parse(text);
		if (Number.isNaN(date)) return undefined;
		ms = date - nowMs;
	}
	if (!Number.isFinite(ms) || ms < 0) return undefined;
	return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * How a failed report should be treated (plan D8):
 *  - `network`: the server is unreachable. Global: stop sending, keep what is queued.
 *  - `server`: a transient server answer (408, 425, 429, 5xx). This session backs off and the failure counts.
 *  - `backoff`: the server's own back-pressure (a 503 carrying Retry-After, as the replay cap sends). This
 *    session waits as told; it is not a failure and must never count toward the poison rule.
 *  - `credential`: the supervisor's credential was rejected, in exactly the server's three wordings.
 *  - `session`: the session is not this supervisor's (403 session_not_owned). Drop its queue.
 *  - `entry`: this one report is malformed or forbidden (400 with a known code). Drop it.
 *  - `stop`: anything else the server refused (404, 413, other 4xx, any other 401/403). This session backs
 *    off like `server` and the failure counts.
 *  - `other`: not a delivery failure at all (an error raised outside the request, a SyntaxError after a 2xx).
 */
export type ReportFailureClass =
	| "network"
	| "server"
	| "backoff"
	| "credential"
	| "session"
	| "entry"
	| "stop"
	| "other";

const CREDENTIAL_401_ERRORS = new Set([
	"Missing supervisor credential",
	"Invalid supervisor credential",
]);
const CREDENTIAL_403_ERROR = "Supervisor credential does not match target supervisor";
const ENTRY_400_ERRORS = new Set(["reserved_event_type", "invalid_body", "sessionId is required"]);

export function classifyReportFailure(error: unknown): ReportFailureClass {
	if (error instanceof SupervisorNetworkError) return "network";
	if (!(error instanceof SupervisorRequestError)) return "other";
	const { status } = error;
	if (status === 401 && error.error !== undefined && CREDENTIAL_401_ERRORS.has(error.error)) {
		return "credential";
	}
	if (status === 403 && error.error === CREDENTIAL_403_ERROR) return "credential";
	if (status === 403 && error.error === "session_not_owned") return "session";
	if (status === 400 && error.error !== undefined && ENTRY_400_ERRORS.has(error.error)) {
		return "entry";
	}
	if (status === 503 && error.retryAfterMs !== undefined) return "backoff";
	if (status === 408 || status === 425 || status === 429 || status >= 500) return "server";
	return "stop";
}

/**
 * Tells a real credential rejection from a transient one (a proxy's stray 401). The first rejection
 * only records when it happened; a second at least `minGapMs` later confirms it. A success in between
 * (`reset`) forgets the first.
 */
export interface CredentialTripwire {
	record(): "first" | "confirmed";
	reset(): void;
}

export function createCredentialTripwire(opts: {
	now: () => number;
	minGapMs?: number;
}): CredentialTripwire {
	const minGapMs = opts.minGapMs ?? 10_000;
	let firstAt: number | null = null;
	return {
		record() {
			const at = opts.now();
			if (firstAt === null) {
				firstAt = at;
				return "first";
			}
			return at - firstAt >= minGapMs ? "confirmed" : "first";
		},
		reset() {
			firstAt = null;
		},
	};
}

/** True when the supervisor's credential was rejected outright (401). */
export function isCredentialRejected(error: unknown): boolean {
	return error instanceof SupervisorRequestError && error.status === 401;
}

/**
 * Run an in-session report call (reportState/reportEvents). On success,
 * resolves normally. On a 401 (credential rejected), logs a clear message
 * and awaits `onFatal` (default: process.exit(1)) — the same controlled
 * exit path a failed registration already takes. `onFatal` may be async
 * (e.g. D9's disposeAllHeadlessRuntimes/disposeAllManagedCodexRuntimes,
 * which must finish killing child processes before the process exits) —
 * it's awaited so process.exit(1) never races ahead of that cleanup. On
 * any other failure (403 session_not_owned, 5xx, network error), logs a
 * session-scoped line and returns normally so the caller's
 * stream/notification loop keeps running.
 */
export async function reportInSessionSafely(
	scope: string,
	sessionId: string,
	op: string,
	fn: () => Promise<unknown>,
	onFatal: () => void | Promise<void> = () => process.exit(1),
): Promise<void> {
	try {
		await fn();
	} catch (error) {
		if (isCredentialRejected(error)) {
			console.error(
				`[${scope}] credential rejected (401) — supervisor credential revoked or rotated; exiting (session=${sessionId}, op=${op})`,
			);
			await onFatal();
			return;
		}
		console.error(
			`[${scope}] in-session report failed (session=${sessionId}, op=${op}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
