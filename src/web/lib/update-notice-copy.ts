/**
 * The words the main chunk needs: the badge's labels, the banner's sentences, the stale-tab line and what each
 * update state means. Kept apart from the outcome-copy module (the updater outcomes, the Updates panel and the
 * host notice) so those larger tables only load with the lazy pages that show them. That module
 * re-exports everything here, so the copy still reads as one table; nothing in the main chunk imports it.
 *
 * Every sentence is a fixed template; the one datum inserted is a version that parsed as a release version,
 * and all of it reaches the page as React text.
 */
import type { UpdateStateName } from "../../shared/release-manifest.js";
import type { RED_UPDATE_STATES } from "../../shared/update-status.js";
import { parseReleaseVersion } from "../../shared/version.js";

export interface StateCopy {
	sentence: string;
	/** The next step, given the latest version when it is a valid one. */
	next: (latest: string | null) => string | null;
}

const validVersion = (version: string | null): version is string =>
	version !== null && parseReleaseVersion(version) !== null;

export const STATE_COPY: Record<UpdateStateName, StateCopy> = {
	disabled: {
		sentence: "Update checks are off on this server.",
		next: () => "Remove AGENTPULSE_UPDATE_CHECK=off to turn them back on.",
	},
	unverified: {
		sentence: "Can't verify updates. Update by hand.",
		next: () => null,
	},
	current_pulled: {
		sentence: "This version was withdrawn.",
		next: (latest) => (validVersion(latest) ? `Update to ${latest}.` : "Update the server."),
	},
	below_minimum: {
		sentence: "This version is no longer supported.",
		next: (latest) => (validVersion(latest) ? `Update to ${latest}.` : "Update the server."),
	},
	security: {
		sentence: "A newer version fixes a security problem.",
		next: (latest) => (validVersion(latest) ? `Update to ${latest}.` : "Update the server."),
	},
	available: {
		sentence: "A new version is available.",
		next: (latest) => (validVersion(latest) ? `Version ${latest} is out.` : null),
	},
	current: {
		sentence: "AgentPulse is up to date.",
		next: () => null,
	},
};

export const UNKNOWN_STATE_COPY: { sentence: string; next: null } = {
	sentence: "Can't read the update status for this server.",
	next: null,
};

/** The words for an update state, with the version inserted only when it is a release version. */
export function stateCopy(
	state: string,
	latest: string | null,
): { sentence: string; next: string | null } {
	if (!(state in STATE_COPY) || !Object.hasOwn(STATE_COPY, state)) return UNKNOWN_STATE_COPY;
	const copy = STATE_COPY[state as UpdateStateName];
	return { sentence: copy.sentence, next: copy.next(latest) };
}

/** What a member (who can't update the server) is told, one sentence per red state. */
export const MEMBER_RED_COPY: Record<(typeof RED_UPDATE_STATES)[number], string> = {
	security:
		"The server is running a version with a known security problem. An admin needs to update it.",
	current_pulled: "This version was withdrawn. An admin needs to update the server.",
	below_minimum: "This version is no longer supported. An admin needs to update the server.",
};

/** Badge labels: `text` on wide screens, `short` on the narrow bar, `name` as the accessible name (it begins with the words shown). */
export const UPDATE_BADGE_COPY = {
	available: {
		text: "Update available",
		short: "Update",
		name: (v: string | null) => (v ? `Update available: ${v}` : "Update available"),
	},
	security: {
		text: "Security update",
		short: "Security",
		name: (v: string | null) =>
			v ? `Security update available: ${v}` : "Security update available",
	},
	current_pulled: {
		text: "Version withdrawn",
		short: "Withdrawn",
		name: () => "Version withdrawn: update the server",
	},
	below_minimum: {
		text: "Unsupported version",
		short: "Unsupported",
		name: () => "Unsupported version: update the server",
	},
	unverified: {
		text: "Can't verify updates",
		short: "Can't verify",
		name: () => "Can't verify updates. Update by hand.",
	},
} as const;

export const UPDATE_NOTICE_COPY = {
	regionLabel: "Update notice",
	dismissLabel: "Dismiss update notice for this session",
	howTo: "How to update",
	notesLink: "Release notes (GitHub)",
	staleTab: (version: string) => `AgentPulse is now running ${version}. Reload to use it.`,
	reload: "Reload",
} as const;
