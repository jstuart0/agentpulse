/**
 * Leaf helpers for reading what the supervisor keeps privately on disk: a directory only this account
 * can write into, and a plain file only this account can read or write. Used by the report gate's
 * saved state, the interactive bridge's directories and (later) the offline outbox. Imports nothing
 * from the gate, the outbox or the providers.
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { checkWindowsSecurityAt } from "../../shared/exclude-rules.js";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** An id that names one interactive bridge directory: letters, digits, `_` and `-`, 1 to 128 characters. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type DirectoryStat = { isDirectory(): boolean; uid: number; mode: number };
type FileStat = { isFile(): boolean; nlink: number; size: number; uid: number; mode: number };

/** A directory this account owns that nobody else can write into (POSIX; Windows is judged by its ACL instead). */
export function isTrustedDirectoryStat(st: DirectoryStat, uid: number | undefined): boolean {
	if (!st.isDirectory()) return false;
	if (uid !== undefined && st.uid !== uid) return false;
	return (st.mode & 0o022) === 0;
}

/** A plain file with one link, within `maxBytes`, that only this account can read or write (POSIX). */
export function isTrustedStateFileStat(
	st: FileStat,
	uid: number | undefined,
	maxBytes: number,
): boolean {
	return (
		st.isFile() &&
		st.nlink === 1 &&
		st.size <= maxBytes &&
		(uid === undefined || st.uid === uid) &&
		(st.mode & 0o077) === 0
	);
}

/** `dir` exists and is a directory only this account can write into (never a symlink). */
export function trustedDirectory(dir: string): boolean {
	try {
		const st = lstatSync(dir);
		if (process.platform === "win32")
			return st.isDirectory() && checkWindowsSecurityAt(dir) === null;
		return isTrustedDirectoryStat(st, process.getuid?.());
	} catch {
		return false;
	}
}

/** What lstat says about an entry that may hold a bridge: this user's, private, and the right kind (never a symlink). */
export function isPrivateOwnStat(
	info: Pick<Stats, "uid" | "mode" | "isSymbolicLink" | "isDirectory" | "isSocket">,
	kind: "directory" | "socket",
	uid: number | null,
): boolean {
	if (info.isSymbolicLink()) return false;
	if (kind === "directory" ? !info.isDirectory() : !info.isSocket()) return false;
	if (uid !== null && info.uid !== uid) return false;
	return (info.mode & 0o077) === 0;
}

/** True when `path` is this user's own, private entry of the given kind and not a symlink. */
export async function isPrivateOwnEntry(
	path: string,
	kind: "directory" | "socket",
): Promise<boolean> {
	try {
		const uid = typeof process.getuid === "function" ? process.getuid() : null;
		return isPrivateOwnStat(await lstat(path), kind, uid);
	} catch {
		return false;
	}
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Reads an open file as text, at most `maxBytes`: it asks for one byte more and answers null if that
 * byte arrives, so a file that grew after its size was checked is rejected rather than read whole.
 */
export function readBoundedText(fd: number, maxBytes: number): string | null {
	const buffer = Buffer.alloc(maxBytes + 1);
	let length = 0;
	while (length < buffer.length) {
		const got = readSync(fd, buffer, length, buffer.length - length, null);
		if (got === 0) break;
		length += got;
	}
	return length > maxBytes ? null : buffer.toString("utf-8", 0, length);
}

export type PrivateFileRead =
	| { kind: "absent" }
	| { kind: "untrusted"; why: string }
	| { kind: "ok"; text: string };

/**
 * Reads a private file: nothing there, a file this account owns privately (its text), or something not
 * to be believed. The directory must be private, the path is opened without following a symlink, and the
 * file must be a plain single-link file of at most `maxBytes` that only this account can read or write.
 * A file in a directory others can write into is untrusted; no file there is simply absent.
 */
export function readPrivateFileNoFollow(path: string, maxBytes: number): PrivateFileRead {
	const dir = dirname(path);
	try {
		lstatSync(dir);
	} catch (error) {
		return isMissing(error)
			? { kind: "absent" }
			: { kind: "untrusted", why: "its directory cannot be inspected" };
	}
	if (!trustedDirectory(dir)) {
		try {
			lstatSync(path);
		} catch (error) {
			return isMissing(error)
				? { kind: "absent" }
				: { kind: "untrusted", why: "its directory is not private to this account" };
		}
		return { kind: "untrusted", why: "its directory is not private to this account" };
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		return isMissing(error)
			? { kind: "absent" }
			: { kind: "untrusted", why: "it cannot be opened as a plain file" };
	}
	try {
		const st = fstatSync(fd);
		const trusted =
			process.platform === "win32"
				? st.isFile() && st.nlink === 1 && st.size <= maxBytes
				: isTrustedStateFileStat(st, process.getuid?.(), maxBytes);
		if (!trusted)
			return { kind: "untrusted", why: "it is not a private plain file of this account" };
		const text = readBoundedText(fd, maxBytes);
		return text === null
			? { kind: "untrusted", why: "it is larger than allowed" }
			: { kind: "ok", text };
	} catch {
		return { kind: "untrusted", why: "it could not be read" };
	} finally {
		closeSync(fd);
	}
}
