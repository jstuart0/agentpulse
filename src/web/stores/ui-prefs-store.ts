import { create } from "zustand";

/**
 * Client-side display preferences. No server round-trip — each
 * browser remembers its own choices in localStorage. Separate from
 * Labs flags, which gate *features* (user-facing capability shipping
 * state); this store only toggles presentation.
 */

const STORAGE_KEY = "agentpulse.uiPrefs";

export const ASK_SIDEBAR_MIN_WIDTH = 180;
export const ASK_SIDEBAR_MAX_WIDTH = 480;
export const ASK_SIDEBAR_DEFAULT_WIDTH = 240;

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

	/**
	 * Width (px) of the thread sidebar on the /ask page. Persisted so a
	 * resize survives reloads. Clamped to [ASK_SIDEBAR_MIN_WIDTH,
	 * ASK_SIDEBAR_MAX_WIDTH] when read or set so a stale value can't push
	 * the sidebar off-screen or shrink it below the "New conversation"
	 * button's minimum legible width.
	 */
	askSidebarWidth: number;
}

function clampAskSidebarWidth(width: unknown): number {
	const numeric = typeof width === "number" ? width : Number(width);
	if (!Number.isFinite(numeric)) return ASK_SIDEBAR_DEFAULT_WIDTH;
	return Math.min(ASK_SIDEBAR_MAX_WIDTH, Math.max(ASK_SIDEBAR_MIN_WIDTH, Math.round(numeric)));
}

const DEFAULTS: UiPrefs = {
	projectColors: true,
	showScratch: false,
	askSidebarWidth: ASK_SIDEBAR_DEFAULT_WIDTH,
};

function load(): UiPrefs {
	if (typeof localStorage === "undefined") return DEFAULTS;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULTS;
		const parsed = JSON.parse(raw) as Partial<UiPrefs>;
		return {
			...DEFAULTS,
			...parsed,
			askSidebarWidth: clampAskSidebarWidth(parsed.askSidebarWidth ?? DEFAULTS.askSidebarWidth),
		};
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
	setAskSidebarWidth: (width: number) => void;
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
	setAskSidebarWidth(width) {
		const clamped = clampAskSidebarWidth(width);
		set({ askSidebarWidth: clamped });
		save({ ...get(), askSidebarWidth: clamped });
	},
}));
