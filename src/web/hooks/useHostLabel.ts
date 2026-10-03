import { useCallback } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import { launchHostLabel } from "../pages/hosts-view-state.js";
import { useUserStore } from "../stores/user-store.js";
import { useUsersStore } from "../stores/users-store.js";
import { useOwnershipUi } from "./useOwnershipUi.js";

/**
 * What a host is called where it is picked as a launch target: its name, and
 * in team mode whose it is ("alice-mbp (Alice's host)"), so nobody starts a
 * process on a colleague's machine without noticing. Pure: a page that lists
 * hosts asks the directory about unknown owners with `useNoteUnknownOwners`.
 */
export function useHostLabel(): (
	host: Pick<SupervisorRecord, "hostName" | "ownerUserId">,
) => string {
	const ui = useOwnershipUi();
	const selfId = useUserStore((s) => s.userId);
	const directory = useUsersStore((s) => s.byId);
	return useCallback(
		(host) => {
			return launchHostLabel(ui, host, (id) => directory[id], selfId);
		},
		[ui, selfId, directory],
	);
}
