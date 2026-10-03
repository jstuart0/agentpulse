import type { AuthMeResponse } from "../../shared/types.js";
import { ApiError } from "./api.js";
import { type AuthState, authStateFromMe } from "./auth-state.js";
import { IDENTITY_PATH } from "./network-retry.js";

/**
 * The sign-in state machine, as pure functions: what a /auth/me answer (or its
 * failure) does to the user store, when a failed API call should re-ask who
 * the viewer is, and what a password change's outcomes say. The store and the
 * request wrapper only call these.
 */
export type AuthLoadOutcome =
	| { kind: "ok"; res: AuthMeResponse }
	| { kind: "failed"; network: boolean; message: string };

/** Why every store should be thrown away: the viewer is gone, or is someone else now. */
export type AuthReset = "signed_out" | "switched" | null;

/**
 * Whether a failed identity call says nothing about the viewer: a failed fetch,
 * or a server too unwell to answer (5xx) or too busy to (429). A 401 or 403 is
 * an answer, and means signed out.
 */
export function isNetworkFailure(err: unknown): boolean {
	if (!(err instanceof ApiError)) return true;
	return err.status >= 500 || err.status === 429;
}

export function reduceAuthLoad(
	prev: Pick<AuthState, "userId" | "authenticated">,
	outcome: AuthLoadOutcome,
): { patch: Partial<AuthState> & { error: string | null }; reset: AuthReset } {
	if (outcome.kind === "failed") {
		if (outcome.network) return { patch: { error: outcome.message }, reset: null };
		return {
			patch: {
				...authStateFromMe({
					authenticated: false,
					user: null,
					signOutUrl: null,
					disableAuth: false,
					allowSignup: false,
				}),
				error: outcome.message,
			},
			reset: prev.authenticated ? "signed_out" : null,
		};
	}

	const next = authStateFromMe(outcome.res);
	let reset: AuthReset = null;
	if (prev.authenticated && !next.authenticated) reset = "signed_out";
	else if (prev.userId !== null && next.userId !== null && prev.userId !== next.userId) {
		reset = "switched";
	}
	return { patch: { ...next, error: null }, reset };
}

/**
 * Whether the viewer's standing is known after a load. A network failure on
 * the very first load leaves it unknown: the app keeps its loading state and
 * the reachability notice retries, instead of treating "couldn't ask" as
 * "signed out" and sending a signed-in person to the login page.
 */
export function loadedAfter(wasLoaded: boolean, outcome: AuthLoadOutcome): boolean {
	return wasLoaded || outcome.kind === "ok" || !outcome.network;
}

const WRONG_CURRENT_PASSWORD = "Invalid current password";
const PASSWORD_CHANGE_PATH = "/auth/change-password";

/**
 * Whether a failed call means the viewer's standing changed (session ended, or
 * a password change is now required), so the app should look again at who
 * they are instead of showing the failure as a toast.
 */
export function shouldRecheckAuth(failure: {
	status: number;
	code: string | null;
	path: string;
}): boolean {
	if (failure.path === IDENTITY_PATH) return false;
	if (failure.status === 403) return failure.code === "password_change_required";
	if (failure.status !== 401) return false;
	return !(failure.path === PASSWORD_CHANGE_PATH && failure.code === WRONG_CURRENT_PASSWORD);
}

/** How many refused polls in a row, while the identity check cannot answer, before the sign-in is called unconfirmed. */
export const UNCONFIRMED_AFTER_REFUSALS = 3;

export interface SignInWatch {
	/** Polls refused as signed out (401) with no success between them. */
	refusals: number;
	/** The latest identity check got no usable answer (outage-class). */
	identityUnanswered: boolean;
}

export type SignInEvent = "refused" | "answered" | "identity_unanswered" | "identity_answered";

export const FRESH_WATCH: SignInWatch = { refusals: 0, identityUnanswered: false };

/**
 * Whether the dashboard can still tell the viewer is signed in. Refusals alone
 * are handled by the identity check (a 200 "signed out" sends them to log in);
 * the sign-in is unconfirmed only when polls keep being refused AND the identity
 * check cannot say why. Then the polling stops until it can.
 */
export function reduceSignInWatch(
	watch: SignInWatch,
	event: SignInEvent,
): { watch: SignInWatch; unconfirmed: boolean } {
	const next: SignInWatch =
		event === "refused"
			? { ...watch, refusals: watch.refusals + 1 }
			: event === "answered"
				? { ...watch, refusals: 0 }
				: event === "identity_unanswered"
					? { ...watch, identityUnanswered: true }
					: { refusals: 0, identityUnanswered: false };
	return {
		watch: next,
		unconfirmed: next.refusals >= UNCONFIRMED_AFTER_REFUSALS && next.identityUnanswered,
	};
}

/**
 * One run at a time. Calls made while a run is in flight share a single
 * trailing run that starts when it ends, and wait for that one: an answer that
 * was already on its way when the caller asked can be stale (a password was
 * just changed), so the caller gets one that began after it asked.
 */
export function createSingleFlight<T>(run: () => Promise<T>): () => Promise<T> {
	let inflight: Promise<T> | null = null;
	let trailing: Promise<T> | null = null;

	function start(): Promise<T> {
		const current: Promise<T> = run().finally(() => {
			if (inflight === current) inflight = null;
		});
		inflight = current;
		return current;
	}

	return () => {
		if (!inflight) return start();
		if (!trailing) {
			trailing = inflight
				.catch(() => undefined)
				.then(() => {
					trailing = null;
					return start();
				});
		}
		return trailing;
	};
}

export const SIGNED_OUT_MESSAGE = "You've been signed out.";

export function loginNotice(search: string): string | null {
	return new URLSearchParams(search).get("reason") === "signed_out" ? SIGNED_OUT_MESSAGE : null;
}

/** Where the full page load goes. Only a sign-out says why. */
export function resetTarget(reset: Exclude<AuthReset, null>): string {
	return reset === "signed_out" ? "/login?reason=signed_out" : "/login";
}

export type PasswordChangeFailure = {
	field: "current" | "next" | null;
	message: string;
	/** Set when the server is throttling this account: how long until the right password is accepted again. */
	retryAfterSeconds?: number;
};

const SECONDS_PER_MINUTE = 60;

function throttledFailure(retryAfterSeconds: number | null): PasswordChangeFailure {
	if (retryAfterSeconds === null) {
		return {
			field: null,
			message: "Too many wrong attempts. Wait a few minutes, then try again.",
		};
	}
	const minutes = Math.max(1, Math.ceil(retryAfterSeconds / SECONDS_PER_MINUTE));
	return {
		field: null,
		message: `Too many wrong attempts. Wait about ${minutes} ${minutes === 1 ? "minute" : "minutes"}, then try again.`,
		retryAfterSeconds,
	};
}

export function classifyPasswordChangeFailure(err: unknown): PasswordChangeFailure {
	if (err instanceof ApiError) {
		if (err.status === 429) return throttledFailure(err.retryAfterSeconds);
		if (err.status === 401) {
			return err.code === WRONG_CURRENT_PASSWORD
				? { field: "current", message: "That isn't your current password." }
				: {
						field: null,
						message: "You've been signed out. Sign in again to change your password.",
					};
		}
		if (err.code === "password_complexity_failed") {
			const reason = (err.body as { reason?: unknown } | null)?.reason;
			return {
				field: "next",
				message:
					typeof reason === "string" && reason ? reason : "That password doesn't meet the rules.",
			};
		}
	}
	return { field: null, message: "Couldn't change the password. Try again." };
}

/** After the server accepted the change: did the follow-up identity check also work? */
export function afterPasswordChange(reloaded: boolean): { message: string; ok: boolean } {
	return reloaded
		? { ok: true, message: "Password changed." }
		: {
				ok: false,
				message:
					"Your password was changed, but we couldn't confirm your sign-in. Reload the page.",
			};
}
