import { create } from "zustand";

/**
 * "The inbox may have changed", from the server's `inbox_changed` WebSocket message. It carries no data:
 * a screen that shows inbox items watches `version` and re-reads its own list, which the server filters
 * for the viewer.
 */
interface InboxSignalStore {
	version: number;
	bump: () => void;
}

export const useInboxSignalStore = create<InboxSignalStore>((set) => ({
	version: 0,
	bump: () => set((s) => ({ version: s.version + 1 })),
}));
