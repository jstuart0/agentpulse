/**
 * `update.lock`: one updater at a time. Created exclusively, without following a link, 0600, holding the
 * holder's `{pid, processStartedAt}`. A lock is stale when no live process matches that pair (a `ps` read,
 * never a signal) or the machine booted after it was taken, so a crash or a power cut can't block recovery.
 * A stale lock is moved aside and the take is tried again; a live holder means `locked`.
 */
import {
	constants,
	closeSync,
	linkSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_LOCK_BYTES = 1024;

export interface LockDeps {
	now: () => number;
	pid: number;
	/** `ps -o lstart=` for a pid, or null when there is no such process. */
	identityOf: (pid: number) => string | null;
	/** When the machine booted, or null when unknown. */
	bootTimeMs: () => number | null;
	/** Wall clock for file ages (default `Date.now`); `now` may be a test's fake clock. */
	wallNow?: () => number;
	/** Test only: runs between judging a lock stale and moving it aside, where a rival can act. */
	afterJudgedStale?: () => void;
}

/** A lock file that is empty or unreadable is a torn write only once nobody has touched it for this long. */
const TORN_LOCK_GRACE_MS = 5_000;

interface LockBody {
	pid: number;
	processStartedAt: string | null;
	takenAt: number;
}

function parseLock(text: string): LockBody | null {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (
			typeof raw.pid !== "number" ||
			!Number.isSafeInteger(raw.pid) ||
			(raw.processStartedAt !== null && typeof raw.processStartedAt !== "string") ||
			typeof raw.takenAt !== "number"
		) {
			return null;
		}
		return {
			pid: raw.pid,
			processStartedAt: raw.processStartedAt as string | null,
			takenAt: raw.takenAt,
		};
	} catch {
		return null;
	}
}

function readLock(path: string): LockBody | "unreadable" | null {
	try {
		const text = readFileSync(path, "utf-8");
		if (text.length > MAX_LOCK_BYTES) return "unreadable";
		return parseLock(text) ?? "unreadable";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
	}
}

/** True when the holder the lock names is gone. An unreadable lock is stale: it can only be a torn write. */
export function lockIsStale(path: string, deps: LockDeps): boolean {
	const body = readLock(path);
	if (body === null) return false;
	if (body === "unreadable") {
		try {
			return (deps.wallNow ?? Date.now)() - statSync(path).mtimeMs >= TORN_LOCK_GRACE_MS;
		} catch {
			return false;
		}
	}
	return holderGone(body, deps);
}

function holderGone(body: LockBody, deps: LockDeps): boolean {
	const boot = deps.bootTimeMs();
	if (boot !== null && body.takenAt < boot) return true;
	const identity = deps.identityOf(body.pid);
	if (identity === null) return true;
	return body.processStartedAt !== null && identity !== body.processStartedAt;
}

function tryCreate(path: string, deps: LockDeps): boolean {
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
			0o600,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		const body: LockBody = {
			pid: deps.pid,
			processStartedAt: deps.identityOf(deps.pid),
			takenAt: deps.now(),
		};
		writeSync(fd, `${JSON.stringify(body)}\n`);
	} finally {
		closeSync(fd);
	}
	return true;
}

/** Takes the lock, or returns null when a live process holds it. The caller releases with the returned function. */
export function acquireLock(path: string, deps: LockDeps): (() => void) | null {
	const release = () => {
		try {
			unlinkSync(path);
		} catch {
			// already gone
		}
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		if (tryCreate(path, deps)) return release;
		if (!lockIsStale(path, deps)) return null;
		deps.afterJudgedStale?.();
		// Move it aside under a name only this taker uses, then judge what was actually moved: between the
		// judgement and the rename a rival may have replaced the stale lock with a live one.
		const aside = `${path}.stale-${deps.now()}-${deps.pid}-${attempt}`;
		try {
			renameSync(path, aside);
		} catch {
			continue;
		}
		const moved = readLock(aside);
		const live = moved !== null && moved !== "unreadable" && !holderGone(moved, deps);
		if (live) {
			try {
				// Put it back only if nobody has taken the path since; link fails rather than overwrite.
				linkSync(aside, path);
			} catch {
				// someone else already holds the lock
			}
			try {
				unlinkSync(aside);
			} catch {
				// already gone
			}
			return null;
		}
		try {
			unlinkSync(aside);
		} catch {
			// left behind: harmless
		}
	}
	return null;
}
