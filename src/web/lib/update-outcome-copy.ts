/**
 * Every sentence the web says about updates that the main chunk doesn't need: what each updater outcome means
 * and what to do, the Updates panel's words and the host notice's. The sentences the badge, the banner and the
 * stale-tab line use are in update-notice-copy.ts (re-exported here, so the copy reads as one table).
 *
 * `OUTCOME_COPY` has exactly one entry per `UpdateOutcomeCode`; update-outcome-copy.test.ts holds it, the state
 * table and the member sentences equal to their unions, so a code added on the server fails here until it has
 * words. Nothing here comes from the release feed; every string reaches the page as a React text node.
 */
import { UPDATE_OUTCOME_CODES, type UpdateOutcomeCode } from "../../shared/update-status.js";

export {
	MEMBER_RED_COPY,
	STATE_COPY,
	UNKNOWN_STATE_COPY,
	UPDATE_BADGE_COPY,
	UPDATE_NOTICE_COPY,
	stateCopy,
} from "./update-notice-copy.js";

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
		next: "Pass --allow-downgrade if you mean it.",
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
		next: "Check again after the next release.",
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
		sentence: "This is outside the allowed update window.",
		next: "It will run in the next window.",
	},
	locked: {
		sentence: "Another update is already running.",
		next: "Wait for it to finish, then try again.",
	},
	backoff: {
		sentence:
			"An earlier automatic update failed, so this machine is waiting before it tries again.",
		next: "Run agentpulse update to try now, or wait.",
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
	downgrade_schema: {
		sentence: "The database is newer than that version understands.",
		next: "The downgrade flag can't make this safe. Use update rollback, or restore a backup.",
	},
	nothing_to_roll_back: {
		sentence: "There is no earlier copy to go back to.",
		next: "Nothing was changed.",
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

export const UPDATE_PANEL_COPY = {
	title: "Updates",
	latest: "Latest release",
	lastChecked: "Last checked",
	automatic: "Automatic updates",
	automaticOn: "On, on this machine",
	automaticOff: "Off",
	lastRun: "Last update run",
	nextTry: "Next automatic try",
	waitingSince: "Waiting since",
	checkNow: "Check now",
	checking: "Checking…",
	copy: "Copy command",
	copyN: (n: number, total: number) => `Copy command ${n} of ${total}`,
	copied: "Command copied",
	copyFailed: "Couldn't copy. Select the command and copy it.",
	checkedJustNow: "Checked just now.",
	rateLimited: "Checked a moment ago. Try again in a minute.",
	checkFailed: "Couldn't check just now. Try again later.",
	feedUnreachable: "Couldn't reach the release feed. Showing the last verified information.",
	notPublished:
		"No signed release information is available yet, so this server can't tell you about new versions.",
	notChecked: "Update information hasn't been checked yet.",
	unreachableNoInfo:
		"Couldn't reach the release feed, so this server can't tell you about new versions.",
	localhostOnly:
		"Check now works only when you open AgentPulse on the server's own machine (localhost).",
	stale: (publishedAgo: string) =>
		`This update information is out of date (last published ${publishedAgo}).`,
} as const;

export const UPDATE_HOST_COPY = {
	versions: (host: string, server: string) => `This host runs ${host}; the server runs ${server}. `,
	serverFirst: "A newer release is out. Update the server first, then this host.",
	runBefore: "Run ",
	runAfter: " on ",
	end: ".",
	reinstallBefore:
		"This host wasn't installed with install-local.sh, so it can't update itself. If it runs only a supervisor, on macOS or Linux re-install it with ",
	reinstallWindows:
		"This host wasn't installed with install-local.sh, so it can't update itself. On Windows, update it by running install-local.ps1 again on that machine.",
	copy: (hostName: string) => `Copy the update command for ${hostName}`,
	copied: "Command copied",
	copyFailed: "Couldn't copy. Select the command and copy it.",
} as const;
