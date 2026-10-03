import { useEffect, useRef } from "react";

/**
 * Keeps a loaded list honest against the count that describes it. Whenever a
 * new set of counts arrives (`countsVersion` changes) and the settled list's
 * total is not the number those counts expect, the list is re-read once. The
 * same disagreement at the next poll asks once more, never in a loop: the
 * trigger is a new set of counts, not the disagreement itself.
 */
export function useListFollowsCount(input: {
	listTotal: number | null;
	settled: boolean;
	expected: number | undefined;
	countsVersion: unknown;
	refresh: () => void;
}): void {
	const { listTotal, settled, expected, countsVersion } = input;
	const refreshRef = useRef(input.refresh);
	refreshRef.current = input.refresh;
	const askedFor = useRef<unknown>(undefined);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new set of counts is the only trigger
	useEffect(() => {
		if (!settled || listTotal === null || expected === undefined) return;
		if (listTotal === expected) return;
		if (askedFor.current === countsVersion) return;
		askedFor.current = countsVersion;
		refreshRef.current();
	}, [countsVersion, settled, listTotal, expected]);
}
