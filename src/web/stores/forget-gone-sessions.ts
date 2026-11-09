import { useSessionStore } from "./session-store.js";
import { useTabsStore } from "./tabs-store.js";

/** Sessions whose tab was closed because the server said they are gone, in this page load: a later look at one knows it was confirmed. */
const forgotten = new Set<string>();

/** The server says these sessions no longer exist: close their tabs and drop their cached rows. */
export function forgetGoneSessions(ids: string[]): { closedTabs: number } {
	if (ids.length === 0) return { closedTabs: 0 };
	const openTabs = new Set(useTabsStore.getState().tabs.map((t) => t.sessionId));
	for (const id of ids) if (openTabs.has(id)) forgotten.add(id);
	const before = useTabsStore.getState().tabs.length;
	useTabsStore.getState().closeMany(ids);
	useSessionStore.getState().removeSessions(ids);
	return { closedTabs: before - useTabsStore.getState().tabs.length };
}

/**
 * The page's own 404 for the session it shows. `notice` is true when the server's word is confirmed and
 * worth saying plainly ("Session deleted"): this call closed its tab, the page showed it before, or the
 * restored-tab check already closed it in this page load (whichever answered first).
 */
export function handleGoneSession(
	id: string,
	shownBefore: boolean,
): { closedTabs: number; notice: boolean } {
	const confirmedEarlier = forgotten.has(id);
	const { closedTabs } = forgetGoneSessions([id]);
	return { closedTabs, notice: closedTabs > 0 || shownBefore || confirmedEarlier };
}

export function __resetForgottenForTests(): void {
	forgotten.clear();
}
