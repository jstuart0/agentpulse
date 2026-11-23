import { REFETCH_INTERVAL_MS } from "../stores/update-store.js";

export interface UpdateSyncDeps {
	load: () => Promise<void>;
	refreshIfStale: (now: number) => Promise<void>;
	now: () => number;
	setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearInterval: (handle: ReturnType<typeof setInterval>) => void;
	/** Calls `fn` when the tab comes into focus; returns the remover. */
	onFocus: (fn: () => void) => () => void;
	/** Calls `fn` with each WebSocket state; returns the remover. */
	onWsState: (fn: (state: string) => void) => () => void;
}

/**
 * Keeps the update status fresh: once at start, every 6 hours, on focus when what is held is more than an
 * hour old, and at once when the WebSocket comes back after being down, so a server that restarted on a new
 * version shows the stale-tab line right away. Returns stop.
 */
export function startUpdateSync(deps: UpdateSyncDeps): () => void {
	void deps.load();
	const interval = deps.setInterval(() => void deps.load(), REFETCH_INTERVAL_MS);
	const removeFocus = deps.onFocus(() => void deps.refreshIfStale(deps.now()));
	let previous: string | null = null;
	const removeWs = deps.onWsState((state) => {
		if (state === "connected" && previous !== null && previous !== "connected") void deps.load();
		previous = state;
	});
	return () => {
		deps.clearInterval(interval);
		removeFocus();
		removeWs();
	};
}
