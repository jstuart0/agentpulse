import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "../../shared/types.js";
import { plainErrorMessage } from "../lib/api-errors.js";
import { BUSY_BANNER_AFTER, busyWaitMs } from "../lib/busy.js";
import { useRequestGuard } from "../lib/live-request.js";

export const PAGE_SIZE = 100;
/** How long after a live change or a poll the list is re-read, so a burst of events costs one request. */
export const REFRESH_DEBOUNCE_MS = 500;
const INTERACTING_RETRY_MS = 300;
/** How long a refresh waits for a hovered or focused grid before it runs anyway: a resting pointer must not leave a list stale for ever. */
export const REFRESH_HOLD_MAX_MS = 3000;

/** What one request for rows after a cursor came back with. */
export interface PageResult {
	rows: Session[];
	/** The server's count for the whole list, when it has one. */
	total: number | null;
	/** Where the next page starts. */
	next: number;
	/** Nothing is left after this page. */
	done: boolean;
}

export interface PagedListSpec {
	/** Everything that decides which rows these are: the scope and every filter. A different key is a different list. */
	key: string;
	/** At least `want` rows after `cursor` (fewer only when the list ends). Throws on a refused or failed request. */
	fetch: (cursor: number, want: number) => Promise<PageResult>;
}

interface ListState {
	key: string | null;
	rows: Session[];
	total: number | null;
	next: number;
	done: boolean;
	error: string | null;
	/** The first page for `key` has been answered (with rows or with an error). */
	settled: boolean;
}

const EMPTY: ListState = {
	key: null,
	rows: [],
	total: null,
	next: 0,
	done: false,
	error: null,
	settled: false,
};

function withoutRepeats(existing: readonly Session[], more: readonly Session[]): Session[] {
	const seen = new Set(existing.map((row) => row.sessionId));
	return [...existing, ...more.filter((row) => !seen.has(row.sessionId))];
}

/**
 * A server-paged list that belongs to one key. Every answer is applied only
 * while the key it was asked for is still the live one (first page, Load more
 * and the silent refresh alike); until the live key's first page has landed
 * the list reports no rows, no total and `loading`, so nothing from another
 * view can be on screen and a false "empty" can't flash. `null` spec is an
 * inactive list.
 */
export function useScopedPagedList(spec: PagedListSpec | null, isInteracting?: () => boolean) {
	const [state, setState] = useState<ListState>(EMPTY);
	const stateRef = useRef(state);
	stateRef.current = state;
	const specRef = useRef(spec);
	specRef.current = spec;
	const isCurrent = useRequestGuard(spec?.key ?? "");
	const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loadingMoreRef = useRef(false);
	const moreTokenRef = useRef(0);
	const holdSinceRef = useRef<number | null>(null);
	/**
	 * Which generation of the rows an answer was asked for. A new first page
	 * starts a generation and a Load more that lands ends one, so an answer from
	 * an older one (even for the same key: A, then B, then A again) is dropped,
	 * whether it succeeded or failed.
	 */
	const generationRef = useRef(0);
	const key = spec?.key ?? null;

	const loadFirst = useCallback(
		async (asked: PagedListSpec, visible: boolean, busyAttempts = 0): Promise<void> => {
			if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
			generationRef.current += 1;
			const generation = generationRef.current;
			const wanted = () => generation === generationRef.current && isCurrent(asked.key);
			if (visible) setState({ ...EMPTY, key: asked.key });
			try {
				const page = await asked.fetch(0, PAGE_SIZE);
				if (!wanted()) return;
				setState({
					key: asked.key,
					rows: page.rows,
					total: page.total,
					next: page.next,
					done: page.done,
					error: null,
					settled: true,
				});
			} catch (err) {
				if (!wanted()) return;
				const wait = busyWaitMs(err);
				if (wait !== null && busyAttempts + 1 < BUSY_BANNER_AFTER) {
					// A busy server is asked again after the time it stated; the list stays loading.
					busyTimerRef.current = setTimeout(() => {
						if (wanted()) void loadFirst(asked, false, busyAttempts + 1);
					}, wait);
					return;
				}
				setState({ ...EMPTY, key: asked.key, error: plainErrorMessage(err), settled: true });
			}
		},
		[isCurrent],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for everything the spec decides
	useEffect(() => {
		if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
		if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
		loadingMoreRef.current = false;
		moreTokenRef.current += 1;
		generationRef.current += 1;
		const asked = specRef.current;
		if (!asked) {
			setState(EMPTY);
			return;
		}
		void loadFirst(asked, true);
	}, [key, loadFirst]);

	const loadMore = useCallback(async () => {
		const asked = specRef.current;
		const from = stateRef.current;
		if (!asked || from.key !== asked.key || !from.settled || from.done || loadingMoreRef.current) {
			return;
		}
		loadingMoreRef.current = true;
		const moreToken = ++moreTokenRef.current;
		const generation = generationRef.current;
		const wanted = () => generation === generationRef.current && isCurrent(asked.key);
		setState((prev) => (prev.key === asked.key ? { ...prev, error: null } : prev));
		try {
			const page = await asked.fetch(from.next, PAGE_SIZE);
			if (!wanted()) return;
			generationRef.current += 1;
			setState((prev) =>
				prev.key !== asked.key
					? prev
					: {
							...prev,
							rows: withoutRepeats(prev.rows, page.rows),
							total: page.total ?? prev.total,
							next: page.next,
							done: page.done,
						},
			);
		} catch (err) {
			if (!wanted()) return;
			setState((prev) =>
				prev.key === asked.key ? { ...prev, error: plainErrorMessage(err) } : prev,
			);
		} finally {
			if (moreToken === moreTokenRef.current) loadingMoreRef.current = false;
		}
	}, [isCurrent]);

	const reload = useCallback(() => {
		const asked = specRef.current;
		if (asked) void loadFirst(asked, true);
	}, [loadFirst]);

	/**
	 * A debounced, silent reload of exactly as far as the list had got (the rows read, which is every row loaded plus any the list skipped over): a live
	 * update or the poll suggests the list may be stale. Never shows a skeleton,
	 * and a failure (or a busy server) keeps the rows on screen.
	 */
	const scheduleRefresh = useCallback(
		(afterMs = REFRESH_DEBOUNCE_MS, busyAttempts = 0) => {
			if (!specRef.current) return;
			if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
			const tick = async () => {
				if (isInteracting?.()) {
					// The hold's clock survives rescheduling, so a steady stream of changes can't keep restarting it.
					holdSinceRef.current ??= Date.now();
					if (Date.now() - holdSinceRef.current < REFRESH_HOLD_MAX_MS) {
						refreshTimerRef.current = setTimeout(tick, INTERACTING_RETRY_MS);
						return;
					}
				}
				holdSinceRef.current = null;
				const asked = specRef.current;
				const from = stateRef.current;
				if (!asked || from.key !== asked.key || !from.settled) return;
				const generation = generationRef.current;
				try {
					const page = await asked.fetch(0, Math.max(from.next, PAGE_SIZE));
					if (generation !== generationRef.current || !isCurrent(asked.key)) return;
					setState({
						key: asked.key,
						rows: page.rows,
						total: page.total,
						next: page.next,
						done: page.done,
						error: null,
						settled: true,
					});
				} catch (err) {
					const wait = busyWaitMs(err);
					if (wait !== null && busyAttempts + 1 < BUSY_BANNER_AFTER && isCurrent(asked.key)) {
						scheduleRefresh(wait, busyAttempts + 1);
					}
					// Otherwise best-effort: the next poll or live update tries again.
				}
			};
			refreshTimerRef.current = setTimeout(tick, afterMs);
		},
		[isCurrent, isInteracting],
	);

	useEffect(
		() => () => {
			if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
			if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
		},
		[],
	);

	const requestRefresh = useCallback(() => scheduleRefresh(), [scheduleRefresh]);

	const live = spec !== null && state.key === spec.key ? state : EMPTY;
	return {
		rows: live.rows,
		total: live.total,
		/** More rows exist beyond the ones loaded. */
		canLoadMore: spec !== null && live.settled && !live.done,
		loading: spec !== null && !live.settled,
		error: live.error,
		reload,
		loadMore,
		scheduleRefresh: requestRefresh,
	};
}
