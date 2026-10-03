/**
 * The write side of the exclude rules: `agentpulse exclude add`. Node-only
 * (filesystem, process), so it is imported by the CLI alone, never by the
 * web bundle or the hook-command generators.
 *
 * Adding a rule is a read-modify-write of a file every hook event reads,
 * so it is guarded the same way the reader is:
 *  - one writer at a time: an exclusive lock file in the same directory,
 *    created with O_EXCL. A lock left by a dead process (or an old one) is
 *    broken; a live one makes the add wait a few seconds and then refuse.
 *  - an unreadable existing file aborts the add (the load refuses it, and a
 *    read that fails afterwards throws before anything is written); it is
 *    never treated as an empty file, which would silently drop every
 *    existing rule.
 *  - the proposed file is run through the real rules parser before it is
 *    written. A name the file format can't carry (wildcard characters, a
 *    newline, a trailing space or tab) is refused up front with that
 *    reason, so the appended line always reads back as the directory that
 *    was asked for.
 *  - the write itself is atomic (temp file, fsync, rename), and a
 *    successful add clears a stale invalid-rules marker.
 */
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	checkWindowsSecurityAt,
	loadExcludeRules,
	normalizeForCompare,
	parseExcludeRulesContent,
	setInvalidMarker,
} from "./exclude-rules.js";
import { EXCLUDE_RULES_RELATIVE_PATH } from "./hook-headers.js";
import { writePrivateFileAtomicNoFollow } from "./private-file.js";

const EXCLUDE_FILE_NAME = EXCLUDE_RULES_RELATIVE_PATH.split("/")[1] as string;
const LOCK_FILE_NAME = `${EXCLUDE_FILE_NAME}.lock`;
const LOCK_WAIT_MS = 3000;
const LOCK_POLL_MS = 40;
/** A lock this old is from a crashed writer whatever its pid says (a live add holds it for milliseconds). */
const LOCK_STALE_MS = 60_000;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export type AddRuleResult =
	| { status: "added"; path: string; rule: string }
	| { status: "present"; path: string; rule: string }
	| { status: "refused"; message: string };

function refused(message: string): AddRuleResult {
	return { status: "refused", message };
}

/**
 * Resolves (and validates) the real .agentpulse directory to write into,
 * mirroring loadExcludeRules' read-side tolerance exactly — a symlinked
 * .agentpulse is fine as long as what it resolves to is owned by the
 * current user and not group/world-writable (POSIX) or passes the same
 * Windows ACL check the read side uses. Returns the directory to actually
 * write into (never the symlink path itself) or a single, clear refusal
 * message — never throws.
 */
export function resolveAgentpulseDirForWrite(
	home: string,
): { ok: true; dir: string } | { ok: false; message: string } {
	const rawDir = dirname(join(home, EXCLUDE_RULES_RELATIVE_PATH));
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(rawDir);
	} catch {
		mkdirSync(rawDir, { recursive: true, mode: 0o700 });
		return { ok: true, dir: rawDir };
	}

	let realDir = rawDir;
	if (st.isSymbolicLink()) {
		try {
			realDir = realpathSync.native(rawDir);
			st = lstatSync(realDir);
		} catch {
			return { ok: false, message: `${rawDir} is a symlink that could not be resolved` };
		}
		if (!st.isDirectory()) {
			return { ok: false, message: `${rawDir} does not resolve to a directory` };
		}
	} else if (!st.isDirectory()) {
		return { ok: false, message: `${rawDir} exists but is not a directory` };
	}

	if (process.platform === "win32") {
		const reason = checkWindowsSecurityAt(realDir);
		if (reason) return { ok: false, message: `${realDir} ${reason}` };
	} else {
		const uid = process.getuid?.();
		if (uid !== undefined && st.uid !== uid) {
			return { ok: false, message: `${realDir} is not owned by you` };
		}
		if ((st.mode & 0o022) !== 0) {
			return { ok: false, message: `${realDir} is group- or world-writable` };
		}
	}

	return { ok: true, dir: realDir };
}

/** The rules file itself must not be a symlink — refused, not followed. */
function checkRulesFileForWrite(path: string): { ok: true } | { ok: false; message: string } {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(path);
	} catch {
		return { ok: true };
	}
	if (st.isSymbolicLink()) {
		return { ok: false, message: `${path} is a symlink — refusing to write through it` };
	}
	if (!st.isFile()) {
		return { ok: false, message: `${path} exists but is not a regular file` };
	}
	return { ok: true };
}

/** Canonical form for dedup — a trailing slash or a symlinked spelling of the same directory must compare equal, and macOS and Windows compare case-insensitively like the evaluators do. Falls back to the lexically resolved form when the path doesn't exist yet. */
function canonicalDirForDedup(raw: string, home: string): string {
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? `${home}/${raw.slice(2)}` : raw;
	let canonical: string;
	try {
		canonical = realpathSync.native(expanded);
	} catch {
		canonical = resolve(expanded);
	}
	return normalizeForCompare(canonical);
}

/** Why a directory name can't be written as one rule line, or null when it can. Checked before anything is locked or read. */
function unwritableNameReason(dir: string): string | null {
	if (/[\n\r]/.test(dir)) {
		return "the directory name contains a newline, which can't be written as a single rule line";
	}
	if (/[*?[\]]/.test(dir)) {
		return "the directory name contains a wildcard character (* ? [ ]); rules are literal directory paths, so this one can't be written";
	}
	if (/[ \t]$/.test(dir)) {
		return "the directory name ends with a space or tab; trailing spaces and tabs are trimmed from rule lines, so the rule would name a different directory";
	}
	return null;
}

function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Identity of the lock a waiter judged stale, so a takeover can tell it removed
 * that one and not a fresh lock that replaced it. Device and inode alone are
 * not enough: Linux filesystems hand a just-freed inode number to the next file
 * created, so a rival's fresh lock can carry the same pair. The modification
 * time (nanoseconds; a rename doesn't change it) and the holder's content are
 * part of the identity too.
 */
interface LockIdentity {
	dev: bigint;
	ino: bigint;
	mtimeNs: bigint;
	content: string;
}

function identityOf(path: string): LockIdentity {
	const st = lstatSync(path, { bigint: true });
	let content = "";
	if (st.isFile()) {
		try {
			content = readFileSync(path, "utf-8");
		} catch {
			// unreadable: the other three fields still tell locks apart
		}
	}
	return { dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs, content };
}

function sameLock(a: LockIdentity, b: LockIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.content === b.content;
}

/** The identity of the lock when it is stale (old, or held by a process that no longer exists), else null. */
function judgeStale(lockPath: string): LockIdentity | null {
	try {
		const identity = identityOf(lockPath);
		const st = lstatSync(lockPath);
		if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return identity;
		if (!st.isFile()) return null;
		const pid = Number.parseInt(identity.content.trim(), 10);
		if (!Number.isInteger(pid) || pid <= 0) return null;
		try {
			process.kill(pid, 0);
			return null;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ESRCH" ? identity : null;
		}
	} catch {
		return null;
	}
}

/**
 * Takes a stale lock out of the way: rename it to a unique name (atomic, and
 * it fails if another waiter got there first), check that what was renamed is
 * the lock that was judged stale (a fresh lock that replaced it in between is
 * put back, never deleted), then delete the renamed file. A lock that is a
 * directory is deleted only if it is empty; otherwise it stays under its
 * unique name and the lock path is simply free again.
 */
function takeOverStaleLock(
	lockPath: string,
	judged: LockIdentity,
	rename: (from: string, to: string) => void,
): void {
	const aside = `${lockPath}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
	try {
		rename(lockPath, aside);
	} catch {
		return; // someone else moved or removed it first
	}
	try {
		if (!sameLock(identityOf(aside), judged)) {
			try {
				linkSync(aside, lockPath);
			} catch {
				// the path was taken again meanwhile; that holder keeps it
			}
			try {
				unlinkSync(aside);
			} catch {
				// nothing more to do
			}
			return;
		}
	} catch {
		return;
	}
	try {
		unlinkSync(aside);
	} catch {
		try {
			rmdirSync(aside);
		} catch {
			// a non-empty directory stays where it was moved to
		}
	}
}

function lockPresent(lockPath: string): boolean {
	try {
		lstatSync(lockPath);
		return true;
	} catch {
		return false;
	}
}

/** Test-only seam: runs between judging a lock stale and taking it over, where a rival waiter could act. */
export interface ExcludeLockHooks {
	afterStaleJudgement?: () => void;
	/** Overrides the wait (milliseconds); production uses LOCK_WAIT_MS. */
	waitMs?: number;
	/** Test-only: replaces the rename that moves a stale lock aside. */
	rename?: (from: string, to: string) => void;
	/** Test-only: replaces the pause between tries. */
	sleep?: (ms: number) => void;
}

/**
 * Takes the exclusive lock, or returns null once the wait is over. The caller
 * releases it with the returned function. The deadline is checked on every
 * pass, including after a takeover, so no kind of lock file can make this spin.
 */
export function acquireExcludeLock(dir: string, hooks: ExcludeLockHooks = {}): (() => void) | null {
	const lockPath = join(dir, LOCK_FILE_NAME);
	const deadline = Date.now() + (hooks.waitMs ?? LOCK_WAIT_MS);
	while (true) {
		try {
			const fd = openSync(
				lockPath,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
				0o600,
			);
			try {
				writeSync(fd, `${process.pid}\n`);
			} finally {
				closeSync(fd);
			}
			return () => {
				try {
					unlinkSync(lockPath);
				} catch {
					// already gone — nothing to release.
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		const stale = judgeStale(lockPath);
		let freed = false;
		if (stale) {
			hooks.afterStaleJudgement?.();
			takeOverStaleLock(lockPath, stale, hooks.rename ?? renameSync);
			freed = !lockPresent(lockPath);
		}
		if (Date.now() >= deadline) return null;
		// Pause unless the takeover just freed the path: a lock that can't be moved
		// aside must not turn the wait into a busy loop.
		if (!freed) (hooks.sleep ?? sleepMs)(LOCK_POLL_MS);
	}
}

/**
 * Adds `dirArg` (as the user typed it) to the rules file under `home`.
 * Never throws for an expected refusal; returns the reason instead.
 */
export function addExcludeRule(home: string, dirArg: string): AddRuleResult {
	// path.resolve() lexically collapses "." / ".." itself, so the check has
	// to run against the ARGUMENT as written, before resolution. "." alone is
	// the one explicit exception ("add ." resolves the cwd); any OTHER
	// embedded "."/".." segment is refused the same way a rule line
	// containing one is (exclude-rules.ts).
	if (dirArg !== "." && dirArg.split(/[\\/]/).some((s) => s === "." || s === "..")) {
		return refused(
			`"${dirArg}" contains a '.'/'..' segment; write the directory's resolved path instead (e.g. ${resolve(dirArg)}).`,
		);
	}
	const resolved = resolve(dirArg);
	const nameProblem = unwritableNameReason(resolved);
	if (nameProblem) return refused(`${nameProblem} (${JSON.stringify(resolved)}).`);

	// Load and validate the existing rules file FIRST — an already-invalid
	// file is refused outright, unchanged, never silently appended to.
	const dirResult = resolveAgentpulseDirForWrite(home);
	if (!dirResult.ok) return refused(dirResult.message);
	const path = join(dirResult.dir, EXCLUDE_FILE_NAME);

	const release = acquireExcludeLock(dirResult.dir);
	if (!release) {
		return refused(
			`another \`agentpulse exclude add\` is in progress (lock file ${join(dirResult.dir, LOCK_FILE_NAME)}); try again in a moment. If none is running, delete that file.`,
		);
	}
	try {
		const existingLoaded = loadExcludeRules(home);
		if (existingLoaded.state === "invalid") {
			return refused(
				`the rules file is already invalid${existingLoaded.line !== undefined ? ` (line ${existingLoaded.line})` : ""}: ${existingLoaded.reason}. Fix it directly before adding a new rule.`,
			);
		}

		const fileCheck = checkRulesFileForWrite(path);
		if (!fileCheck.ok) return refused(fileCheck.message);

		// The file was just loaded successfully (or does not exist yet), so it is readable; a
		// read error here is an I/O failure for the caller to report, with nothing written.
		const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";

		// Dedup by RESOLVED path — a trailing slash or a symlinked spelling of
		// the same directory must not create a duplicate rule.
		const newCanonical = canonicalDirForDedup(resolved, home);
		const alreadyPresent = existing
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"))
			.some((l) => canonicalDirForDedup(l, home) === newCanonical);
		const content = alreadyPresent
			? existing
			: `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${resolved}\n`;

		if (!alreadyPresent) {
			const parsed = parseExcludeRulesContent(content, home);
			if (parsed.invalidLine) {
				return refused(
					`the rules file would be invalid after adding ${JSON.stringify(resolved)} (line ${parsed.invalidLine.line}): ${parsed.invalidLine.message}. Nothing was written.`,
				);
			}
		}

		// Atomic write (temp file in the same directory, fsync, rename over
		// the target) — never truncate-then-write in place, which leaves the
		// file empty if the process dies in between.
		writePrivateFileAtomicNoFollow(path, content);
		setInvalidMarker(home, false);
		return { status: alreadyPresent ? "present" : "added", path, rule: resolved };
	} finally {
		release();
	}
}
