/**
 * Which Codex rollout files the observer should look at on a scan.
 *
 * Codex keeps rollouts under `<root>/<year>/<month>/<day>/rollout-*.jsonl`, and a
 * session that is resumed keeps appending to its original file, in the day
 * directory it started in. So the candidates are every file in the recent day
 * directories (today plus the backfill days) and any file anywhere in the tree
 * written to within the resume window.
 *
 * Walking and statting the whole tree every few seconds would cost thousands of
 * syscalls for a tree that has not changed, so the index remembers what it has
 * seen:
 *  - A directory is listed again only when its own modification time changes, or
 *    after RELIST_FALLBACK_MS as a safety net.
 *  - Directories that hold subdirectories (root, years, months) are checked on
 *    every scan; they are few.
 *  - A day directory with a recently written file, or inside the recent days, is
 *    checked on every scan. Any other day directory is "cold": it is checked
 *    again after COLD_RECHECK_MS (with a per-directory spread so the checks do
 *    not all land on one scan). A resumed old session is therefore picked up
 *    within about twice that interval of its first write.
 *  - Every filesystem call may fail because something was deleted between the
 *    listing and the stat; such an entry is skipped, never thrown.
 * Files are returned newest first from remembered modification times; nothing is
 * statted while sorting.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_RESUME_WINDOW_HOURS = 24;
export const COLD_RECHECK_MS = 5 * 60 * 1000;
export const RELIST_FALLBACK_MS = 30 * 60 * 1000;

export type DirEntry = { name: string; isDir: boolean };

/** The two filesystem questions the index asks; injectable so a test can count or break them. */
export interface RolloutFs {
	/** The entries of a directory, or null when it cannot be read. */
	readdir(dir: string): DirEntry[] | null;
	/** The modification time of a file or directory, or null when it cannot be statted. */
	mtimeMs(path: string): number | null;
}

export const realRolloutFs: RolloutFs = {
	readdir(dir) {
		try {
			return readdirSync(dir, { withFileTypes: true }).map((entry) => {
				let isDir = entry.isDirectory();
				if (entry.isSymbolicLink()) {
					try {
						isDir = statSync(join(dir, entry.name)).isDirectory();
					} catch {
						isDir = false;
					}
				}
				return { name: entry.name, isDir };
			});
		} catch {
			return null;
		}
	},
	mtimeMs(path) {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return null;
		}
	},
};

/** AGENTPULSE_CODEX_RESUME_WINDOW_HOURS: hours; 0 turns resumed-session discovery off; unset or invalid means the default. */
export function resumeWindowMsFromEnv(_env: Record<string, string | undefined>): number {
	return 0;
}

export interface RolloutListing {
	/** Newest first. */
	files: string[];
	/** Files that are here only because they were written recently, outside the recent day directories. */
	resumedOnly: Set<string>;
}

export interface RolloutIndex {
	list(): RolloutListing;
}

export function createRolloutIndex(_options: {
	root: string;
	backfillDays: number;
	resumeWindowMs: number;
	now?: () => number;
	fs?: RolloutFs;
	coldRecheckMs?: number;
	relistFallbackMs?: number;
}): RolloutIndex {
	return { list: () => ({ files: [], resumedOnly: new Set() }) };
}
