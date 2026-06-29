import { useNavigate } from "react-router-dom";
import { useUserStore } from "../stores/user-store.js";

/**
 * Encapsulates the sign-out flow shared by Layout (mobile drawer) and
 * TopBar (desktop UserMenu). Handles all three sign-out paths:
 *
 *   Local session (signOutUrl starts with "/api/"): POST the session-
 *   specific logout URL, clear local user state, navigate to /login.
 *
 *   SSO/forwardauth session with an IdP logout URL: POST /auth/logout
 *   first to revoke the bridged ap_session server-side, then hard-navigate
 *   to the IdP's logout URL (e.g. Authentik's /outpost.goauthentik.io/sign_out).
 *
 *   SSO/forwardauth session without an IdP logout URL (non-Authentik
 *   providers that expose no logout endpoint): POST /auth/logout to revoke
 *   the ap_session, then clear local user state and navigate to /login.
 *   The Sign out control is always shown to authenticated users regardless
 *   of whether signOutUrl is set — the caller must not hide it on null.
 */
export function useSignOut() {
	const signOutUrl = useUserStore((s) => s.signOutUrl);
	const reloadUser = useUserStore((s) => s.load);
	const navigate = useNavigate();

	async function handleSignOut() {
		if (signOutUrl?.startsWith("/api/")) {
			// Local session: POST to the session-specific logout endpoint.
			await fetch(signOutUrl, { method: "POST", credentials: "same-origin" }).catch(() => {});
			await reloadUser();
			navigate("/login", { replace: true });
		} else {
			// SSO/forwardauth session: revoke the ap_session cookie server-side first
			// so subsequent un-forwardauth'd /auth/me calls are unauthenticated,
			// even if the browser retains the stale cookie for a moment.
			await fetch("/api/v1/auth/logout", {
				method: "POST",
				credentials: "same-origin",
			}).catch(() => {});
			if (signOutUrl) {
				// IdP has a logout URL — hand off so the provider can clear its session.
				window.location.assign(signOutUrl);
			} else {
				// Provider has no logout URL: just clear local state and bounce to /login.
				await reloadUser();
				navigate("/login", { replace: true });
			}
		}
	}

	return { handleSignOut, signOutUrl };
}
