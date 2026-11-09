import { useSessionStore } from "./session-store.js";
import { useTabsStore } from "./tabs-store.js";

/** The server says these sessions no longer exist: close their tabs and drop their cached rows. */
export function forgetGoneSessions(ids: string[]): { closedTabs: number } {
	if (ids.length === 0) return { closedTabs: 0 };
	const before = useTabsStore.getState().tabs.length;
	useTabsStore.getState().closeMany(ids);
	useSessionStore.getState().removeSessions(ids);
	return { closedTabs: before - useTabsStore.getState().tabs.length };
}
