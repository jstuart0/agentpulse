import { useCallback, useEffect, useRef, useState } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import {
	HOSTS_TICK_MS,
	OUTBOX_POLL_MS,
	type OutboxNoticeHost,
	shouldPollHosts,
} from "../pages/host-outbox-view-state.js";

export interface HostsClockOptions {
	supervisors: Array<OutboxNoticeHost & Pick<SupervisorRecord, "id">>;
	/** Fetches the hosts quietly; true when the answer was taken, false when it failed. */
	refetch: () => Promise<boolean>;
	tickMs?: number;
	pollMs?: number;
	/** The time source; a test supplies its own. */
	clock?: () => number;
}

/**
 * The time the Hosts page judges leases by, and what keeps it honest.
 *
 * `now` moves only when the hosts were really fetched: a lease is read against the moment it was fetched,
 * so a clock that runs on its own makes every healthy host look offline once 90 s have passed. A failed
 * fetch leaves `now` (and so the cards) as they were.
 *
 * While the tab is in view the hosts are refetched every `tickMs` (so a lease that really ran out shows
 * within about that long), and every `pollMs` while any host is catching up. When the tab comes back into
 * view they are refetched at once, whatever the time away, which also restarts the poll.
 */
export function useHostsClock({
	supervisors,
	refetch,
	tickMs = HOSTS_TICK_MS,
	pollMs = OUTBOX_POLL_MS,
	clock = Date.now,
}: HostsClockOptions) {
	const [now, setNow] = useState(clock);
	const [tabHidden, setTabHidden] = useState(() => document.hidden);
	const refetchRef = useRef(refetch);
	refetchRef.current = refetch;
	const clockRef = useRef(clock);
	clockRef.current = clock;

	/** For a load the page made itself (the first, a refresh button): it counts as a fresh look too. */
	const markFresh = useCallback(() => setNow(clockRef.current()), []);

	const run = useCallback(async () => {
		if (await refetchRef.current()) setNow(clockRef.current());
	}, []);

	useEffect(() => {
		const onVisibility = () => {
			setTabHidden(document.hidden);
			if (!document.hidden) void run();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [run]);

	// While a host is catching up the poll is the refetch; the slower tick would only fire alongside it.
	const polling = shouldPollHosts(supervisors, now, tabHidden);
	useEffect(() => {
		if (polling) return;
		const tick = setInterval(() => {
			if (!document.hidden) void run();
		}, tickMs);
		return () => clearInterval(tick);
	}, [polling, run, tickMs]);

	useEffect(() => {
		if (!polling) return;
		const poll = setInterval(() => void run(), pollMs);
		return () => clearInterval(poll);
	}, [polling, run, pollMs]);

	return { now, markFresh };
}
