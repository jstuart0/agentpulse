/**
 * Where the updater's own files live, all under `<home>/.agentpulse/`. One function, so every module and
 * every test names the same paths. The updater never touches `exclude`, `hook-auth-header`,
 * `claude-fork-mcp.json`, `supervisor-gate-state.json` or `supervisor.json` (rule 18): none of them is
 * named here.
 */
import { basename, dirname, join } from "node:path";
import {
	SUPERVISOR_STATUS_FILE,
	UPDATE_CONSENT_FILE,
	UPDATE_DRAIN_FILE,
	UPDATE_STATE_FILE,
} from "../shared/update-files.js";

export interface UpdaterPaths {
	dir: string;
	installJson: string;
	consent: string;
	state: string;
	lock: string;
	journal: string;
	snapshots: string;
	updaterRoot: string;
	updaterCurrent: string;
	shim: string;
	log: string;
	supervisorStatus: string;
	drain: string;
}

export function updaterPaths(home: string): UpdaterPaths {
	const dir = join(home, ".agentpulse");
	return {
		dir,
		installJson: join(dir, "install.json"),
		consent: join(dir, UPDATE_CONSENT_FILE),
		state: join(dir, UPDATE_STATE_FILE),
		lock: join(dir, "update.lock"),
		journal: join(dir, "update-journal.json"),
		snapshots: join(dir, "update-snapshots"),
		updaterRoot: join(dir, "updater"),
		updaterCurrent: join(dir, "updater", "current"),
		shim: join(dir, "bin", "agentpulse"),
		log: join(dir, "logs", "updater.log"),
		supervisorStatus: join(dir, SUPERVISOR_STATUS_FILE),
		drain: join(dir, UPDATE_DRAIN_FILE),
	};
}

/** The sibling directories of the checkout `app` (its realpath) that a swap uses. */
export function appSiblings(app: string) {
	const parent = dirname(app);
	const name = basename(app);
	return {
		previous: join(parent, `${name}.previous`),
		staging: (version: string) => join(parent, `${name}.staging-${version}`),
		retired: (stamp: number) => join(parent, `${name}.retired-${stamp}`),
		failed: (version: string) => join(parent, `${name}.failed-${version}`),
		prefixes: {
			staging: `${name}.staging-`,
			retired: `${name}.retired-`,
			failed: `${name}.failed-`,
		},
		parent,
	};
}
