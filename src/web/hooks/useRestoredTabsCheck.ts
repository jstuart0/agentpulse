import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { checkSessions } from "../lib/session-gone.js";
import { forgetGoneSessions } from "../stores/forget-gone-sessions.js";
import { useTabsStore } from "../stores/tabs-store.js";

const CHECK_CONCURRENCY = 3;

export function closedTabsNotice(closed: number): string {
	return closed === 1
		? "Closed 1 tab for a session that was deleted."
		: `Closed ${closed} tabs for sessions that were deleted.`;
}

/**
 * Once per adoption of a viewer's tabs (including one that happened before this mounted), asks the server
 * about each restored tab with the small name read, and closes the ones whose session is gone. A tab opened
 * after the adoption isn't asked about, and a viewer change while the answers are out closes nothing.
 */
export function useRestoredTabsCheck(): void {
	const restored = useTabsStore((s) => s.restored);
	useEffect(() => {
		if (restored === 0) return;
		const ids = useTabsStore.getState().tabs.map((t) => t.sessionId);
		if (ids.length === 0) return;
		let cancelled = false;
		void checkSessions(ids, api.getSessionName, { concurrency: CHECK_CONCURRENCY }).then((gone) => {
			if (cancelled || useTabsStore.getState().restored !== restored) return;
			const { closedTabs } = forgetGoneSessions(gone);
			if (closedTabs > 0) toast(closedTabsNotice(closedTabs));
		});
		return () => {
			cancelled = true;
		};
	}, [restored]);
}
