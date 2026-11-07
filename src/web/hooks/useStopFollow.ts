import { useEffect, useMemo, useRef } from "react";
import type { ControlAction, Session } from "../../shared/types.js";
import {
	stopFailureText,
	stopInFlight,
	stopSucceeded,
} from "../components/session-detail/stop-view.js";

/** How often the page refreshes the session's control actions while a stop is on its way. */
export const STOP_POLL_MS = 2_000;

/** Said once through the live region when a stop that was in flight settles successfully. */
export const STOPPED_ANNOUNCEMENT = "Stopped.";

export interface StopFollowOptions {
	sessionId: string | undefined;
	session:
		| (Pick<Session, "agentType" | "managedSession"> & Partial<Pick<Session, "endedAt">>)
		| null;
	controlActions: readonly ControlAction[];
	/** Refreshes the page's view of the session; may reject, which is never shown. */
	reload: () => Promise<void>;
	/** The page's live region. */
	announce: (text: string) => void;
	/** Test seam: how long to wait between refreshes. */
	pollMs?: number;
}

/**
 * Follows a stop (AGEN-110). While one is queued or running it refreshes the session every couple of
 * seconds (the page's own poll is ten), so "Stopping..." ends when the host answers rather than when the
 * next poll lands. The standing failure, if the newest action is a failed stop, comes from the actions
 * themselves; when a stop that was in flight turns out to have failed it is also spoken through the live
 * region, once; so is "Stopped." when it went through. A change of session is never announced as an outcome.
 */
export function useStopFollow(options: StopFollowOptions): {
	stopping: boolean;
	failure: string | null;
} {
	const { sessionId, controlActions, session, pollMs = STOP_POLL_MS } = options;
	const stopping = stopInFlight(controlActions);
	const failure = useMemo(
		() => (session ? stopFailureText(session, controlActions) : null),
		[session, controlActions],
	);
	const latest = useRef(options);
	latest.current = options;
	const before = useRef<{ sessionId: string | undefined; stopping: boolean }>({
		sessionId,
		stopping,
	});

	useEffect(() => {
		const previous = before.current;
		before.current = { sessionId, stopping };
		if (previous.sessionId !== sessionId) return;
		if (!previous.stopping || stopping) return;
		if (failure !== null) latest.current.announce(failure);
		else if (stopSucceeded(latest.current.controlActions))
			latest.current.announce(STOPPED_ANNOUNCEMENT);
	}, [sessionId, stopping, failure]);

	useEffect(() => {
		if (!sessionId || !stopping) return;
		const timer = setInterval(() => {
			void latest.current.reload().catch(() => {
				// The page's own poll will say; a refresh that failed is not the stop's failure.
			});
		}, pollMs);
		return () => clearInterval(timer);
	}, [sessionId, stopping, pollMs]);

	return { stopping, failure };
}
