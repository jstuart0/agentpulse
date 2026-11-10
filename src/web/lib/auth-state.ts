import type { AuthMeResponse } from "../../shared/types.js";

/** The slice of the user store that /auth/me fills in. */
export interface AuthState {
	user: AuthMeResponse["user"];
	authenticated: boolean;
	signOutUrl: string | null;
	disableAuth: boolean;
	allowSignup: boolean;
	/** The instance mode; solo until the server says otherwise (an older server never does). */
	mode: "solo" | "team";
	modeLockedByEnv: boolean;
	/** users.id for people, the owner's id for an owned key, null otherwise. */
	userId: string | null;
	effectiveRole: "admin" | "member" | null;
	/** True until the user replaces a password someone else chose. */
	mustChangePassword: boolean;
	/** True when the server refused this address while authentication is off (AGEN-92): the app shows only the notice. */
	hostRefused: boolean;
	/** The server's own words for the refusal, when it sent them. */
	hostRefusedMessage: string | null;
}

export function authStateFromMe(res: AuthMeResponse): AuthState {
	return {
		user: res.user,
		authenticated: res.authenticated,
		signOutUrl: res.signOutUrl,
		disableAuth: res.disableAuth,
		allowSignup: res.allowSignup,
		mode: res.mode ?? "solo",
		modeLockedByEnv: res.modeLockedByEnv ?? false,
		userId: res.user?.userId ?? null,
		effectiveRole: res.user?.effectiveRole ?? null,
		mustChangePassword: res.user?.mustChangePassword === true,
		hostRefused: false,
		hostRefusedMessage: null,
	};
}
