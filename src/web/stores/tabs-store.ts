import { create } from "zustand";
import type { AgentType } from "../../shared/types.js";

export interface OpenTab {
	sessionId: string;
	displayName: string;
	agentType: AgentType;
	managedState: string | null;
	/**
	 * Session working directory — used for the per-project color tint
	 * on the tab bar. Optional so tabs persisted before this field
	 * existed still load without being filtered out.
	 */
	cwd?: string | null;
}

const STORAGE_KEY = "agentpulse.openTabs";
const MAX_TABS = 12;

function load(): OpenTab[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.slice(0, MAX_TABS)
			.filter(
				(t): t is OpenTab =>
					typeof t === "object" && t !== null && typeof (t as OpenTab).sessionId === "string",
			);
	} catch {
		return [];
	}
}

function save(tabs: OpenTab[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
	} catch {
		// quota or privacy mode — ignore
	}
}

interface TabsStore {
	tabs: OpenTab[];
	open: (tab: OpenTab) => void;
	close: (sessionId: string) => void;
	clear: () => void;
}

export const useTabsStore = create<TabsStore>((set) => ({
	tabs: load(),
	open: (tab) =>
		set((state) => {
			const existingIndex = state.tabs.findIndex((t) => t.sessionId === tab.sessionId);
			if (existingIndex >= 0) {
				const existing = state.tabs[existingIndex];
				const merged = { ...existing, ...tab };
				if (
					merged.displayName === existing.displayName &&
					merged.agentType === existing.agentType &&
					merged.managedState === existing.managedState
				) {
					return state;
				}
				const next = [...state.tabs];
				next[existingIndex] = merged;
				save(next);
				return { tabs: next };
			}
			const next = [...state.tabs, tab];
			const trimmed = next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
			save(trimmed);
			return { tabs: trimmed };
		}),
	close: (sessionId) =>
		set((state) => {
			const next = state.tabs.filter((t) => t.sessionId !== sessionId);
			save(next);
			return { tabs: next };
		}),
	clear: () => {
		save([]);
		set({ tabs: [] });
	},
}));
