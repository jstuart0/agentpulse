import { create } from "zustand";
import { api } from "../lib/api.js";

export interface AuthUser {
	name: string;
	source: "authentik" | "api_key" | "local";
	id: string | null;
	role: "user" | "admin" | null;
}

interface UserState {
	user: AuthUser | null;
	authenticated: boolean;
	signOutUrl: string | null;
	disableAuth: boolean;
	allowSignup: boolean;
	loading: boolean;
	loaded: boolean;
	error: string | null;
	load: () => Promise<void>;
}

/**
 * Auth introspection store. /auth/me is public and returns 200 whether
 * or not the caller is authenticated — the UI uses `authenticated` and
 * `allowSignup` to decide between login page, signup page, or app.
 */
export const useUserStore = create<UserState>((set, get) => ({
	user: null,
	authenticated: false,
	signOutUrl: null,
	disableAuth: false,
	allowSignup: false,
	loading: false,
	loaded: false,
	error: null,

	async load() {
		if (get().loading) return;
		set({ loading: true, error: null });
		try {
			const res = await api.getAuthMe();
			set({
				user: res.user,
				authenticated: res.authenticated,
				signOutUrl: res.signOutUrl,
				disableAuth: res.disableAuth,
				allowSignup: res.allowSignup,
				loading: false,
				loaded: true,
			});
		} catch (err) {
			set({
				loading: false,
				loaded: true,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
}));
