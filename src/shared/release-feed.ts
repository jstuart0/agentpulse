/**
 * The two places AgentPulse's own releases come from. Fixed constants: never taken from a response, an
 * environment variable or a setting (rules 10 and 21). The server's update check and the machine's updater
 * both read them here.
 */

/** The signed manifest. */
export const MANIFEST_URL = "https://jstuart0.github.io/agentpulse/releases/manifest.json";

/** The one git remote code is fetched from. An install whose `repoUrl` is anything else is a fork. */
export const CANONICAL_REPO_URL = "https://github.com/jstuart0/agentpulse.git";

/** Accepts the spellings of the canonical remote the installer or a person may have used. */
export function isCanonicalRepoUrl(url: string, canonical: string = CANONICAL_REPO_URL): boolean {
	const strip = (value: string) => value.replace(/\/+$/, "").replace(/\.git$/, "");
	return strip(url) === strip(canonical);
}
