import { create } from "zustand";
import { api, setRequestFailureHandler, setRequestSuccessHandler } from "../lib/api.js";
import {
	type AuthLoadOutcome,
	FRESH_WATCH,
	type SignInEvent,
	createRecheckGate,
	createSingleFlight,
	isNetworkFailure,
	isRoleRefusal,
	loadedAfter,
	reduceAuthLoad,
	reduceSignInWatch,
	resetTarget,
	shouldRecheckAuth,
} from "../lib/auth-session.js";
import { type AuthState, authStateFromMe } from "../lib/auth-state.js";
import { IDENTITY_PATH } from "../lib/network-retry.js";

export interface AuthUser {
	name: string;
	// "authentik" retained for one release to tolerate cached responses from a previous
	// server version. New responses emit "forwardauth". Phase 2 will remove "authentik".
	source: "forwardauth" | "authentik" | "api_key" | "local";
	/** The configured forwardauth provider label (e.g. "authentik", "authelia"). Only present when source === "forwardauth". */
	provider?: string | null;
	id: string | null;
	role: "user" | "admin" | null;
	/** users.id for local/SSO callers; the key's owner for api_key callers; null otherwise. Absent on an older server. */
	userId?: string | null;
	/** A display label for the caller, never the stored "sso:provider:subject" username. Absent on an older server. */
	displayName?: string | null;
	/** True until the user replaces a password someone else chose. Absent on an older server. */
	mustChangePassword?: boolean;
	/** admin or member, resolved per request. Absent on an older server. */
	effectiveRole?: "admin" | "member";
}

interface UserState extends AuthState {
	loading: boolean;
	loaded: boolean;
	error: string | null;
	/** Polls keep being refused as signed out while the identity check cannot say why: stop polling and say so until it answers. */
	sessionUnconfirmed: boolean;
	/** Resolves true when the server answered. Calls made during a load share one fresh trailing load. */
	load: () => Promise<boolean>;
	/**
	 * Asks again on a hint that the viewer's standing changed elsewhere (a role
	 * refusal, the tab coming back, a socket reconnecting). Bounded: one at a
	 * time and not again within a few seconds. Fire and forget; the answer
	 * updates the store (or resets the app for a different person).
	 */
	recheck: () => void;
}

/** After a hint-driven re-check starts, another is not made for this long. */
const RECHECK_MIN_INTERVAL_MS = 5_000;
let recheckGate = createRecheckGate(RECHECK_MIN_INTERVAL_MS);

let signInWatchSink: ((event: SignInEvent) => void) | null = null;

/**
 * Auth introspection store. /auth/me is public and returns 200 whether
 * or not the caller is authenticated — the UI uses `authenticated` and
 * `allowSignup` to decide between login page, signup page, or app. The
 * instance mode, the caller's role and the must-change-password flag ride on
 * the same response, so one load keeps them all in step.
 */
export const useUserStore = create<UserState>((set, get) => {
	let watch = FRESH_WATCH;
	function noteSignIn(event: SignInEvent) {
		const next = reduceSignInWatch(watch, event);
		watch = next.watch;
		if (next.unconfirmed !== get().sessionUnconfirmed)
			set({ sessionUnconfirmed: next.unconfirmed });
	}
	signInWatchSink = noteSignIn;

	const loadOnce = createSingleFlight(async (): Promise<boolean> => {
		set({ loading: true, error: null });
		let outcome: AuthLoadOutcome;
		try {
			outcome = { kind: "ok", res: await api.getAuthMe() };
		} catch (err) {
			outcome = {
				kind: "failed",
				network: isNetworkFailure(err),
				message: err instanceof Error ? err.message : String(err),
			};
		}
		noteSignIn(
			outcome.kind === "failed" && outcome.network ? "identity_unanswered" : "identity_answered",
		);
		const { patch, reset } = reduceAuthLoad(get(), outcome);
		set({ ...patch, loading: false, loaded: loadedAfter(get().loaded, outcome) });
		// Every other store holds the previous viewer's data: start over with a
		// full page load rather than trying to clear them one by one.
		if (reset) window.location.assign(resetTarget(reset));
		return outcome.kind === "ok";
	});

	return {
		...authStateFromMe({
			authenticated: false,
			user: null,
			signOutUrl: null,
			disableAuth: false,
			allowSignup: false,
		}),
		loading: false,
		loaded: false,
		error: null,
		sessionUnconfirmed: false,
		load: loadOnce,
		recheck: () => {
			if (!recheckGate.tryStart()) return;
			void loadOnce().finally(() => recheckGate.finish());
		},
	};
});

// A refused call can mean the session ended or a password change became
// required: ask who the viewer is again, and the gate (or the login page) takes over.
setRequestFailureHandler((failure) => {
	if (failure.status === 401 && failure.path !== IDENTITY_PATH) signInWatchSink?.("refused");
	if (!shouldRecheckAuth(failure)) return;
	if (isRoleRefusal(failure)) useUserStore.getState().recheck();
	else void useUserStore.getState().load();
});
setRequestSuccessHandler(() => signInWatchSink?.("answered"));

export function _resetIdentityRecheckForTest(): void {
	recheckGate = createRecheckGate(RECHECK_MIN_INTERVAL_MS);
}
