/**
 * Leaf helpers for reading what the supervisor keeps privately on disk: a directory only this account
 * can write into, and a plain file only this account can read or write. Used by the report gate's
 * saved state, the interactive bridge's directories and (later) the offline outbox. Imports nothing
 * from the gate, the outbox or the providers.
 */
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

export {
	type PrivateFileRead,
	isTrustedDirectoryStat,
	isTrustedStateFileStat,
	readBoundedText,
	readPrivateFileNoFollow,
	trustedDirectory,
} from "../../shared/private-read.js";

/** An id that names one interactive bridge directory: letters, digits, `_` and `-`, 1 to 128 characters. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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
