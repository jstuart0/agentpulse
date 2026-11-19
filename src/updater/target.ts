/**
 * Which release an update moves to, and whether it may (step 5), as one pure function over a verified
 * manifest. No I/O: the caller has already verified the envelope and read the installed version.
 *
 * Rules, in order: the version must be a manifest release; a pulled release is never offered; a version
 * this machine rolled back from is never tried again; an equal version is a no-op; a lower one needs the
 * operator's explicit `allowDowngrade` (a replayed older signed release can't induce one, rule 25); an
 * automatic update takes only `latest`, never a pre-release, and waits 24 hours after publication unless the
 * release is a security fix. A supervisor-only install never moves ahead of its server: its target is the
 * highest non-pulled stable release not above the server's version.
 */
import type { Manifest, ManifestRelease } from "../shared/release-manifest.js";
import { releaseFor } from "../shared/release-manifest.js";
import type { UpdateOutcomeCode } from "../shared/update-status.js";
import { compareReleaseVersions, parseReleaseVersion } from "../shared/version.js";

export const CANARY_WAIT_MS = 24 * 3_600_000;

export interface TargetInput {
	manifest: Manifest;
	installed: string;
	mode: "manual" | "auto";
	/** A version the person named (`--to`), without the leading `v`. */
	to?: string;
	allowDowngrade?: boolean;
	/** Set for a supervisor-only install: the server's running version, or null when it couldn't be read. */
	serverVersion?: { value: string | null } | null;
	refused: Readonly<Record<string, UpdateOutcomeCode>>;
	now: number;
}

export type TargetResult =
	| { ok: true; release: ManifestRelease }
	| { ok: false; code: UpdateOutcomeCode };

function cmp(a: string, b: string): number | null {
	const pa = parseReleaseVersion(a);
	const pb = parseReleaseVersion(b);
	return pa && pb ? compareReleaseVersions(pa, pb) : null;
}

function highestAtOrBelow(manifest: Manifest, ceiling: string): ManifestRelease | null {
	let best: ManifestRelease | null = null;
	for (const release of manifest.releases) {
		const parsed = parseReleaseVersion(release.version);
		if (!parsed || parsed.pre.length > 0 || release.pulled) continue;
		const below = cmp(release.version, ceiling);
		if (below === null || below > 0) continue;
		if (!best || (cmp(release.version, best.version) ?? 0) > 0) best = release;
	}
	return best;
}

export function chooseTarget(input: TargetInput): TargetResult {
	const { manifest, installed } = input;
	let release: ManifestRelease | null;
	const serverCeiling = input.serverVersion ?? null;
	if (serverCeiling && serverCeiling.value === null)
		return { ok: false, code: "server_version_unknown" };

	if (input.to !== undefined) {
		if (!parseReleaseVersion(input.to)) return { ok: false, code: "unverified" };
		release = releaseFor(manifest, input.to);
		if (
			serverCeiling &&
			release &&
			(cmp(release.version, serverCeiling.value as string) ?? 1) > 0
		) {
			// Server first: a supervisor never moves ahead of its server.
			return { ok: false, code: "server_version_unknown" };
		}
	} else if (serverCeiling) {
		release = highestAtOrBelow(manifest, serverCeiling.value as string);
	} else {
		release = releaseFor(manifest, manifest.latest);
	}
	if (!release) return { ok: false, code: input.to !== undefined ? "unverified" : "up_to_date" };
	if (release.pulled) return { ok: false, code: "pulled" };
	if (Object.hasOwn(input.refused, release.version)) return { ok: false, code: "refused_before" };

	const order = cmp(release.version, installed);
	if (order === null) return { ok: false, code: "unverified" };
	if (order === 0) return { ok: false, code: "up_to_date" };
	if (order < 0) {
		// Nothing newer than what is installed (the installed copy is ahead of `latest`): nothing to do.
		if (input.to === undefined) return { ok: false, code: "up_to_date" };
		// Naming an older version is a downgrade, which only a person's explicit flag allows.
		if (input.mode === "auto" || !input.allowDowngrade) return { ok: false, code: "downgrade" };
		return { ok: true, release };
	}

	if (input.mode === "auto") {
		if (parseReleaseVersion(release.version)?.pre.length) return { ok: false, code: "up_to_date" };
		const age = input.now - Date.parse(release.publishedAt);
		if (release.severity !== "security" && age < CANARY_WAIT_MS)
			return { ok: false, code: "canary_wait" };
	}
	return { ok: true, release };
}
