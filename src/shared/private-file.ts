/**
 * F207: a symlink-safe, private-mode (0600) synchronous file writer for
 * secret-bearing files (currently ~/.agentpulse/hook-auth-header, written
 * by bin/cli.ts's `setup` command).
 *
 * Ported from scripts/relay.ts's openPrivateNoFollow/writePrivateFile
 * (F203) — same TOCTOU-closing pattern (lstat, refuse a symlink or
 * non-regular file, open with O_NOFOLLOW, verify the opened handle is
 * still the file lstat saw, fchmod the *handle* rather than chmod-by-path
 * after the fact), adapted to `node:fs`'s synchronous API since
 * bin/cli.ts's setup() flow is otherwise entirely sync. relay.ts keeps
 * its own copy rather than importing this: it's self-contained by design
 * (only `node:` builtins) so it still runs from a single copied file on a
 * machine without the repo.
 */
import {
	constants,
	closeSync,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	openSync,
	writeSync,
} from "node:fs";

export const PRIVATE_FILE_MODE = 0o600;

// O_NOFOLLOW is POSIX-only; on platforms without it the lstat check still runs.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

type LstatKind = "file" | "symlink" | "hardlink" | "other" | "missing";

function lstatKindSync(path: string): LstatKind {
	try {
		const st = lstatSync(path);
		if (st.isSymbolicLink()) return "symlink";
		if (!st.isFile()) return "other";
		return st.nlink > 1 ? "hardlink" : "file";
	} catch {
		return "missing";
	}
}

type FileIdentity = { dev: number; ino: number; nlink: number; isFile: () => boolean };

function assertSameFileSync(path: string, seen: FileIdentity, opened: FileIdentity) {
	if (seen.dev !== opened.dev || seen.ino !== opened.ino || !opened.isFile() || opened.nlink > 1) {
		throw new Error(`file changed while opening: ${path}`);
	}
}

/**
 * Writes `content` to `path`, refusing to follow a symlink or write
 * through a non-regular file at the final path component, and enforces
 * PRIVATE_FILE_MODE (0600) on the actually-opened file descriptor
 * (fchmod), not by a separate path-based chmod after the write — closing
 * the TOCTOU gap a `writeFileSync(path, content, {mode}) + no follow-up
 * chmod` pattern leaves open (the create-mode only applies when the call
 * creates the file, and a bare `writeFileSync` follows an existing
 * symlink at `path`).
 */
export function writePrivateFileSyncNoFollow(path: string, content: string): void {
	const kind = lstatKindSync(path);
	if (kind !== "file" && kind !== "missing") {
		throw new Error(`refusing to write through ${kind}: ${path}`);
	}
	const seen = kind === "file" ? lstatSync(path) : null;
	// A file that appears after lstat said "missing" makes open fail
	// (EEXIST) instead of being written through (mirrors relay.ts F154).
	const createFlags = kind === "missing" ? constants.O_CREAT | constants.O_EXCL : 0;
	const fd = openSync(path, constants.O_WRONLY | createFlags | O_NOFOLLOW, PRIVATE_FILE_MODE);
	try {
		assertSameFileSync(path, seen ?? lstatSync(path), fstatSync(fd));
		ftruncateSync(fd, 0);
		writeSync(fd, content, null, "utf-8");
		fchmodSync(fd, PRIVATE_FILE_MODE);
	} finally {
		closeSync(fd);
	}
}
