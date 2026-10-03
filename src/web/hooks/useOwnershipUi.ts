import { useMemo } from "react";
import { type OwnershipUi, ownershipUi, viewerIsAdmin } from "../lib/ownership-ui.js";
import { useUserStore } from "../stores/user-store.js";

/** What this viewer may see and do, from the instance mode and their role. */
export function useOwnershipUi(): OwnershipUi {
	const mode = useUserStore((s) => s.mode);
	const effectiveRole = useUserStore((s) => s.effectiveRole);
	return useMemo(() => ownershipUi(mode, { effectiveRole }), [mode, effectiveRole]);
}

/** Whether the server says the signed-in viewer is an admin. */
export function useViewerIsAdmin(): boolean {
	return viewerIsAdmin({ effectiveRole: useUserStore((s) => s.effectiveRole) });
}

/** The same flags outside a component (a store deciding whether to make a request). */
export function currentOwnershipUi(): OwnershipUi {
	const { mode, effectiveRole } = useUserStore.getState();
	return ownershipUi(mode, { effectiveRole });
}
