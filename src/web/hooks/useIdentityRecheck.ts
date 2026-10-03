import { useEffect } from "react";
import { useUserStore } from "../stores/user-store.js";

/**
 * A tab that comes back to the front asks who the viewer is again: a role or
 * mode change, or a different person signing in, happened while it was away.
 * Only while the app is in use, and the store bounds how often it really asks.
 */
export function useIdentityRecheck(enabled: boolean): void {
	useEffect(() => {
		if (!enabled) return;
		function onVisibilityChange() {
			if (!document.hidden) useUserStore.getState().recheck();
		}
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [enabled]);
}
