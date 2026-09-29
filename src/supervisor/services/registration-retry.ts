/**
 * codex r2 F43 (2026-09-29-deliver-supervisor-auth-routing, D10): initial
 * registration must never crash-loop. `main()` in src/supervisor/index.ts
 * used to await /supervisors/register outside any retry path — a new
 * supervisor pointed at a not-yet-upgraded server (the old in-bundle-mount
 * shadow, or any other HTTP failure) threw, main().catch() logged and
 * exited, and launchd/systemd respawned it into the same failure. That
 * crash loop is exactly what AGEN-17 fixes on the routing side; this
 * closes the client-side mirror of it.
 *
 * Registration now retries forever on any SupervisorRequestError (HTTP
 * failure from the server) with exponential backoff and jitter. Any other
 * error — a config load failure, a malformed success-body JSON parse — is
 * NOT retried; it propagates immediately and is fatal, exactly as before.
 */
import { SupervisorRequestError } from "./report-resilience.js";

export const REGISTRATION_BASE_DELAY_MS = 5_000;
export const REGISTRATION_MAX_DELAY_MS = 5 * 60_000;

/**
 * Exponential backoff with "equal jitter": the floor for a given attempt
 * is half the uncapped exponential value, which — because doubling means
 * that floor equals the *previous* attempt's uncapped ceiling — guarantees
 * delay(attempt) >= delay(attempt-1) for every attempt before the series
 * hits REGISTRATION_MAX_DELAY_MS, not just on average. `attempt` is
 * 0-based (the delay before the (attempt+2)th try).
 */
export function computeBackoffDelay(attempt: number): number {
	const exp = Math.min(REGISTRATION_BASE_DELAY_MS * 2 ** attempt, REGISTRATION_MAX_DELAY_MS);
	const floor = exp / 2;
	return Math.round(floor + Math.random() * floor);
}

export type BackoffDeps = {
	sleep: (ms: number) => Promise<void>;
	computeDelay: (attempt: number) => number;
};

export const defaultBackoffDeps: BackoffDeps = {
	sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
	computeDelay: computeBackoffDelay,
};

/**
 * Retries `fn` forever on a SupervisorRequestError. `onRetryableFailure` is
 * called before each sleep so the caller can log status/statusText/body
 * error — it never decides whether to retry (that's unconditional for any
 * SupervisorRequestError). `deps` makes the delay and sleep functions
 * injectable so tests can run the retry loop without real timers.
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	onRetryableFailure: (error: SupervisorRequestError, attempt: number, delayMs: number) => void,
	deps: BackoffDeps = defaultBackoffDeps,
): Promise<T> {
	let attempt = 0;
	for (;;) {
		try {
			return await fn();
		} catch (error) {
			if (!(error instanceof SupervisorRequestError)) {
				// Config or parse errors stay fatal — never retried (D10).
				throw error;
			}
			const delayMs = deps.computeDelay(attempt);
			onRetryableFailure(error, attempt, delayMs);
			await deps.sleep(delayMs);
			attempt++;
		}
	}
}
