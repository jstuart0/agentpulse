import type { ActiveOperationalStatus } from "../../shared/session-state.js";
import {
	OWNER_ALL,
	OWNER_ME,
	OWNER_SERVICE,
	OWNER_UNASSIGNED,
	type OwnerParam,
} from "../lib/owner-scope.js";
import type { ViewKind } from "./dashboard-scope.js";

/** The page the dashboard loads holds this many rows; the server's total says when there are more. */
export const RECENT_PAGE_SIZE = 100;

export interface EmptyStateInput {
	kind: ViewKind;
	owner: OwnerParam;
	/** The chosen person's plain name, when the owner is a person. */
	ownerName: string | null;
	tab: string;
	statusFilter: ActiveOperationalStatus | null;
	searchActive: boolean;
	/** Every session in this scope, whatever the tab (the scoped list's total). */
	ownerTotal: number;
	/** Active sessions across the team, when the view is Mine; 0 when unknown. */
	othersActive: number;
	/** The current tab's own badge; above zero, the tab is never called empty. */
	tabCount?: number;
}

export interface EmptyState {
	heading: string;
	body: string | null;
	actions: Array<"setup" | "viewEveryone">;
}

const TAB_WORD: Record<string, string> = {
	active: "active",
	completed: "completed",
	archived: "archived",
};

/** "active", "completed", "waiting"…: the one word that says what the empty view was filtered to; null for the All tab. */
function filterWord(tab: string, statusFilter: ActiveOperationalStatus | null): string | null {
	return statusFilter ?? TAB_WORD[tab] ?? null;
}

function mineEmpty(input: EmptyStateInput): EmptyState {
	if (input.ownerTotal === 0) {
		return {
			heading: "No sessions from your keys yet",
			body: "Connect a machine with your own key and its sessions appear here.",
			actions: ["setup", "viewEveryone"],
		};
	}
	const word = filterWord(input.tab, input.statusFilter);
	const heading = word
		? `None of your sessions are ${word}`
		: "None of your sessions are in this view";
	// The team's count answers "is anyone busy?", which only the Active tab and the
	// status cards are about; elsewhere one way out is enough.
	const onActive = input.statusFilter !== null || input.tab === "active";
	return onActive && input.othersActive > 0
		? { heading, body: `${input.othersActive} active across the team.`, actions: ["viewEveryone"] }
		: { heading, body: "Try another tab.", actions: [] };
}

function personEmpty(input: EmptyStateInput): EmptyState {
	const name = input.ownerName ?? "That person";
	if (input.ownerTotal === 0) {
		return { heading: `${name} has no sessions`, body: "Try another owner.", actions: [] };
	}
	const word = filterWord(input.tab, input.statusFilter);
	return {
		heading: `${name} has no ${word ? `${word} ` : ""}sessions`,
		body: "Try another tab or another owner.",
		actions: [],
	};
}

function ownerlessEmpty(input: EmptyStateInput): EmptyState {
	const unassigned = input.owner === OWNER_UNASSIGNED;
	if (input.ownerTotal === 0) {
		return unassigned
			? { heading: "Every session has an owner", body: null, actions: [] }
			: { heading: "No sessions from service keys", body: null, actions: [] };
	}
	const word = filterWord(input.tab, input.statusFilter);
	const heading = unassigned
		? `No ${word ? `${word} ` : ""}unassigned sessions`
		: `No ${word ? `${word} ` : ""}sessions from service keys`;
	return { heading, body: "Try another tab or another owner.", actions: [] };
}

/** The empty state for a narrowed view, or null where the grid's own empty copy is right. */
export function dashboardEmptyState(input: EmptyStateInput): EmptyState | null {
	if (input.kind === "plain" || input.searchActive || input.owner === OWNER_ALL) return null;
	// A tab whose badge says there is something is never called empty.
	if ((input.tabCount ?? 0) > 0) return null;
	if (input.owner === OWNER_ME) return mineEmpty(input);
	if (input.owner === OWNER_UNASSIGNED || input.owner === OWNER_SERVICE) {
		return ownerlessEmpty(input);
	}
	return personEmpty(input);
}

export type TabViewState = "rows" | "loading" | "more" | "empty" | "recount";

/**
 * What a server-listed tab (Completed, Archived) shows when it has `loaded`
 * rows: the rows; a wait; a way to keep looking; or, only when the tab's badge
 * agrees that there is nothing, an empty state. A finished look that found
 * nothing while the badge says otherwise is a recount, never "none".
 */
export function tabViewState(input: {
	loaded: number;
	settled: boolean;
	canLoadMore: boolean;
	badge: number | undefined;
	/** A search narrows the list: the tab's badge no longer says how many there should be. */
	searchActive?: boolean;
}): TabViewState {
	if (input.loaded > 0) return "rows";
	if (input.searchActive)
		return input.settled && !input.canLoadMore ? "empty" : input.settled ? "more" : "loading";
	if (!input.settled || input.badge === undefined) return "loading";
	if (input.canLoadMore) return "more";
	return input.badge === 0 ? "empty" : "recount";
}

/** "Showing N of M" for a server-listed tab; M never exceeds what exists once the list is complete. */
export function tabListCaption(input: {
	shown: number;
	badge: number | undefined;
	canLoadMore: boolean;
	searchActive: boolean;
}): string {
	if (input.searchActive) return `Showing ${input.shown} matching`;
	const of = input.canLoadMore ? Math.max(input.shown, input.badge ?? input.shown) : input.shown;
	return `Showing ${input.shown} of ${of}`;
}

/**
 * The first-run screen is for an install with nothing in it. A narrowed view
 * that happens to be empty is not that: it keeps the page, and the switch.
 */
export function shouldShowFirstRun(input: {
	isLoading: boolean;
	loadedCount: number;
	owner: OwnerParam;
	/** The first answer failed: nothing is known about the install, so it can't be called empty. */
	failed?: boolean;
}): boolean {
	return !input.isLoading && !input.failed && input.loadedCount === 0 && input.owner === OWNER_ALL;
}
