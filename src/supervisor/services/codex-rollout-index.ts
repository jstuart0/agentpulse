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
/** root, year, month, day, plus room for a layout change. */
const MAX_DEPTH = 6;
const HOUR_MS = 60 * 60 * 1000;

export type DirEntry = { name: string; isDir: boolean };

/** The two filesystem questions the index asks; injectable so a test can count or break them. */
export interface RolloutFs {
	/** The entries of a directory, or null when it cannot be read. */
	readdir(dir: string): DirEntry[] | null;
	/** The modification time of a file or directory and, where the system has one, an identity that is the same for every path to the same file; null when it cannot be statted. */
	stat(path: string): { mtimeMs: number; id?: string } | null;
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
	stat(path) {
		try {
			const st = statSync(path, { bigint: true });
			return {
				mtimeMs: Number(st.mtimeMs),
				id: st.ino === 0n ? undefined : `${st.dev}:${st.ino}`,
			};
		} catch {
			return null;
		}
	},
};

/** AGENTPULSE_CODEX_RESUME_WINDOW_HOURS: hours; 0 turns resumed-session discovery off; unset or invalid means the default. */
export function resumeWindowMsFromEnv(env: Record<string, string | undefined>): number {
	const raw = env.AGENTPULSE_CODEX_RESUME_WINDOW_HOURS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_RESUME_WINDOW_HOURS * HOUR_MS;
	const hours = Number(raw);
	if (!Number.isFinite(hours) || hours < 0) return DEFAULT_RESUME_WINDOW_HOURS * HOUR_MS;
	return hours * HOUR_MS;
}

type DirNode = {
	mtimeMs: number;
	listedAt: number;
	subdirs: string[];
	files: string[];
	/** 0 = check on every scan. */
	nextCheckAt: number;
};

export interface RolloutListing {
	/** Newest first. */
	files: string[];
	/** Files that are here only because they were written recently, outside the recent day directories. */
	resumedOnly: Set<string>;
}

export interface RolloutIndex {
	list(): RolloutListing;
}

export function createRolloutIndex(options: {
	root: string;
	backfillDays: number;
	resumeWindowMs: number;
	now?: () => number;
	fs?: RolloutFs;
	coldRecheckMs?: number;
	relistFallbackMs?: number;
	/** The local time zone's offset from UTC at a given time, in ms (default: the process's); for tests. */
	localOffsetMs?: (t: number) => number;
}): RolloutIndex {
	const fs = options.fs ?? realRolloutFs;
	const now = options.now ?? Date.now;
	const coldRecheckMs = options.coldRecheckMs ?? COLD_RECHECK_MS;
	const relistFallbackMs = options.relistFallbackMs ?? RELIST_FALLBACK_MS;
	const localOffsetMs =
		options.localOffsetMs ?? ((t: number) => -new Date(t).getTimezoneOffset() * 60_000);
	const dirs = new Map<string, DirNode>();
	const fileMtimes = new Map<string, number>();
	const fileIds = new Map<string, string>();

	/**
	 * Today and the backfill days, named for the UTC date and for the local date:
	 * nothing here establishes which of the two Codex uses, and a session started
	 * near midnight must be in the set either way.
	 */
	function recentDayDirs(t: number): Set<string> {
		const result = new Set<string>();
		for (let i = 0; i <= options.backfillDays; i++) {
			const at = t - i * 86_400_000;
			for (const shifted of [at, at + localOffsetMs(at)]) {
				const d = new Date(shifted);
				result.add(
					join(
						options.root,
						String(d.getUTCFullYear()),
						String(d.getUTCMonth() + 1).padStart(2, "0"),
						String(d.getUTCDate()).padStart(2, "0"),
					),
				);
			}
		}
		return result;
	}

	function forgetFile(file: string): void {
		fileMtimes.delete(file);
		fileIds.delete(file);
	}

	function forget(dir: string): void {
		const node = dirs.get(dir);
		if (!node) return;
		for (const file of node.files) forgetFile(file);
		for (const sub of node.subdirs) forget(sub);
		dirs.delete(dir);
	}

	/** False when the directory could not be read; the old listing then stays as it was. */
	function relist(dir: string, node: DirNode, t: number): boolean {
		const entries = fs.readdir(dir);
		if (!entries) return false;
		const subdirs: string[] = [];
		const files: string[] = [];
		for (const entry of entries) {
			if (entry.isDir) subdirs.push(join(dir, entry.name));
			else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
				files.push(join(dir, entry.name));
			}
		}
		// A fixed order, so of two paths to one directory the same one is always the one walked.
		subdirs.sort();
		for (const gone of node.subdirs) if (!subdirs.includes(gone)) forget(gone);
		for (const gone of node.files) if (!files.includes(gone)) forgetFile(gone);
		node.subdirs = subdirs;
		node.files = files;
		node.listedAt = t;
		return true;
	}

	function spread(dir: string): number {
		let h = 0;
		for (let i = 0; i < dir.length; i++) h = (h * 31 + dir.charCodeAt(i)) >>> 0;
		return h % coldRecheckMs;
	}

	function visit(
		dir: string,
		depth: number,
		recent: Set<string>,
		t: number,
		visitedIds: Set<string>,
	): void {
		let node = dirs.get(dir);
		const isRecentDay = recent.has(dir);
		const holdsDirs = node ? node.subdirs.length > 0 || node.files.length === 0 : true;
		const due = !node || isRecentDay || holdsDirs || t >= node.nextCheckAt;
		if (due) {
			const dirStat = fs.stat(dir);
			const mtime = dirStat?.mtimeMs ?? null;
			if (mtime === null) {
				forget(dir);
				return;
			}
			// A directory reached by a second path (a symlink) is walked once, by whichever path came first.
			if (dirStat?.id !== undefined) {
				if (visitedIds.has(dirStat.id)) return;
				visitedIds.add(dirStat.id);
			}
			if (!node) {
				node = {
					mtimeMs: mtime,
					listedAt: Number.NEGATIVE_INFINITY,
					subdirs: [],
					files: [],
					nextCheckAt: 0,
				};
				dirs.set(dir, node);
			}
			if (mtime !== node.mtimeMs || t - node.listedAt >= relistFallbackMs) {
				if (relist(dir, node, t)) node.mtimeMs = mtime;
			}
			let hot = isRecentDay;
			for (const file of node.files) {
				const fileStat = fs.stat(file);
				const m = fileStat?.mtimeMs ?? null;
				if (fileStat === null || m === null) {
					forgetFile(file);
					continue;
				}
				fileMtimes.set(file, m);
				if (fileStat.id !== undefined) fileIds.set(file, fileStat.id);
				if (t - m < options.resumeWindowMs) hot = true;
			}
			node.nextCheckAt = hot ? 0 : t + coldRecheckMs + spread(dir);
		}
		if (!node || depth >= MAX_DEPTH) return;
		for (const sub of node.subdirs) visit(sub, depth + 1, recent, t, visitedIds);
	}

	return {
		list() {
			const t = now();
			const recent = recentDayDirs(t);
			visit(options.root, 0, recent, t, new Set());

			const found: { path: string; mtimeMs: number }[] = [];
			const resumedOnly = new Set<string>();
			// One real file reached through several paths is reported once, under the path that sorts first, so it is the same path every scan.
			const firstPathById = new Map<string, string>();
			for (const dir of dirs.keys()) {
				for (const file of dirs.get(dir)?.files ?? []) {
					const id = fileIds.get(file);
					if (id === undefined) continue;
					const seen = firstPathById.get(id);
					if (seen === undefined || file < seen) firstPathById.set(id, file);
				}
			}
			for (const [dir, node] of dirs) {
				const isRecentDay = recent.has(dir);
				for (const file of node.files) {
					const mtimeMs = fileMtimes.get(file);
					if (mtimeMs === undefined) continue;
					const id = fileIds.get(file);
					if (id !== undefined && firstPathById.get(id) !== file) continue;
					if (isRecentDay) found.push({ path: file, mtimeMs });
					else if (t - mtimeMs < options.resumeWindowMs) {
						found.push({ path: file, mtimeMs });
						resumedOnly.add(file);
					}
				}
			}
			found.sort((a, b) => b.mtimeMs - a.mtimeMs);
			return { files: found.map((f) => f.path), resumedOnly };
		},
	};
}
