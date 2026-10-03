import { useEffect, useRef } from "react";
import { SECRET_LIFETIME_MS, shouldClearSecret } from "../lib/one-time-secret.js";

/**
 * A one-time secret on screen (a password, token or key value) is cleared after
 * five minutes, and as soon as the tab is hidden: it can't be fetched again, and
 * an unattended screen shouldn't keep it. `active` says whether one is showing.
 */
export function useSecretLifetime(active: boolean, onExpire: () => void): void {
	const expire = useRef(onExpire);
	expire.current = onExpire;

	useEffect(() => {
		if (!active) return;
		const shownAt = Date.now();
		const check = () => {
			if (
				shouldClearSecret({
					shownAt,
					now: Date.now(),
					tabHidden: document.visibilityState === "hidden",
				})
			) {
				expire.current();
			}
		};
		const timer = setTimeout(check, SECRET_LIFETIME_MS);
		document.addEventListener("visibilitychange", check);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", check);
		};
	}, [active]);
}
