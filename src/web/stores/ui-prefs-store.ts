import { create } from "zustand";

/**
 * Client-side display preferences. No server round-trip — each
 * browser remembers its own choices in localStorage. Separate from
 * Labs flags, which gate *features* (user-facing capability shipping
 * state); this store only toggles presentation.
 */

const STORAGE_KEY = "agentpulse.uiPrefs";

interface UiPrefs {
	/**
	 * Tint session cards + tabs by project (last path segment of cwd).
	 * Default on — the tint helps group work visually in a multi-repo
	 * dashboard, and is subtle enough not to fight the rest of the UI.
	 */
	projectColors: boolean;
	/**
	 * Show sessions whose project is tagged `scratch`. Default off so the
	 * normal dashboard view doesn't accumulate ephemeral AI-initiated
	 * workspaces. The toggle lives on the dashboard and is per-browser.
	 */
	showScratch: boolean;
}

const DEFAULTS: UiPrefs = {
	projectColors: true,
	showScratch: false,
};

function load(): UiPrefs {
	if (typeof localStorage === "undefined") return DEFAULTS;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULTS;
		const parsed = JSON.parse(raw) as Partial<UiPrefs>;
		return { ...DEFAULTS, ...parsed };
	} catch {
		return DEFAULTS;
	}
}

function save(prefs: UiPrefs): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// quota / privacy mode — ignore
	}
}

interface UiPrefsStore extends UiPrefs {
	setProjectColors: (enabled: boolean) => void;
	setShowScratch: (enabled: boolean) => void;
}

export const useUiPrefsStore = create<UiPrefsStore>((set, get) => ({
	...load(),
	setProjectColors(enabled) {
		set({ projectColors: enabled });
		save({ ...get(), projectColors: enabled });
	},
	setShowScratch(enabled) {
		set({ showScratch: enabled });
		save({ ...get(), showScratch: enabled });
	},
}));
