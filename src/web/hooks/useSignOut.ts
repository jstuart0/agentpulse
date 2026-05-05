import { useNavigate } from "react-router-dom";
import { useUserStore } from "../stores/user-store.js";

/**
 * Encapsulates the sign-out flow shared by Layout (mobile drawer) and
 * TopBar (desktop UserMenu). Handles both local-session logout (POST to
 * /api/…, then bounce to /login) and Authentik / external logout
 * (hard-navigate to the outpost URL).
 */
export function useSignOut() {
	const signOutUrl = useUserStore((s) => s.signOutUrl);
	const reloadUser = useUserStore((s) => s.load);
	const navigate = useNavigate();

	async function handleSignOut() {
		if (signOutUrl?.startsWith("/api/")) {
			// Local session: POST to our logout endpoint and bounce to /login.
			await fetch(signOutUrl, { method: "POST", credentials: "same-origin" }).catch(() => {});
			await reloadUser();
			navigate("/login", { replace: true });
		} else if (signOutUrl) {
			// Authentik (or external): hard-navigate so the outpost handles it.
			window.location.assign(signOutUrl);
		}
	}

	return { handleSignOut, signOutUrl };
}
