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
 *
 * F232 (xander, Medium): bin/cli.ts's Codex/Copilot hooks.json writes (and
 * their timestamped backups) used a plain writeFileSync, which follows a
 * symlink at the destination exactly like a bare `>` redirect in bash —
 * the same class of bug F207 already closed for hook-auth-header.
 * writeConfigFileSyncNoFollow reuses the identical TOCTOU-safe mechanism
 * but at PRIVATE_FILE_MODE's non-secret sibling, CONFIG_FILE_MODE (0644):
 * hooks.json isn't a secret — Codex/Copilot themselves need to read it —
 * so locking it to 0600 would just break the tool it's configuring.
 *
 * AGEN-21 (Medium, security): ~/.agentpulse/supervisor.json — the local
 * supervisor's own config, holding its `aps_...` credential and/or
 * enrollment token — was written with `Bun.write` (no explicit mode, no
 * symlink refusal), leaving it at the OS-default create mode (0644 under a
 * typical umask): any local user could read the credential and act as that
 * supervisor. src/supervisor/config.ts's saveSupervisorConfig now routes
 * through writePrivateFileSyncNoFollow like every other secret file here.
 * tightenPrivateFilePermissionsSync (below) additionally self-heals an
 * existing over-permissive file at supervisor startup, for installs that
 * predate this fix.
 */
import { execFileSync } from "node:child_process";
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
import { dirname } from "node:path";

export const PRIVATE_FILE_MODE = 0o600;
export const CONFIG_FILE_MODE = 0o644;

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
 * `mode` on the actually-opened file descriptor (fchmod), not by a
 * separate path-based chmod after the write — closing the TOCTOU gap a
 * `writeFileSync(path, content, {mode}) + no follow-up chmod` pattern
 * leaves open (the create-mode only applies when the call creates the
 * file, and a bare `writeFileSync` follows an existing symlink at `path`).
 *
 * F241 (xander, re-verify): O_NOFOLLOW only guards the FINAL path
 * component — it doesn't stop `path`'s parent directory itself being a
 * symlink (e.g. ~/.agentpulse replaced with a symlink to /etc), which
 * O_NOFOLLOW transparently traverses. Checked explicitly here, matching
 * the bash (`ap_write_no_follow`'s dirname check) and PowerShell
 * (`Write-ApFileNoFollow`'s Test-ApReparsePoint on the parent) versions.
 */
function writeFileSyncNoFollow(path: string, content: string, mode: number): void {
	const parent = dirname(path);
	if (lstatKindSync(parent) === "symlink") {
		throw new Error(`refusing to write into a symlinked directory: ${parent}`);
	}
	const kind = lstatKindSync(path);
	if (kind !== "file" && kind !== "missing") {
		throw new Error(`refusing to write through ${kind}: ${path}`);
	}
	const seen = kind === "file" ? lstatSync(path) : null;
	// A file that appears after lstat said "missing" makes open fail
	// (EEXIST) instead of being written through (mirrors relay.ts F154).
	const createFlags = kind === "missing" ? constants.O_CREAT | constants.O_EXCL : 0;
	const fd = openSync(path, constants.O_WRONLY | createFlags | O_NOFOLLOW, mode);
	try {
		assertSameFileSync(path, seen ?? lstatSync(path), fstatSync(fd));
		ftruncateSync(fd, 0);
		writeSync(fd, content, null, "utf-8");
		fchmodSync(fd, mode);
	} finally {
		closeSync(fd);
	}
}

/**
 * Secret-bearing files (hook-auth-header, supervisor.json): 0600,
 * owner-read-only. AGEN-21: also best-effort narrows the ACL to the
 * current user on win32, where fchmod alone doesn't restrict other local
 * accounts — see tightenWindowsAclBestEffort below.
 */
export function writePrivateFileSyncNoFollow(path: string, content: string): void {
	writeFileSyncNoFollow(path, content, PRIVATE_FILE_MODE);
	tightenWindowsAclBestEffort(path);
}

/**
 * F232: non-secret config files a CLI tool needs to read back (Codex/Copilot
 * hooks.json and their timestamped backups) — same symlink refusal and
 * TOCTOU-safe write as writePrivateFileSyncNoFollow, but at CONFIG_FILE_MODE
 * (0644) so the file stays readable by whatever reads it besides us.
 */
export function writeConfigFileSyncNoFollow(path: string, content: string): void {
	writeFileSyncNoFollow(path, content, CONFIG_FILE_MODE);
}

/**
 * AGEN-21: node's fchmodSync only flips the read-only attribute on win32 —
 * it does not narrow the ACL other local Windows accounts hold on the file.
 * Best-effort narrows the ACL to the current user only, mirroring
 * scripts/install-local.ps1's New-ApHookAuthHeaderFile (`icacls ...
 * /inheritance:r /grant:r "user:(R,W)"`). Never throws: a missing/blocked
 * icacls (non-NTFS volume, policy restriction, missing USERNAME) leaves the
 * POSIX-style fchmod already applied as the fallback, matching every other
 * best-effort Windows check in this codebase (see install-local.ps1's
 * Test-ApMultipleHardLinks). No-op on non-Windows platforms.
 */
function tightenWindowsAclBestEffort(path: string): void {
	if (process.platform !== "win32") return;
	const username = process.env.USERNAME || process.env.USER;
	if (!username) return;
	try {
		execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${username}:(R,W)`], {
			stdio: "ignore",
		});
	} catch {
		// best-effort — see comment above.
	}
}

export type TightenPermissionsResult =
	| { tightened: true; previousMode: number }
	| { tightened: false; reason: "missing" | "symlink" | "not-a-file" | "already-private" };

/**
 * AGEN-21: idempotent startup guard for an existing secret-bearing file
 * (currently ~/.agentpulse/supervisor.json, which holds the supervisor
 * credential / enrollment token). Older installs — and any writer that
 * predates routing through writePrivateFileSyncNoFollow — may have left the
 * file at the OS-default create mode (0644 under a typical umask),
 * world-readable. Call this once at process startup, before reading the
 * file: narrows an over-permissive file in place via fchmod on a no-follow-
 * opened handle (never a path-based chmod, which would follow a symlink
 * swapped in between the permission check and the chmod).
 *
 * Never follows a symlink at `path` — refused (not chmod'd, not thrown; the
 * caller decides what to log), target left untouched. A missing path (fresh
 * install — writePrivateFileSyncNoFollow always creates at 0600 already) or
 * an already-private file is a silent no-op, both reported via `reason` so
 * a caller can choose not to log routine cases.
 */
export function tightenPrivateFilePermissionsSync(path: string): TightenPermissionsResult {
	const kind = lstatKindSync(path);
	if (kind === "missing") return { tightened: false, reason: "missing" };
	if (kind === "symlink") return { tightened: false, reason: "symlink" };
	if (kind === "other") return { tightened: false, reason: "not-a-file" };

	const seen = lstatSync(path);
	const previousMode = seen.mode & 0o777;
	if ((previousMode & 0o077) === 0) {
		tightenWindowsAclBestEffort(path);
		return { tightened: false, reason: "already-private" };
	}

	const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (seen.dev !== opened.dev || seen.ino !== opened.ino) {
			throw new Error(`file changed while opening: ${path}`);
		}
		fchmodSync(fd, PRIVATE_FILE_MODE);
	} finally {
		closeSync(fd);
	}
	tightenWindowsAclBestEffort(path);
	return { tightened: true, previousMode };
}
