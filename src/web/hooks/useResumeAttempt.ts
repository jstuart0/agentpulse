import { useEffect, useMemo, useRef, useState } from "react";
import type { ControlAction } from "../../shared/types.js";
import {
	FOLLOW_POLL_MS,
	followPromptAction,
} from "../components/session-detail/prompt-composer-view.js";
import {
	type TakeoverAttempt,
	attemptAnnouncement,
	takeoverAttempt,
} from "../components/session-detail/session-takeover-view.js";
import { api } from "../lib/api.js";

export interface ResumeAttemptOptions {
	sessionId: string | undefined;
	controlActions: readonly ControlAction[];
	/** The session's host, for the success announcement. */
	hostName: string | null;
	/** Refreshes the page's view of the session; may reject, which is never shown. */
	reload: () => Promise<void>;
	/** The page's live region. */
	announce: (text: string) => void;
	/** Test seam: how long to wait between polls. */
	pollMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Where a take-over or resume stands, and the things that follow from it: while an attempt is in flight it
 * polls the session's control actions with the composer's poller (not `settleFollow`, whose words are about a
 * prompt) and asks the page to reload when the action settles; when an attempt that was in flight ends it
 * speaks the outcome through the page's live region, and on success raises a token the composer uses to take
 * focus once. The attempt itself is derived from the actions, so a reload, a poll that lands mid-attempt or
 * another tab can't lose it. An attempt ending on another session than the one now open is not announced.
 */
export function useResumeAttempt(options: ResumeAttemptOptions): {
	attempt: TakeoverAttempt;
	focusToken: number;
} {
	const { sessionId, controlActions, pollMs = FOLLOW_POLL_MS } = options;
	const attempt = useMemo(() => takeoverAttempt(controlActions), [controlActions]);
	const [focusToken, setFocusToken] = useState(0);
	const latest = useRef(options);
	latest.current = options;
	const seen = useRef<{ sessionId: string | undefined; attempt: TakeoverAttempt }>({
		sessionId,
		attempt,
	});

	useEffect(() => {
		const before = seen.current;
		seen.current = { sessionId, attempt };
		if (before.sessionId !== sessionId) return;
		const text = attemptAnnouncement(before.attempt, attempt, latest.current.hostName);
		if (text === null) return;
		latest.current.announce(text);
		if (attempt.state === "none") setFocusToken((token) => token + 1);
	}, [sessionId, attempt]);

	const inFlightId = attempt.state === "in_flight" ? attempt.actionId : null;
	useEffect(() => {
		if (!sessionId || inFlightId === null) return;
		const controller = new AbortController();
		void followPromptAction(sessionId, inFlightId, {
			fetchActions: (id, opts) => api.getSessionControlActions(id, opts),
			now: Date.now,
			sleep: () => wait(pollMs),
			signal: controller.signal,
		}).then(async (result) => {
			if (result.outcome === "aborted" || controller.signal.aborted) return;
			try {
				await latest.current.reload();
			} catch {
				// The page's own poll will say; a refresh that failed is not the attempt's failure.
			}
		});
		return () => controller.abort();
	}, [sessionId, inFlightId, pollMs]);

	return { attempt, focusToken };
}
