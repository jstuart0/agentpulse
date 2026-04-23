import { create } from "zustand";
import { type LabsFlag, type LabsFlagDefinition, type LabsFlags, api } from "../lib/api.js";

interface LabsState {
	flags: LabsFlags | null;
	registry: LabsFlagDefinition[];
	loading: boolean;
	error: string | null;
	load: () => Promise<void>;
	setFlag: (flag: LabsFlag, enabled: boolean) => Promise<void>;
	isEnabled: (flag: LabsFlag) => boolean;
}

/**
 * Global labs flag store. Loaded once at app start; individual features
 * subscribe to `isEnabled(flag)` to decide whether to render. Until the
 * first load completes, flags behave as "unknown" (isEnabled returns
 * `true` so first paint matches the already-shipped behavior — the
 * server's defaults keep the experience consistent once loaded).
 */
export const useLabsStore = create<LabsState>((set, get) => ({
	flags: null,
	registry: [],
	loading: false,
	error: null,

	async load() {
		if (get().loading) return;
		set({ loading: true, error: null });
		try {
			const res = await api.getLabsFlags();
			set({ flags: res.flags, registry: res.registry, loading: false });
		} catch (err) {
			set({
				loading: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	async setFlag(flag, enabled) {
		const prev = get().flags;
		// Optimistic: update locally so UI responds instantly.
		if (prev) set({ flags: { ...prev, [flag]: enabled } });
		try {
			const res = await api.setLabsFlag(flag, enabled);
			set({ flags: res.flags });
		} catch (err) {
			if (prev) set({ flags: prev });
			set({ error: err instanceof Error ? err.message : String(err) });
		}
	},

	isEnabled(flag) {
		const flags = get().flags;
		if (!flags) return true; // optimistic default until loaded
		return flags[flag];
	},
}));
