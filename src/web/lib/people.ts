import type { AdminUserRow } from "./api.js";
import { type DirectoryEntry, ownerLabel } from "./owner-label.js";

export interface PersonOption {
	id: string;
	label: string;
}

/** How an admin-list row reads as a directory entry: a local account by its login, an SSO account by its display name. */
export function directoryEntryFromAdminRow(row: AdminUserRow): DirectoryEntry {
	return {
		id: row.id,
		displayName: row.authSource === "local" ? row.username : row.displayName,
		username: row.username,
		authSource: row.authSource,
		disabled: row.disabled,
	};
}

/** The people a key, host or session can be handed to: everyone not disabled, you first, then by name. The one list the mode dialog, Hosts and the key panel all use. */
export function assignablePeople(
	entries: readonly DirectoryEntry[],
	viewerUserId: string | null,
): PersonOption[] {
	return entries
		.filter((entry) => !entry.disabled)
		.map((entry) => ({
			id: entry.id,
			label: ownerLabel({ ...entry, disabled: false }, entry.id, {
				selfId: viewerUserId,
				style: "you",
			}),
		}))
		.sort((a, b) =>
			a.id === viewerUserId
				? -1
				: b.id === viewerUserId
					? 1
					: a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
		);
}

/**
 * The people an owner picker offers, plus the current owner when they are
 * disabled (and so not assignable): listed as "<name> (disabled)" so the
 * picker can show who owns it now, choosing nothing sends nothing, and
 * Unassigned stays a real change from it.
 */
export function withCurrentOwner(
	people: PersonOption[],
	currentOwnerId: string | null | undefined,
	entry: DirectoryEntry | undefined,
	viewerUserId: string | null,
): PersonOption[] {
	if (!currentOwnerId || people.some((person) => person.id === currentOwnerId)) return people;
	const current = {
		id: currentOwnerId,
		displayName: null,
		...entry,
		disabled: true,
	};
	return [
		{ id: currentOwnerId, label: ownerLabel(current, currentOwnerId, { selfId: viewerUserId }) },
		...people,
	];
}
