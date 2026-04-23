import { create } from "zustand";
import { api } from "../lib/api.js";

export interface AuthUser {
	name: string;
	source: "authentik" | "api_key";
	id: string | null;
}

interface UserState {
	user: AuthUser | null;
	signOutUrl: string | null;
	disableAuth: boolean;
	loading: boolean;
	error: string | null;
	load: () => Promise<void>;
}

/**
 * Auth introspection store. Populates once at app mount from
 * /api/v1/auth/me so the UI can render a user chip and sign-out
 * affordance without inspecting Authentik headers client-side.
 */
export const useUserStore = create<UserState>((set, get) => ({
	user: null,
	signOutUrl: null,
	disableAuth: false,
	loading: false,
	error: null,

	async load() {
		if (get().loading) return;
		set({ loading: true, error: null });
		try {
			const res = await api.getAuthMe();
			set({
				user: res.user,
				signOutUrl: res.signOutUrl,
				disableAuth: res.disableAuth,
				loading: false,
			});
		} catch (err) {
			set({
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
}));
