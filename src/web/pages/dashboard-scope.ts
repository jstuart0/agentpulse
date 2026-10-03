import type { ActiveOperationalStatus } from "../../shared/session-state.js";
import { type DirectoryEntry, ownerLabel } from "../lib/owner-label.js";
import {
	OWNER_ALL,
	OWNER_ME,
	OWNER_SERVICE,
	OWNER_UNASSIGNED,
	type OwnerParam,
} from "../lib/owner-scope.js";

/**
 * What the Mine | Everyone switch and the Owner select mean, what they are
 * called, and what the page says about each. Pure: components read the
 * answers.
 */
export type ScopeChoice = "mine" | "everyone";

export const SCOPE_STORAGE_BASE = "agentpulse.dashboard.scope";

/** Stored per person, so a shared browser doesn't carry one person's choice to the next. */
export function scopeStorageKey(userId: string | null): string {
	return `${SCOPE_STORAGE_BASE}.${userId ?? "anonymous"}`;
}

export function parseScopeChoice(raw: string | null): ScopeChoice | null {
	return raw === "mine" || raw === "everyone" ? raw : null;
}

/**
 * The switch and the Owner select are one control. A segment is pressed only
 * for the owner it stands for: with a person, Service keys or Unassigned
 * chosen (or before the default is known) neither is.
 */
export function pressedSegment(
	owner: OwnerParam | null,
): typeof OWNER_ME | typeof OWNER_ALL | null {
	return owner === OWNER_ME || owner === OWNER_ALL ? owner : null;
}

export function choiceForOwner(owner: OwnerParam): ScopeChoice {
	return owner === OWNER_ME ? "mine" : "everyone";
}

export function ownerForChoice(choice: ScopeChoice): OwnerParam {
	return choice === "mine" ? OWNER_ME : OWNER_ALL;
}

/**
 * The scope the dashboard opens on: a stored choice wins; otherwise Mine when
 * the server says the viewer owns any session (whether or not they are in the
 * loaded page), else Everyone. `ownSessions` is null when the question
 * couldn't be asked.
 */
export function defaultOwner(input: {
	stored: ScopeChoice | null;
	ownSessions: number | null;
}): OwnerParam {
	if (input.stored) return ownerForChoice(input.stored);
	return input.ownSessions !== null && input.ownSessions > 0 ? OWNER_ME : OWNER_ALL;
}

// ── The owner select ────────────────────────────────────────────────────────

export interface OwnerOption {
	value: string;
	label: string;
}

const EVERYONE_LABEL = "Everyone";
const SERVICE_LABEL = "Service keys";
const UNASSIGNED_LABEL = "Unassigned";

const KEYWORDS = new Set<string>([OWNER_ALL, OWNER_ME, OWNER_SERVICE, OWNER_UNASSIGNED]);

function byLabel(a: OwnerOption, b: OwnerOption): number {
	return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
}

/**
 * Everyone, you, the other people by name, people who can no longer sign in,
 * then the two kinds of session nobody owns. An owner the directory doesn't
 * list yet is still offered, so the select never shows something it isn't.
 */
export function ownerOptions(
	people: readonly DirectoryEntry[],
	viewerUserId: string | null,
	current: OwnerParam,
): OwnerOption[] {
	const option = (entry: DirectoryEntry): OwnerOption => ({
		value: entry.id,
		label: ownerLabel(entry, entry.id, { selfId: viewerUserId, style: "you" }),
	});
	// The viewer is always offered, as "You", even before the directory has
	// loaded or when it doesn't list them: Mine must never read as Everyone.
	const self =
		viewerUserId === null
			? []
			: [
					{
						value: viewerUserId,
						label: ownerLabel(
							people.find((p) => p.id === viewerUserId),
							viewerUserId,
							{ selfId: viewerUserId, style: "you" as const },
						),
					},
				];
	const others = people
		.filter((p) => p.id !== viewerUserId && !p.disabled)
		.map(option)
		.sort(byLabel);
	const gone = people
		.filter((p) => p.id !== viewerUserId && p.disabled)
		.map(option)
		.sort(byLabel);
	const listed = new Set(people.map((p) => p.id));
	const unlisted =
		!KEYWORDS.has(current) && !listed.has(current)
			? [{ value: current, label: ownerLabel(undefined, current) }]
			: [];
	return [
		{ value: OWNER_ALL, label: EVERYONE_LABEL },
		...self,
		...others,
		...unlisted,
		...gone,
		{ value: OWNER_SERVICE, label: SERVICE_LABEL },
		{ value: OWNER_UNASSIGNED, label: UNASSIGNED_LABEL },
	];
}

/** The select shows the viewer's own entry for `me`. */
export function selectValueForOwner(owner: OwnerParam, viewerUserId: string | null): string {
	return owner === OWNER_ME && viewerUserId ? viewerUserId : owner === OWNER_ME ? OWNER_ALL : owner;
}

/** Choosing the viewer's own entry is Mine. */
export function ownerFromSelectValue(value: string, viewerUserId: string | null): OwnerParam {
	return viewerUserId !== null && value === viewerUserId ? OWNER_ME : value;
}

export function scopeAnnouncement(owner: OwnerParam, ownerName: string | null): string {
	if (owner === OWNER_ME) return "Showing your sessions.";
	if (owner === OWNER_ALL) return "Showing everyone's sessions.";
	if (owner === OWNER_UNASSIGNED) return "Showing unassigned sessions.";
	if (owner === OWNER_SERVICE) return "Showing sessions from service keys.";
	return `Showing ${ownerName ?? "that person"}'s sessions.`;
}

// ── Wording ─────────────────────────────────────────────────────────────────

/** plain: no switch at all. mine: the viewer's own. shared: everyone. owner: one other person, or one of the two ownerless kinds. */
export type ViewKind = "plain" | "mine" | "shared" | "owner";

export function viewKind(showScope: boolean, owner: OwnerParam): ViewKind {
	if (!showScope) return "plain";
	if (owner === OWNER_ME) return "mine";
	return owner === OWNER_ALL ? "shared" : "owner";
}

const STATE_HELP: Record<ViewKind, Record<ActiveOperationalStatus, string>> = {
	owner: {
		waiting:
			"An agent finished a turn, or has an outstanding permission prompt, and is waiting on a person. Its owner (or an admin) can mark it as seen.",
		error:
			"A session ended in failure and hasn't been dismissed. Its owner (or an admin) can dismiss it.",
		working: "An agent is actively working on a turn right now.",
		idle: "Nothing is waiting and the agent isn't working.",
	},
	plain: {
		waiting:
			'The agent finished a turn, or has an outstanding permission prompt, and is waiting on a person. "Mark as seen" clears it.',
		error: 'The session ended in failure and hasn\'t been dismissed. "Dismiss error" clears it.',
		working: "The agent is actively working on a turn right now.",
		idle: "Nothing is waiting and the agent isn't working.",
	},
	mine: {
		waiting:
			'Your agent finished a turn, or has an outstanding permission prompt, and is waiting on you. "Mark as seen" clears it.',
		error: 'Your session ended in failure and hasn\'t been dismissed. "Dismiss error" clears it.',
		working: "Your agent is actively working on a turn right now.",
		idle: "Nothing is waiting and your agent isn't working.",
	},
	shared: {
		waiting:
			"An agent finished a turn, or has an outstanding permission prompt, and is waiting on someone across the team. Its owner (or an admin) can mark it as seen.",
		error:
			"A session ended in failure and hasn't been dismissed. Its owner (or an admin) can dismiss it. Counted across the team.",
		working: "An agent is actively working on a turn right now, across the team.",
		idle: "Nothing is waiting and the agent isn't working.",
	},
};

export function stateHelp(kind: ViewKind, status: ActiveOperationalStatus): string {
	return STATE_HELP[kind][status];
}

export interface TileTitles {
	active: string;
	today: string;
	toolUses: string;
	total: string;
}

const TILE_TITLES: Record<ViewKind, TileTitles> = {
	owner: {
		active:
			"Sessions currently WAITING, WORKING, IDLE, or ERROR in this view — the sum of the four status cards above.",
		today: "Sessions in this view started since local midnight.",
		toolUses: "Total tool invocations across this view's sessions started today.",
		total: "Every session in this view ever recorded, including completed and archived.",
	},
	plain: {
		active:
			"Sessions currently WAITING, WORKING, IDLE, or ERROR — the sum of the four status cards above. One definition of 'active' everywhere on this page.",
		today: "Sessions started since local midnight.",
		toolUses: "Total tool invocations across sessions started today.",
		total: "Every session ever recorded, including completed and archived.",
	},
	mine: {
		active:
			"Your sessions currently WAITING, WORKING, IDLE, or ERROR — the sum of the four status cards above.",
		today: "Your sessions started since local midnight.",
		toolUses: "Total tool invocations across your sessions started today.",
		total: "Every session of yours ever recorded, including completed and archived.",
	},
	shared: {
		active:
			"Sessions currently WAITING, WORKING, IDLE, or ERROR across the team — the sum of the four status cards above.",
		today: "Sessions started since local midnight, across the team.",
		toolUses: "Total tool invocations across the team's sessions started today.",
		total: "Every session ever recorded in this view, including completed and archived.",
	},
};

export function tileTitles(kind: ViewKind): TileTitles {
	return TILE_TITLES[kind];
}

// ── Live refresh pacing ─────────────────────────────────────────────────────

/**
 * How long to wait before the next debounced refresh: the usual quiet period,
 * but never past `maxWaitMs` after the first change that is still waiting, so
 * a steady stream of updates can't postpone the refresh forever.
 */
export function nextRefreshDelay(input: {
	now: number;
	firstPendingAt: number | null;
	debounceMs: number;
	maxWaitMs: number;
}): number {
	if (input.firstPendingAt === null) return input.debounceMs;
	const untilMax = input.firstPendingAt + input.maxWaitMs - input.now;
	return Math.max(0, Math.min(input.debounceMs, untilMax));
}

// ── Poll pacing ─────────────────────────────────────────────────────────────

/**
 * Whether a poll should also reload the paged lists (a selected status, or the
 * Active, Completed and Archived tabs). With the live socket connected, every
 * change already schedules that reload; the poll is the fallback for when it
 * isn't, and the lists would otherwise cost two more requests a minute for
 * nothing. The page's own list and counts are always part of the poll.
 */
export function pollRefreshesLists(wsState: "connected" | "reconnecting" | "paused"): boolean {
	return wsState !== "connected";
}

// ── "N more active across the team" ─────────────────────────────────────────

/** The sum of the four operational counts: the one definition of "active" on the page. */
export function activeCount(operational: Record<ActiveOperationalStatus, number>): number {
	return operational.waiting + operational.working + operational.idle + operational.error;
}

/**
 * Others' active sessions under Mine: everyone's active count minus this
 * view's. Both come from the same refresh, so the difference is never a mix of
 * two moments; it is clamped at zero and absent counts say nothing.
 */
export function othersActiveCount(
	everyone: { operational: Record<ActiveOperationalStatus, number> } | null,
	ownActive: number,
): number {
	if (!everyone) return 0;
	return Math.max(0, activeCount(everyone.operational) - ownActive);
}
