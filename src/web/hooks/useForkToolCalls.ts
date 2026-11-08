import { useCallback, useEffect, useRef, useState } from "react";
import type { ForkToolCallDto } from "../../shared/fork-tool-calls.js";
import {
	DETAIL_POLL_MS,
	indexCalls,
} from "../components/session-detail/fork-detail-availability.js";
import { ApiError, listForkToolCalls } from "../lib/api.js";

/** A change in the timeline is read again after this quiet moment, so a burst of rows is one request. */
const REFETCH_DEBOUNCE_MS = 700;

export interface ForkToolCallsData {
	/** What is stored, by tool-use id. Empty until the first answer. */
	calls: ReadonlyMap<string, ForkToolCallDto>;
	/** The server won't or can't show this viewer detail (not theirs, off, or not a fork there): no controls, no polling. */
	unavailable: boolean;
}

const NONE: ForkToolCallsData = { calls: new Map(), unavailable: false };

/**
 * The stored calls of one continued session, without their text: which rows have a Details control. Read
 * when it turns on, again a moment after the timeline changes, and every 5 s while the fork's turn runs, so a
 * row that landed before its detail gets its control when the detail does (no new socket message for this).
 * Off (`enabled` false) it asks for nothing.
 */
export function useForkToolCalls(
	sessionId: string | null,
	enabled: boolean,
	running: boolean,
	newestEventId: number,
): ForkToolCallsData {
	const [data, setData] = useState<ForkToolCallsData>(NONE);
	const generation = useRef(0);
	const stopped = useRef(false);

	const read = useCallback(async () => {
		if (!sessionId || stopped.current) return;
		const mine = generation.current;
		try {
			const list = await listForkToolCalls(sessionId);
			if (mine !== generation.current) return;
			setData({ calls: indexCalls(list.calls), unavailable: false });
		} catch (error) {
			if (mine !== generation.current) return;
			if (error instanceof ApiError && [403, 404, 503].includes(error.status)) {
				stopped.current = true;
				setData({ calls: new Map(), unavailable: true });
			}
			// Anything else (a dropped connection): keep what is shown and try on the next trigger.
		}
	}, [sessionId]);

	// A different session, or the feature turned off: forget everything.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the two are the reset triggers
	useEffect(() => {
		generation.current++;
		stopped.current = false;
		setData(NONE);
	}, [sessionId, enabled]);

	// Read when the timeline changes (debounced), and on first enabling.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `newestEventId` is the trigger
	useEffect(() => {
		if (!enabled) return;
		const timer = setTimeout(() => void read(), REFETCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [enabled, read, newestEventId]);

	useEffect(() => {
		if (!enabled || !running) return;
		const timer = setInterval(() => void read(), DETAIL_POLL_MS);
		return () => clearInterval(timer);
	}, [enabled, running, read]);

	return enabled ? data : NONE;
}
