/**
 * AGEN-69 phase 7: links to a timeline event and the pure plan for revealing one on arrival.
 * The page applies the plan (phase 8); nothing here touches React, the DOM or the network.
 */
import type { SessionEvent } from "../../shared/types.js";
import { type TimelineMode, getVisibleEvents } from "../components/session-detail/TimelineView.js";

/** An event id as a link target: a positive safe integer, or a stored ledger id (`E12`) or its digits. */
function parseEventId(id: number | string): number | null {
	const n =
		typeof id === "number" ? id : /^E?\d+$/.test(id) ? Number(id.replace("E", "")) : Number.NaN;
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function evidenceHref(sessionId: string, eventId: number | string): string | null {
	const id = parseEventId(eventId);
	if (id === null) return null;
	return `/sessions/${encodeURIComponent(sessionId)}?tab=activity#event-${id}`;
}

/** `E12` (a ledger id as stored in a summary) to the event id 12; null for anything else. */
export function evidenceEventId(ledgerId: string): number | null {
	return /^E\d+$/.test(ledgerId) ? parseEventId(ledgerId) : null;
}

export interface RevealGuard {
	readonly fetched: ReadonlySet<string>;
}

const guardKey = (sessionId: string, eventId: number) => `${sessionId}\u0000${eventId}`;

/** A guard with nothing fetched. The page replaces its guard with one of these on leaving Activity. */
export function emptyRevealGuard(): RevealGuard {
	return { fetched: new Set() };
}

export function markContextFetched(
	guard: RevealGuard,
	sessionId: string,
	eventId: number,
): RevealGuard {
	return { fetched: new Set([...guard.fetched, guardKey(sessionId, eventId)]) };
}

export interface RevealFilters {
	showTools: boolean;
	showNoisyTools: boolean;
	showSystem: boolean;
}

export interface RevealInput {
	sessionId: string;
	eventId: number;
	/** Every event the page holds, before any filter (live events included). */
	events: ReadonlyArray<Pick<SessionEvent, "id" | "category" | "isNoise" | "content">>;
	/** False until the first page of events has arrived; nothing is decided before that. */
	eventsLoaded: boolean;
	mode: TimelineMode;
	filters: RevealFilters;
	guard: RevealGuard;
}

export type RevealPlan =
	| { action: "wait" }
	| { action: "scroll" }
	| { action: "reveal"; filters: Partial<Record<keyof RevealFilters, true>> }
	| { action: "fetch" }
	| { action: "not_found" };

const FILTER_KEYS = ["showTools", "showNoisyTools", "showSystem"] as const;

/** Subsets of `keys` of exactly `size`, in key order. */
function subsetsOfSize<T>(keys: readonly T[], size: number): T[][] {
	if (size === 0) return [[]];
	return keys.flatMap((key, i) =>
		subsetsOfSize(keys.slice(i + 1), size - 1).map((rest) => [key, ...rest]),
	);
}

/**
 * What the page does about `#event-<id>`, decided from what it holds: scroll to it, turn on the
 * fewest timeline filters that show it, ask the server for its surroundings (once per session and
 * event, as the guard records), or give up with "could not be found". Stateless: the same input
 * gives the same answer, so a link clicked twice runs again.
 */
export function planEventReveal(input: RevealInput): RevealPlan {
	const { events, eventId, mode, filters, guard, sessionId } = input;
	if (!input.eventsLoaded) return { action: "wait" };
	const target = events.find((e) => e.id === eventId);
	if (!target) {
		return guard.fetched.has(guardKey(sessionId, eventId))
			? { action: "not_found" }
			: { action: "fetch" };
	}
	const shownWith = (f: RevealFilters) =>
		getVisibleEvents(
			[target],
			mode,
			f.showTools || mode === "debug" || mode === "terminal",
			f.showNoisyTools,
			f.showSystem,
		).length === 1;
	if (shownWith(filters)) return { action: "scroll" };
	const off = FILTER_KEYS.filter((key) => !filters[key]);
	for (let size = 1; size <= off.length; size++) {
		for (const combo of subsetsOfSize(off, size)) {
			const turnedOn = Object.fromEntries(combo.map((key) => [key, true as const]));
			if (shownWith({ ...filters, ...turnedOn })) return { action: "reveal", filters: turnedOn };
		}
	}
	return { action: "not_found" };
}
