import { useEffect, useMemo, useRef, useState } from "react";
import type { ControlAction, Session } from "../../shared/types.js";
import {
	stopFailureText,
	stopInFlight,
	stopSucceeded,
	stopTurnFailureText,
	stopTurnInFlight,
	stopTurnSettledText,
	stopTurnSucceeded,
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

/** What one kind of followed action is: whether it is on its way, how it failed, and what is said when it settles. */
interface FollowKind {
	inFlight: boolean;
	failure: string | null;
	/** The sentence for a settled action that went through; null when it should stay quiet. */
	successText: () => string | null;
}

/**
 * Follows one kind of control action (a Stop, a Stop turn): while one is queued or running it refreshes the
 * session every couple of seconds (the page's own poll is ten), so "Stopping..." ends when the host answers
 * rather than when the next poll lands. When one that was in flight settles, the outcome is spoken once through
 * the live region (the failure's words, else the success words). A change of session is never announced as an
 * outcome. `succeeded` counts the successes, for a caller that moves focus when one lands.
 */
function useControlActionFollow(
	options: Pick<StopFollowOptions, "sessionId" | "reload" | "announce" | "pollMs">,
	kind: FollowKind,
): { succeeded: number } {
	const { sessionId, pollMs = STOP_POLL_MS } = options;
	const { inFlight, failure } = kind;
	const latest = useRef({ options, kind });
	latest.current = { options, kind };
	const before = useRef<{ sessionId: string | undefined; inFlight: boolean }>({
		sessionId,
		inFlight,
	});
	const [succeeded, setSucceeded] = useState(0);

	useEffect(() => {
		const previous = before.current;
		before.current = { sessionId, inFlight };
		if (previous.sessionId !== sessionId) return;
		if (!previous.inFlight || inFlight) return;
		if (failure !== null) {
			latest.current.options.announce(failure);
			return;
		}
		const text = latest.current.kind.successText();
		if (text !== null) {
			latest.current.options.announce(text);
			setSucceeded((count) => count + 1);
		}
	}, [sessionId, inFlight, failure]);

	useEffect(() => {
		if (!sessionId || !inFlight) return;
		const timer = setInterval(() => {
			void latest.current.options.reload().catch(() => {
				// The page's own poll will say; a refresh that failed is not the action's failure.
			});
		}, pollMs);
		return () => clearInterval(timer);
	}, [sessionId, inFlight, pollMs]);

	return { succeeded };
}

/**
 * Follows a stop (AGEN-110). The standing failure, if the newest action is a failed stop, comes from the actions
 * themselves, so a reload or another tab still shows it.
 */
export function useStopFollow(options: StopFollowOptions): {
	stopping: boolean;
	failure: string | null;
} {
	const { session, controlActions } = options;
	const stopping = stopInFlight(controlActions);
	const failure = useMemo(
		() => (session ? stopFailureText(session, controlActions) : null),
		[session, controlActions],
	);
	useControlActionFollow(options, {
		inFlight: stopping,
		failure,
		successText: () => (stopSucceeded(options.controlActions) ? STOPPED_ANNOUNCEMENT : null),
	});
	return { stopping, failure };
}

/**
 * Follows a Stop turn (AGEN-119) the same way: "Stopping the turn…" is said by the press, and when the host
 * answers the live region says "Turn stopped. You can send a prompt." or the failure's words. `succeeded`
 * counts the stops that went through, so the page can put focus back in the prompt box.
 */
export function useStopTurnFollow(options: Omit<StopFollowOptions, "session">): {
	stoppingTurn: boolean;
	failure: string | null;
	succeeded: number;
} {
	const { controlActions } = options;
	const stoppingTurn = stopTurnInFlight(controlActions);
	const failure = useMemo(() => stopTurnFailureText(controlActions), [controlActions]);
	const { succeeded } = useControlActionFollow(options, {
		inFlight: stoppingTurn,
		failure,
		successText: () =>
			stopTurnSucceeded(options.controlActions)
				? stopTurnSettledText(options.controlActions)
				: null,
	});
	return { stoppingTurn, failure, succeeded };
}
