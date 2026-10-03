import { useEffect } from "react";
import { useUsersStore } from "../stores/users-store.js";

/**
 * Asks the directory about owner ids it doesn't list yet. Runs in an effect so
 * a render never starts a request; the store debounces and remembers ids it
 * still can't find.
 */
export function useNoteUnknownOwners(ids: ReadonlyArray<string | null | undefined>): void {
	const byId = useUsersStore((s) => s.byId);
	const noteUnknown = useUsersStore((s) => s.noteUnknown);
	const key = ids.filter(Boolean).join(",");
	useEffect(() => {
		for (const id of key.split(",")) if (id && !byId[id]) noteUnknown(id);
	}, [key, byId, noteUnknown]);
}
