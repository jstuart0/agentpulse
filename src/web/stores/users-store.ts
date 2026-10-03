import { create } from "zustand";
import { currentOwnershipUi } from "../hooks/useOwnershipUi.js";
import { type DirectoryUser, api } from "../lib/api.js";

export interface UsersStoreDeps {
	loadDirectory: () => Promise<DirectoryUser[]>;
	/** False in solo mode: there is no directory to ask for. */
	canCall: () => boolean;
	/** How long an unknown id waits, so a burst of them costs one request. */
	debounceMs: number;
}

export interface UsersState {
	byId: Record<string, DirectoryUser>;
	loaded: boolean;
	load: () => Promise<void>;
	lookup: (id: string | null | undefined) => DirectoryUser | undefined;
	/** An id was seen that the directory doesn't list: refetch once, debounced. */
	noteUnknown: (id: string | null | undefined) => void;
}

const UNKNOWN_ID_DEBOUNCE_MS = 300;

/**
 * The people who can own things, for labels and pickers. Team mode only: in
 * solo mode nothing here ever makes a request. An id the directory still
 * doesn't list after a refetch is remembered, so a stale id can't cause a
 * request on every render.
 */
export function createUsersStore(deps: UsersStoreDeps) {
	let inflight: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const waiting = new Set<string>();
	const stillMissing = new Set<string>();

	return create<UsersState>((set, get) => {
		function load(): Promise<void> {
			if (!deps.canCall()) return Promise.resolve();
			if (inflight) return inflight;
			inflight = (async () => {
				try {
					const users = await deps.loadDirectory();
					set({ byId: Object.fromEntries(users.map((user) => [user.id, user])), loaded: true });
				} catch {
					// Keep what was known; the next unknown id or page load tries again.
				} finally {
					inflight = null;
				}
			})();
			return inflight;
		}

		return {
			byId: {},
			loaded: false,
			load,
			lookup: (id) => (id ? get().byId[id] : undefined),
			noteUnknown: (id) => {
				if (!id || !deps.canCall() || get().byId[id] || stillMissing.has(id)) return;
				waiting.add(id);
				if (timer) return;
				timer = setTimeout(async () => {
					timer = null;
					const asked = [...waiting];
					waiting.clear();
					await load();
					for (const askedId of asked) if (!get().byId[askedId]) stillMissing.add(askedId);
				}, deps.debounceMs);
			},
		};
	});
}

export const useUsersStore = createUsersStore({
	loadDirectory: async () => (await api.getUserDirectory()).users,
	canCall: () => currentOwnershipUi().callDirectory,
	debounceMs: UNKNOWN_ID_DEBOUNCE_MS,
});
