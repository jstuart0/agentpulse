/**
 * Dotted-version comparison for the protocol gates (Codex's floor, Claude Code's range). A version is the
 * leading `major.minor.patch` of a string; anything else is not a version.
 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

export type Version = readonly [major: number, minor: number, patch: number];

export function parseVersion(text: string | null | undefined): Version | null {
	if (typeof text !== "string") return null;
	const match = VERSION_PATTERN.exec(text);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older, zero when equal, positive when newer. */
export function compareVersions(a: Version, b: Version): number {
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] as number) - (b[i] as number);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** `floor <= version < ceiling`. */
export function versionInRange(version: Version, floor: Version, ceiling: Version): boolean {
	return compareVersions(version, floor) >= 0 && compareVersions(version, ceiling) < 0;
}
