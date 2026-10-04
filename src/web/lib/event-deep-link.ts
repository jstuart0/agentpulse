/**
 * AGEN-69 phase 7: links to a timeline event and the pure plan for revealing one on arrival.
 * The page applies the plan (phase 8); nothing here touches React, the DOM or the network.
 */
import type { SessionEvent } from "../../shared/types.js";
import type { TimelineMode } from "../components/session-detail/TimelineView.js";

export function evidenceHref(_sessionId: string, _eventId: number | string): string | null {
	throw new Error("not implemented");
}

/** `E12` (a ledger id as stored in a summary) to the event id 12; null for anything else. */
export function evidenceEventId(_ledgerId: string): number | null {
	throw new Error("not implemented");
}

export interface RevealGuard {
	readonly fetched: ReadonlySet<string>;
}

export function emptyRevealGuard(): RevealGuard {
	throw new Error("not implemented");
}

export function markContextFetched(
	_guard: RevealGuard,
	_sessionId: string,
	_eventId: number,
): RevealGuard {
	throw new Error("not implemented");
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

export function planEventReveal(_input: RevealInput): RevealPlan {
	throw new Error("not implemented");
}
