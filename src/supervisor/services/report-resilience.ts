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

	constructor(status: number, statusText: string, error?: string) {
		super(`Supervisor request failed: ${status} ${statusText}`);
		this.name = "SupervisorRequestError";
		this.status = status;
		this.statusText = statusText;
		this.error = error;
	}
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
