import { useEffect, useRef, useState } from "react";
import type { TimelineMode } from "../components/session-detail/TimelineView.js";
import {
	EVENT_LOAD_FAILED_COPY,
	EVENT_NOT_FOUND_COPY,
	EVENT_NOT_SHOWN_COPY,
	type RevealFilters,
	type RevealGuard,
	type RevealInput,
	emptyRevealGuard,
	markContextFetched,
	modeSwitchedCopy,
	planEventReveal,
} from "../lib/event-deep-link.js";
import type { WorkspaceTabId } from "../lib/session-summary-core.js";

export interface EventRevealInput {
	sessionId: string | undefined;
	tab: WorkspaceTabId | null;
	/** From `#event-<id>`; null when the URL names no event. */
	eventId: number | null;
	/** Every event the page holds, before any filter. */
	events: RevealInput["events"];
	eventsLoaded: boolean;
	mode: TimelineMode;
	filters: RevealFilters;
	apply: {
		setMode: (mode: TimelineMode) => void;
		setFilters: (filters: Partial<Record<keyof RevealFilters, true>>) => void;
	};
	/** Fetch the event's surroundings into the page's events. */
	fetchContext: (eventId: number) => Promise<void>;
	/** Scroll to and flash the event's element; false while it isn't in the DOM yet. */
	flash: (eventId: number) => boolean;
	announce: (text: string) => void;
}

/**
 * Following an evidence link into Activity (BN-23): applies `planEventReveal`. A mode switch is
 * said above the timeline and is the page's state only, never saved as the person's choice. A gone
 * or never-shown event is a sentence at the top, announced once; the timeline is left as it was.
 * The fetch guard and the notice are dropped on leaving Activity or changing session.
 */
export function useEventReveal(input: EventRevealInput): {
	notice: string | null;
	loadingContext: boolean;
	retry: () => void;
} {
	const { sessionId, tab, eventId, events, eventsLoaded, mode, filters } = input;
	const onActivity = tab === "activity";
	const [notice, setNotice] = useState<string | null>(null);
	const [loadingContext, setLoadingContext] = useState(false);
	const [guard, setGuard] = useState<RevealGuard>(emptyRevealGuard);
	const flashed = useRef<string | null>(null);
	const announced = useRef<string | null>(null);
	const fetching = useRef(false);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const applied = useRef<string | null>(null);
	const lastTry = useRef(-1);
	const latest = useRef(input);
	latest.current = input;

	// biome-ignore lint/correctness/useExhaustiveDependencies: the trigger is the key, nothing read inside
	useEffect(() => {
		return () => {
			setNotice(null);
			setGuard(emptyRevealGuard());
			flashed.current = null;
			announced.current = null;
			applied.current = null;
			lastTry.current = -1;
			setFailed(false);
		};
	}, [sessionId, onActivity, eventId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `events` changes identity every render by design; the keys below make a repeat a no-op
	useEffect(() => {
		if (!onActivity || eventId === null || !sessionId) return;
		const now = latest.current;
		const key = `${sessionId}:${eventId}`;
		const plan = planEventReveal({
			sessionId,
			eventId,
			events,
			eventsLoaded,
			mode,
			filters,
			guard,
		});
		switch (plan.action) {
			case "wait":
				return;
			case "scroll":
				if (flashed.current !== key && now.flash(eventId)) flashed.current = key;
				return;
			case "reveal": {
				// The same plan against the same mode and filters has been applied: wait for the page to take it.
				const signature = JSON.stringify([key, mode, filters]);
				if (applied.current === signature) return;
				applied.current = signature;
				if (plan.mode) {
					now.apply.setMode(plan.mode);
					setNotice(modeSwitchedCopy(plan.mode));
				}
				if (Object.keys(plan.filters).length > 0) now.apply.setFilters(plan.filters);
				return;
			}
			case "fetch": {
				if (fetching.current || (failed && attempt === lastTry.current)) return;
				lastTry.current = attempt;
				fetching.current = true;
				setLoadingContext(true);
				void now
					.fetchContext(eventId)
					.then(
						() => {
							setFailed(false);
							setGuard((g) => markContextFetched(g, sessionId, eventId));
						},
						() => setFailed(true),
					)
					.finally(() => {
						fetching.current = false;
						setLoadingContext(false);
					});
				return;
			}
			case "not_found":
			case "not_shown": {
				const text = plan.action === "not_found" ? EVENT_NOT_FOUND_COPY : EVENT_NOT_SHOWN_COPY;
				setNotice(text);
				if (announced.current !== key) {
					announced.current = key;
					now.announce(text);
				}
				return;
			}
		}
	});

	return {
		notice: failed ? EVENT_LOAD_FAILED_COPY : notice,
		loadingContext,
		retry: () => setAttempt((n) => n + 1),
	};
}
