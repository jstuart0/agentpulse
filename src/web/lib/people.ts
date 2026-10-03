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
