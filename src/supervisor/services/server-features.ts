/**
 * What the server said it can do, from registration and the last heartbeat that got an answer (a failed
 * heartbeat leaves the last known list alone). Absent means off: a host never sends something an older
 * server would misread. One holder, so the places that ask see the same answer.
 */
export interface ServerFeatures {
	set(features: readonly string[] | null | undefined): void;
	has(feature: string): boolean;
}

export function createServerFeatures(initial?: readonly string[] | null): ServerFeatures {
	let current: ReadonlySet<string> = new Set(initial ?? []);
	return {
		set(features) {
			current = new Set(features ?? []);
		},
		has: (feature) => current.has(feature),
	};
}
