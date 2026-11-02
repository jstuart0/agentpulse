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
/** The shortest wait a Retry-After produces: `Retry-After: 0` must not become a loop with no pause. */
export const MIN_RETRY_AFTER_MS = 1_000;

/**
 * A `Retry-After` header value (delta-seconds or an HTTP date) as milliseconds from `nowMs`, or
 * undefined when it is missing, unusable or negative. At least a second (a server saying "0" still
 * gets a pause) and capped at an hour, so a hostile or broken server can neither make the supervisor
 * spin nor park a session's queue for longer.
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
	return Math.min(Math.max(ms, MIN_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
}

/**
 * How a failed report should be treated (plan D8):
 *  - `network`: the server is unreachable. Global: stop sending, keep what is queued.
 *  - `server`: a transient server answer (408, 425, 429, 5xx). This session backs off and the failure counts.
 *  - `backoff`: the server's own back-pressure: a 503 whose body error is `busy` and that carries
 *    Retry-After, exactly what the replay cap sends. This session waits as told; it is not a failure and
 *    must never count toward the poison rule. Any other 503 is `server`.
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
	if (status === 503 && error.error === "busy" && error.retryAfterMs !== undefined)
		return "backoff";
	if (status === 408 || status === 425 || status === 429 || status >= 500) return "server";
	return "stop";
}

/**
 * Whether a credential rejection from `serverUrl` may ever end the supervisor. Over HTTPS the answer is
 * the server's. Over plain HTTP it is only believed when the server is on this machine: on any other
 * network path a device in the middle could forge a "credential rejected" and so kill the host.
 */
export function credentialRejectionMayConfirm(serverUrl: string | undefined | null): boolean {
	if (!serverUrl) return false;
	let url: URL;
	try {
		url = new URL(serverUrl);
	} catch {
		return false;
	}
	if (url.protocol === "https:") return true;
	if (url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]" || host === "::1") return true;
	return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** The most one queue head may wait on a server's back-pressure before each further wait counts as a failure. */
export const BACKOFF_BUDGET_MS = 6 * 60 * 60 * 1000;
const SESSION_BACKOFF_BASE_MS = 3_000;
const SESSION_BACKOFF_MAX_MS = 60_000;

/**
 * How long a session waits before its next send after the k-th consecutive failure (k from 0): 3 s doubling
 * to 60 s, jittered by up to 20% either way; a server's Retry-After wins when it asks for longer.
 */
export function sessionBackoffMs(
	k: number,
	retryAfterMs: number | undefined,
	random: () => number,
): number {
	const base = Math.min(SESSION_BACKOFF_MAX_MS, SESSION_BACKOFF_BASE_MS * 2 ** Math.min(k, 10));
	const jittered = Math.round(base * (0.8 + random() * 0.4));
	return Math.max(retryAfterMs ?? 0, jittered);
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
	/**
	 * False when a rejection must never be acted on (see credentialRejectionMayConfirm): the tripwire then
	 * never confirms, and says so once through `log`.
	 */
	canConfirm?: boolean;
	log?: (line: string) => void;
}): CredentialTripwire {
	const minGapMs = opts.minGapMs ?? 10_000;
	let firstAt: number | null = null;
	let warned = false;
	return {
		record() {
			if (opts.canConfirm === false) {
				if (!warned) {
					warned = true;
					opts.log?.(
						"[supervisor] the server rejected this supervisor's credential, but the connection is plain HTTP to a non-local address, where anything on the path could forge that answer; not acting on it",
					);
				}
				return "first";
			}
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

/**
 * True when the server said, in one of its exact wordings, that this supervisor's credential is not
 * accepted. A bare 401 is not enough: a proxy or gateway in the path can answer 401 for its own reasons.
 */
export function isCredentialRejected(error: unknown): boolean {
	return classifyReportFailure(error) === "credential";
}

/**
 * Errors the report gate has already counted toward the credential tripwire. reportInSessionSafely
 * does not count them again.
 */
const credentialHandled = new WeakSet<object>();
export function markCredentialHandled(error: unknown): void {
	if (typeof error === "object" && error !== null) credentialHandled.add(error);
}
export function wasCredentialHandled(error: unknown): boolean {
	return typeof error === "object" && error !== null && credentialHandled.has(error);
}

let sharedTripwire: CredentialTripwire | null = null;
/** The one tripwire the supervisor's heartbeat, report gate, bridge drain and in-session reporting all feed. */
export function setSharedCredentialTripwire(tripwire: CredentialTripwire | null): void {
	sharedTripwire = tripwire;
}
function sharedCredentialTripwire(): CredentialTripwire {
	sharedTripwire ??= createCredentialTripwire({ now: Date.now });
	return sharedTripwire;
}

/**
 * Run an in-session report call (reportState/reportEvents). On success,
 * resolves normally. When the server rejects the supervisor's credential
 * (one of its exact wordings; a bare 401 from a proxy doesn't count), the
 * rejection goes through the shared tripwire: only a second one at least
 * 10 s after the first makes this await `onFatal` (callers pass
 * disposeRuntimesAndExit, which kills every child runtime first and is
 * awaited so the exit never races ahead of that cleanup). A rejection the report gate already counted is only logged
 * here, so one response is never counted twice. On any other failure (403
 * session_not_owned, 5xx, network error), logs a session-scoped line and
 * returns normally so the caller's stream/notification loop keeps running.
 */
export async function reportInSessionSafely(
	scope: string,
	sessionId: string,
	op: string,
	fn: () => Promise<unknown>,
	onFatal: () => void | Promise<void>,
): Promise<void> {
	try {
		await fn();
	} catch (error) {
		if (isCredentialRejected(error)) {
			if (wasCredentialHandled(error) || sharedCredentialTripwire().record() === "first") {
				console.error(
					`[${scope}] credential rejected; waiting for a second rejection before exiting (session=${sessionId}, op=${op})`,
				);
				return;
			}
			console.error(
				`[${scope}] credential rejected twice: supervisor credential revoked or rotated; exiting (session=${sessionId}, op=${op})`,
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
