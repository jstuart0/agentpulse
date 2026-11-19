/**
 * `update.lock`: one updater at a time. Created exclusively, without following a link, 0600, holding the
 * holder's `{pid, processStartedAt}`. A lock is stale when no live process matches that pair (a `ps` read,
 * never a signal) or the machine booted after it was taken, so a crash or a power cut can't block recovery.
 * A stale lock is moved aside and the take is tried again; a live holder means `locked`.
 */
import {
	constants,
	closeSync,
	openSync,
	readFileSync,
	renameSync,
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
}

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
	if (body === "unreadable") return true;
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
	for (let attempt = 0; attempt < 3; attempt++) {
		if (tryCreate(path, deps)) {
			return () => {
				try {
					unlinkSync(path);
				} catch {
					// already gone
				}
			};
		}
		if (!lockIsStale(path, deps)) return null;
		try {
			renameSync(path, `${path}.stale-${deps.now()}-${attempt}`);
		} catch {
			// a rival moved it first; try again
		}
	}
	return null;
}
