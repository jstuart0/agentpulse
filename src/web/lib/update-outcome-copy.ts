import type { UpdateStateName } from "../../shared/release-manifest.js";
/**
 * Every sentence the web says about updates, in one place: what each updater outcome means and what to do,
 * what each update state means, what a member (who can't update the server) is told, and the labels,
 * names and templates the badge, notices, panel and host notice use. Nothing here comes from the release
 * feed: the one datum a template takes is a version number, inserted only after it parses as a release
 * version, and every string reaches the page as a React text node.
 *
 * `OUTCOME_COPY` has exactly one entry per `UpdateOutcomeCode` and `STATE_COPY` one per `UpdateStateName`;
 * `MEMBER_RED_COPY` has one per red state. update-outcome-copy.test.ts holds the three sets equal to the
 * unions, so a code added on the server fails here until it has words.
 */
import {
	type RED_UPDATE_STATES,
	UPDATE_OUTCOME_CODES,
	type UpdateOutcomeCode,
} from "../../shared/update-status.js";
import { parseReleaseVersion } from "../../shared/version.js";

export interface OutcomeCopy {
	sentence: string;
	next: string;
}

export const OUTCOME_COPY: Record<UpdateOutcomeCode, OutcomeCopy> = {
	// consent and install
	no_consent: {
		sentence: "Automatic updates are off on this machine.",
		next: "Turn them on with agentpulse update auto on, or update by hand.",
	},
	container: {
		sentence: "This server runs in a container, so it can't update itself.",
		next: "Pull the new image and recreate the container.",
	},
	kubernetes: {
		sentence: "This server runs in Kubernetes, so it can't update itself.",
		next: "Set both images to the new tag.",
	},
	no_service_manager: {
		sentence: "No service manager was found to restart AgentPulse.",
		next: "Update by hand, then restart it yourself.",
	},
	tracking_ref: {
		sentence: "This install follows a branch, not releases.",
		next: "Re-run the installer without --ref to follow releases.",
	},
	fork_install: {
		sentence: "This copy has commits that aren't part of a release.",
		next: "Update it by hand from your own remote.",
	},
	no_install_record: {
		sentence: "This machine has no install record.",
		next: "Re-run install-local.sh to create one.",
	},
	symlinked_install: {
		sentence: "The install directory is a symbolic link.",
		next: "Point the installer at the real directory and re-run it.",
	},
	// manifest and target
	unverified: {
		sentence: "The release information couldn't be verified.",
		next: "Update by hand.",
	},
	stale: {
		sentence: "The release information is out of date.",
		next: "Try again later, or update by hand.",
	},
	pulled: {
		sentence: "That release was withdrawn.",
		next: "Wait for a newer release.",
	},
	downgrade: {
		sentence: "That would move AgentPulse to an older version.",
		next: "Pass the explicit downgrade flag if you mean it.",
	},
	refused_before: {
		sentence: "This version failed before and won't be tried again.",
		next: "Wait for a newer release.",
	},
	server_version_unknown: {
		sentence: "The server's version couldn't be read.",
		next: "Check that the server is running, then try again.",
	},
	up_to_date: {
		sentence: "AgentPulse is already up to date.",
		next: "There is nothing to do.",
	},
	canary_wait: {
		sentence: "This release is being held back for a short time.",
		next: "It will be tried again later.",
	},
	// migrations
	migration_needs_consent: {
		sentence: "This update changes the database.",
		next: "Allow migrations when you turn on automatic updates, or update by hand.",
	},
	postgres_migration: {
		sentence: "This update changes a Postgres database.",
		next: "Back up the database, then re-run install-local.sh by hand.",
	},
	// preflight
	dirty_tree: {
		sentence: "The install has changes that aren't committed.",
		next: "Commit or discard them, then try again.",
	},
	untracked_files: {
		sentence: "The install has files git doesn't know about.",
		next: "Move them away, then try again.",
	},
	disk_space: {
		sentence: "There isn't enough free disk space.",
		next: "Free some space, then try again.",
	},
	not_fast_forward: {
		sentence: "The checkout can't move forward to the release.",
		next: "Check its local history, then update by hand.",
	},
	commit_mismatch: {
		sentence: "The release tag doesn't point at the expected commit.",
		next: "Nothing was changed. Report this on the project's issue tracker.",
	},
	db_path_mismatch: {
		sentence: "The database path doesn't match the running server.",
		next: "Nothing was changed. Check install.json, then try again.",
	},
	outside_window: {
		sentence: "It isn't inside the allowed update window.",
		next: "It will run in the next window.",
	},
	locked: {
		sentence: "Another update is already running.",
		next: "Wait for it to finish, then try again.",
	},
	// staging
	install_failed: {
		sentence: "Installing the new version's dependencies failed.",
		next: "The running copy was not changed.",
	},
	build_failed: {
		sentence: "Building the new version failed.",
		next: "The running copy was not changed.",
	},
	smoke_failed: {
		sentence: "The new version didn't start cleanly in a test run.",
		next: "The running copy was not changed.",
	},
	snapshot_failed: {
		sentence: "The database snapshot couldn't be made.",
		next: "The running copy was not changed.",
	},
	// supervisor and services
	supervisor_busy: {
		sentence: "This host's supervisor is busy with a session.",
		next: "The update will try again when it is idle.",
	},
	drain_timeout: {
		sentence: "The supervisor didn't go idle in time.",
		next: "Try again when no session is running.",
	},
	stop_failed: {
		sentence: "A service didn't stop in time.",
		next: "Nothing was swapped. Check the service, then try again.",
	},
	health_failed: {
		sentence: "The new server didn't pass its health check.",
		next: "The previous version is being restored.",
	},
	supervisor_failed: {
		sentence: "The new supervisor didn't register.",
		next: "The previous version is being restored.",
	},
	// result
	rolled_back: {
		sentence: "The update failed and the previous version was restored.",
		next: "That version won't be tried again.",
	},
	rollback_failed: {
		sentence: "The update failed and restoring the previous version failed too.",
		next: "Services are stopped. Follow the recovery steps the updater printed.",
	},
	updated: {
		sentence: "AgentPulse was updated.",
		next: "Reload this page to use the new version.",
	},
};

export const UNKNOWN_OUTCOME_COPY: OutcomeCopy = {
	sentence: "The updater reported something this page doesn't recognise.",
	next: "Check the updater log on that machine.",
};

/** The words for an outcome code, or the fallback. The code itself is never echoed. */
export function outcomeCopy(code: string): OutcomeCopy {
	return (UPDATE_OUTCOME_CODES as readonly string[]).includes(code)
		? OUTCOME_COPY[code as UpdateOutcomeCode]
		: UNKNOWN_OUTCOME_COPY;
}

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
		next: () => "Set AGENTPULSE_UPDATE_CHECK to turn them back on.",
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

/**
 * Labels, accessible names and small templates, split by where they are used: the badge and notices ship in
 * the main chunk, the panel and the host notice only in the lazy pages that show them (a bundler drops an
 * export nothing in a chunk references).
 */
export const UPDATE_BADGE_COPY = {
	available: {
		text: "Update available",
		name: (v: string | null) => (v ? `Update available: ${v}` : "Update available"),
	},
	security: {
		text: "Security update",
		name: (v: string | null) =>
			v ? `Security update available: ${v}` : "Security update available",
	},
	current_pulled: { text: "Version withdrawn", name: () => "Version withdrawn: update the server" },
	below_minimum: {
		text: "Unsupported version",
		name: () => "Unsupported version: update the server",
	},
	unverified: { text: "Can't verify updates", name: () => "Can't verify updates. Update by hand." },
} as const;

export const UPDATE_NOTICE_COPY = {
	regionLabel: "Update notice",
	dismissLabel: "Dismiss update notice for this session",
	howTo: "How to update",
	notesLink: "Release notes (GitHub)",
	staleTab: (version: string) =>
		`AgentPulse was updated to ${version}. Reload to use the new version.`,
	reload: "Reload",
} as const;

export const UPDATE_PANEL_COPY = {
	title: "Updates",
	running: "Running",
	latest: "Latest release",
	lastChecked: "Last checked",
	checkNow: "Check now",
	checking: "Checking…",
	copy: "Copy command",
	copied: "Command copied",
	rateLimited: "Checked a moment ago. Try again in a minute.",
	checkFailed: "Couldn't check just now. Try again later.",
	localhostOnly: "Run the check from this machine (localhost).",
	stale: (publishedDate: string) =>
		`This update information is out of date (last published ${publishedDate}).`,
} as const;

export const UPDATE_HOST_COPY = {
	updateServerFirst: "Update the server first.",
	runBefore: "Run ",
	runAfter: " on ",
	end: ".",
	reinstallBefore:
		"This host wasn't installed with install-local.sh, so it can't update itself. Re-install it with ",
} as const;
