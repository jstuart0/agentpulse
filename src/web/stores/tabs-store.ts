import { create } from "zustand";
import type { AgentType, ManagedState } from "../../shared/types.js";
import { useUserStore } from "./user-store.js";

export interface OpenTab {
	sessionId: string;
	displayName: string;
	agentType: AgentType;
	// Narrowed in TYPE-2b. Persisted to localStorage; on rehydrate we
	// trust the value because the only producer (SessionDetailPage)
	// reads it from the typed managedSession.managedState.
	managedState: ManagedState | null;
	/**
	 * Session working directory — used for the per-project color tint
	 * on the tab bar. Optional so tabs persisted before this field
	 * existed still load without being filtered out.
	 */
	cwd?: string | null;
}

const STORAGE_BASE = "agentpulse.openTabs";
const MAX_TABS = 12;

/** Where this viewer's tabs live. Null until the viewer is known: nothing is read or written before then. */
let storageKey: string | null = null;

function keyFor(userId: string | null): string {
	return userId === null ? STORAGE_BASE : `${STORAGE_BASE}.${userId}`;
}

function read(key: string): OpenTab[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(key);
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
	if (storageKey === null) return;
	try {
		localStorage.setItem(storageKey, JSON.stringify(tabs));
	} catch {
		// quota or privacy mode — ignore
	}
}

/**
 * Tabs the page kept under one shared key before they belonged to a person:
 * a viewer with no id of their own (solo without sign-in) keeps using that key
 * as it was; for everyone else it is removed, never shown to a different person.
 */
function retireSharedKey(adoptedUserId: string | null) {
	if (adoptedUserId === null || typeof localStorage === "undefined") return;
	try {
		localStorage.removeItem(STORAGE_BASE);
	} catch {
		// Storage refused: the shared key is simply never read again.
	}
}

interface TabsStore {
	tabs: OpenTab[];
	/** The viewer is known (or changed): show and save their tabs, not the previous person's. */
	adopt: (userId: string | null) => void;
	open: (tab: OpenTab) => void;
	close: (sessionId: string) => void;
	clear: () => void;
}

export const useTabsStore = create<TabsStore>((set) => ({
	tabs: [],
	adopt: (userId) => {
		storageKey = keyFor(userId);
		retireSharedKey(userId);
		set({ tabs: read(storageKey) });
	},
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

// Open tabs follow the signed-in person: when who is looking becomes known or changes, load theirs.
let adoptedFor: { userId: string | null } | null = null;
function adoptViewer() {
	const { loaded, userId } = useUserStore.getState();
	if (!loaded) {
		adoptedFor = null;
		return;
	}
	if (adoptedFor && adoptedFor.userId === userId) return;
	adoptedFor = { userId };
	useTabsStore.getState().adopt(userId);
}
useUserStore.subscribe(adoptViewer);
adoptViewer();
