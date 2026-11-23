/**
 * Version parsing and comparison, in two grammars that must not be mixed up.
 *
 * - Release versions (`parseReleaseVersion`, `compareReleaseVersions`): strict semver 2.0 without build
 *   metadata, for AgentPulse's own releases. Anything that does not match the grammar is not a version.
 * - Binary versions (`parseVersionPrefix`, `compareVersions`, `versionInRange`): the leading `x.y.z` of
 *   whatever another program prints, for the protocol gates (Codex's floor, Claude Code's range).
 *
 * This file is embedded verbatim into `scripts/relay.ts` (marker block `version`), so it imports nothing.
 */

export type Version = readonly [major: number, minor: number, patch: number];

export interface ReleaseVersion {
	readonly core: Version;
	/** Pre-release identifiers, in order. Empty for a release. */
	readonly pre: readonly string[];
}

const RELEASE_PATTERN = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;
const MAX_RELEASE_VERSION_CHARS = 48;
const NUMERIC_IDENTIFIER = /^\d+$/;

function hasLeadingZero(digits: string): boolean {
	return digits.length > 1 && digits.startsWith("0");
}

/** The strict grammar for AgentPulse release versions; null for anything else. */
export function parseReleaseVersion(text: string): ReleaseVersion | null {
	if (typeof text !== "string" || text.length > MAX_RELEASE_VERSION_CHARS) return null;
	const match = RELEASE_PATTERN.exec(text);
	if (!match) return null;
	const [, major, minor, patch, pre] = match as unknown as [
		string,
		string,
		string,
		string,
		string?,
	];
	if (hasLeadingZero(major) || hasLeadingZero(minor) || hasLeadingZero(patch)) return null;
	const identifiers = pre === undefined ? [] : pre.split(".");
	for (const id of identifiers) {
		if (NUMERIC_IDENTIFIER.test(id) && hasLeadingZero(id)) return null;
	}
	return { core: [Number(major), Number(minor), Number(patch)], pre: identifiers };
}

function compareIdentifiers(a: string, b: string): number {
	const aNumeric = NUMERIC_IDENTIFIER.test(a);
	const bNumeric = NUMERIC_IDENTIFIER.test(b);
	if (aNumeric && bNumeric) {
		// No leading zeros, so a longer digit string is a larger number.
		if (a.length !== b.length) return a.length - b.length;
		return a < b ? -1 : a > b ? 1 : 0;
	}
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver 2.0 precedence: negative when `a` is older, zero when equal, positive when newer. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
	for (let i = 0; i < 3; i++) {
		const diff = (a.core[i] as number) - (b.core[i] as number);
		if (diff !== 0) return diff;
	}
	if (a.pre.length === 0 && b.pre.length === 0) return 0;
	if (a.pre.length === 0) return 1;
	if (b.pre.length === 0) return -1;
	const shared = Math.min(a.pre.length, b.pre.length);
	for (let i = 0; i < shared; i++) {
		const diff = compareIdentifiers(a.pre[i] as string, b.pre[i] as string);
		if (diff !== 0) return diff;
	}
	return a.pre.length - b.pre.length;
}

const VERSION_PREFIX_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/** A version is the leading `major.minor.patch` of a string; anything else is not a version. */
export function parseVersionPrefix(text: string | null | undefined): Version | null {
	if (typeof text !== "string") return null;
	const match = VERSION_PREFIX_PATTERN.exec(text);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The name the protocol gates have always used for `parseVersionPrefix`. */
export const parseVersion = parseVersionPrefix;

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
