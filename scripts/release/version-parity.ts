/**
 * The files that carry the release version, and how to read it from each. One list, used by
 * `release:prepare` (which writes them) and `version-parity.test.ts` (which holds them equal), so a
 * file added to one is added to both.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface VersionSite {
	/** Repo-relative path. */
	file: string;
	/** Matches the whole assignment; group 1 is the version. */
	pattern: RegExp;
	/** The assignment with `$VERSION` replaced by the version, for rewriting. */
	render(version: string): string;
}

export const VERSION_SITES: readonly VersionSite[] = [
	{
		file: "package.json",
		pattern: /^\t"version": "([^"]+)",$/m,
		render: (version) => `\t"version": "${version}",`,
	},
	{
		file: "scripts/relay.ts",
		pattern: /^export const RELAY_VERSION = "([^"]+)";$/m,
		render: (version) => `export const RELAY_VERSION = "${version}";`,
	},
	{
		file: "scripts/statusline.sh",
		pattern: /^AGENTPULSE_STATUSLINE_VERSION="([^"]+)"$/m,
		render: (version) => `AGENTPULSE_STATUSLINE_VERSION="${version}"`,
	},
];

/** The version each site holds, by repo-relative path; null when the site has no matching line. */
export function readVersions(root: string): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	for (const site of VERSION_SITES) {
		const text = readFileSync(join(root, site.file), "utf-8");
		out[site.file] = site.pattern.exec(text)?.[1] ?? null;
	}
	return out;
}
