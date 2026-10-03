import { useCallback, useRef } from "react";
import type { DashboardScope } from "./owner-scope.js";

/**
 * One name for "what this request was about": the scope (owner, scratch toggle, machine) and whatever filters
 * narrow it (status, search text). Two requests with the same key ask the same
 * question; a response may be applied only while the live key still equals the
 * one it was requested with.
 */
export function requestKey(
	scope: DashboardScope | null,
	...filters: Array<string | number | boolean | null | undefined>
): string {
	if (scope === null) return "";
	// Encoded, not joined on a separator: a machine name or a search may hold any character.
	return JSON.stringify([
		scope.owner,
		scope.excludeScratch,
		scope.host ?? "",
		...filters.map((f) => f ?? ""),
	]);
}

/**
 * Whether a response is still wanted. A pure helper so hooks and tests share
 * one definition; hooks reach it through {@link useRequestGuard}.
 */
export function stillWanted(liveKey: string, requestedKey: string): boolean {
	return requestedKey !== "" && liveKey === requestedKey;
}

/**
 * The single place that decides whether an async result may land. The returned
 * function reads the key the component most recently rendered, not the one a
 * callback closed over, so a request started under one scope cannot write
 * under another: pass it the key the request was made with, after the await.
 */
export function useRequestGuard(liveKey: string): (requestedKey: string) => boolean {
	const ref = useRef(liveKey);
	ref.current = liveKey;
	return useCallback((requestedKey: string) => stillWanted(ref.current, requestedKey), []);
}
