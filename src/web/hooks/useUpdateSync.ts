import { useEffect } from "react";
import { startUpdateSync } from "../lib/update-sync.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useUpdateStore } from "../stores/update-store.js";

/** Mounted once, in Layout: loads the update status and keeps it fresh (see startUpdateSync). */
export function useUpdateSync(): void {
	useEffect(() => {
		const store = useUpdateStore.getState();
		return startUpdateSync({
			load: store.load,
			refreshIfStale: store.refreshIfStale,
			now: Date.now,
			setInterval: (fn, ms) => setInterval(fn, ms),
			clearInterval: (handle) => clearInterval(handle),
			onFocus: (fn) => {
				const onVisible = () => {
					if (document.visibilityState === "visible") fn();
				};
				window.addEventListener("focus", fn);
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					window.removeEventListener("focus", fn);
					document.removeEventListener("visibilitychange", onVisible);
				};
			},
			onWsState: (fn) => {
				fn(useConnectionStore.getState().wsState);
				return useConnectionStore.subscribe((state) => fn(state.wsState));
			},
		});
	}, []);
}
