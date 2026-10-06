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
	/** `mode` is present only when the timeline must change mode; `filters` are the toggles to switch on. */
	| { action: "reveal"; mode?: TimelineMode; filters: Partial<Record<keyof RevealFilters, true>> }
	| { action: "fetch" }
	/** The event is not in this session's activity (after asking the server once). */
	| { action: "not_found" }
	/** The event is recorded, but no timeline mode or filter shows this kind of event. */
	| { action: "not_shown" };

/** The line above the timeline when showing the event needed a different mode. */
export function modeSwitchedCopy(mode: TimelineMode): string {
	return `Switched Activity to ${mode.charAt(0).toUpperCase()}${mode.slice(1)} to show this event.`;
}

export const EVENT_LOAD_FAILED_COPY = "Couldn't load that event.";
export const EVENT_NOT_FOUND_COPY = "That event is no longer in this session's activity.";
export const EVENT_NOT_SHOWN_COPY = "That event is recorded, but Activity doesn't show this kind.";

const FILTER_KEYS = ["showTools", "showNoisyTools", "showSystem"] as const;

/** The order a mode is chosen in when the current one can't show the event: least noise first. */
const MODES_QUIET_TO_NOISY: readonly TimelineMode[] = [
	"prompts",
	"conversation",
	"progress",
	"terminal",
	"debug",
];

/** Subsets of `keys` of exactly `size`, in key order. */
function subsetsOfSize<T>(keys: readonly T[], size: number): T[][] {
	if (size === 0) return [[]];
	return keys.flatMap((key, i) =>
		subsetsOfSize(keys.slice(i + 1), size - 1).map((rest) => [key, ...rest]),
	);
}

type RevealTarget = RevealInput["events"][number];

function shownIn(target: RevealTarget, mode: TimelineMode, f: RevealFilters): boolean {
	return (
		getVisibleEvents(
			[target],
			mode,
			f.showTools || mode === "debug" || mode === "terminal",
			f.showNoisyTools,
			f.showSystem,
		).length === 1
	);
}

/** The fewest filters to switch on, in `mode`, to show the event: `{}` when it already shows, null when none helps. */
function fewestFilters(
	target: RevealTarget,
	mode: TimelineMode,
	filters: RevealFilters,
): Partial<Record<keyof RevealFilters, true>> | null {
	const off = FILTER_KEYS.filter((key) => !filters[key]);
	for (let size = 0; size <= off.length; size++) {
		for (const combo of subsetsOfSize(off, size)) {
			const turnedOn = Object.fromEntries(combo.map((key) => [key, true as const]));
			if (shownIn(target, mode, { ...filters, ...turnedOn })) return turnedOn;
		}
	}
	return null;
}

/**
 * What the page does about `#event-<id>`, decided from what it holds: scroll to it; turn on the
 * fewest timeline filters that show it in the current mode; failing that, switch to the quietest
 * mode that shows it (with the fewest filters there); ask the server for its surroundings (once
 * per session and event, as the guard records); or say it is gone (`not_found`) or never shown
 * (`not_shown`). Stateless: the same input gives the same answer, so a link clicked twice runs again.
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
	const here = fewestFilters(target, mode, filters);
	if (here) {
		return Object.keys(here).length === 0
			? { action: "scroll" }
			: { action: "reveal", filters: here };
	}
	for (const other of MODES_QUIET_TO_NOISY) {
		if (other === mode) continue;
		const there = fewestFilters(target, other, filters);
		if (there) return { action: "reveal", mode: other, filters: there };
	}
	return { action: "not_shown" };
}
