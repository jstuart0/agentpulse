/**
 * The installed exclusion check on disk: `~/.agentpulse/exclude-check.sh`.
 * Node-only (filesystem, process), so it is imported by the CLI alone, never
 * by the web bundle or the hook-command generators.
 *
 *  - installExcludeScript writes (or refreshes) it: atomic, never through a
 *    link, mode 0500, creating `~/.agentpulse` 0700 when it is absent and
 *    never loosening one that exists. A directory that isn't ours to write
 *    into is refused with a message, not worked around.
 *  - inspectExcludeScript says whether the installed copy is current, stale
 *    (written by another version), missing, or untrusted (the very test the
 *    hook command applies before running it: a regular file, not a link,
 *    owned by the user, not group/world-writable, in a directory with the
 *    same properties).
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentpulseDirForWrite } from "./exclude-rules-write.js";
import { checkWindowsSecurityAt } from "./exclude-rules.js";
import {
	buildBashExcludeScript,
	buildPowerShellExcludeScript,
	excludeScriptHeaderHash,
} from "./hook-command.js";
import { EXCLUDE_SCRIPT_PS_RELATIVE_PATH, EXCLUDE_SCRIPT_RELATIVE_PATH } from "./hook-headers.js";
import { writeExecutableFileAtomicNoFollow } from "./private-file.js";

/** Which installed check: the POSIX shell one, or its PowerShell twin (the Windows hooks run that one). */
export type ExcludeScriptKind = "sh" | "ps1";

const SCRIPT_RELATIVE_PATHS: Record<ExcludeScriptKind, string> = {
	sh: EXCLUDE_SCRIPT_RELATIVE_PATH,
	ps1: EXCLUDE_SCRIPT_PS_RELATIVE_PATH,
};

const scriptFileName = (kind: ExcludeScriptKind): string =>
	SCRIPT_RELATIVE_PATHS[kind].split("/")[1] as string;

const generatedScript = (kind: ExcludeScriptKind): string =>
	kind === "ps1" ? buildPowerShellExcludeScript() : buildBashExcludeScript();

export type ExcludeScriptState =
	| { state: "current"; path: string }
	| { state: "stale"; path: string; installedHash: string | null }
	| { state: "missing"; path: string }
	| { state: "untrusted"; path: string; reason: string };

/** Where the script lives for `home`, without resolving anything. */
export function excludeScriptPath(home: string, kind: ExcludeScriptKind = "sh"): string {
	return join(home, SCRIPT_RELATIVE_PATHS[kind]);
}

/** The state of the installed script against what this version generates. Never throws. */
export function inspectExcludeScript(
	home: string,
	expectedText?: string,
	kind: ExcludeScriptKind = "sh",
): ExcludeScriptState {
	const expected = expectedText ?? generatedScript(kind);
	const path = excludeScriptPath(home, kind);
	// Inspecting must never create anything: an absent directory is a missing
	// script (the writer below is what creates it).
	try {
		lstatSync(join(home, ".agentpulse"));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", path };
		return {
			state: "untrusted",
			path,
			reason: `${join(home, ".agentpulse")} could not be inspected (${code})`,
		};
	}
	const dir = resolveAgentpulseDirForWrite(home);
	if (!dir.ok) return { state: "untrusted", path, reason: dir.message };
	const real = join(dir.dir, scriptFileName(kind));
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(real);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", path };
		return { state: "untrusted", path, reason: `${real} could not be inspected (${code})` };
	}
	if (st.isSymbolicLink()) {
		return { state: "untrusted", path, reason: `${real} is a symlink` };
	}
	if (!st.isFile()) {
		return { state: "untrusted", path, reason: `${real} is not a regular file` };
	}
	if (process.platform === "win32") {
		const reason = checkWindowsSecurityAt(real);
		if (reason) return { state: "untrusted", path, reason: `${real} ${reason}` };
	} else {
		const uid = process.getuid?.();
		if (uid !== undefined && st.uid !== uid) {
			return { state: "untrusted", path, reason: `${real} is not owned by you` };
		}
		if ((st.mode & 0o022) !== 0) {
			return { state: "untrusted", path, reason: `${real} is group- or world-writable` };
		}
	}
	let installed: string;
	try {
		installed = readFileSync(real, "utf-8");
	} catch {
		return { state: "untrusted", path, reason: `${real} is unreadable` };
	}
	if (installed === expected) return { state: "current", path };
	return { state: "stale", path, installedHash: excludeScriptHeaderHash(installed) };
}

export type InstallExcludeScriptResult =
	| { status: "installed" | "current"; path: string }
	| { status: "skipped"; path: string; message: string };

/** Installs or refreshes the check. Never throws for an expected refusal (returns the reason). */
export function installExcludeScript(
	home: string,
	scriptText?: string,
	kind: ExcludeScriptKind = "sh",
): InstallExcludeScriptResult {
	const script = scriptText ?? generatedScript(kind);
	const path = excludeScriptPath(home, kind);
	let dir: ReturnType<typeof resolveAgentpulseDirForWrite>;
	try {
		dir = resolveAgentpulseDirForWrite(home);
	} catch (err) {
		return {
			status: "skipped",
			path,
			message: `could not prepare ${join(home, ".agentpulse")}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!dir.ok) return { status: "skipped", path, message: dir.message };
	const real = join(dir.dir, scriptFileName(kind));
	try {
		const st = lstatSync(real);
		if (st.isSymbolicLink() || !st.isFile()) {
			return {
				status: "skipped",
				path,
				message: `${real} is a link or not a regular file; remove it and run this again`,
			};
		}
	} catch {
		// absent: written below
	}
	if (inspectExcludeScript(home, script, kind).state === "current")
		return { status: "current", path };
	try {
		writeExecutableFileAtomicNoFollow(real, script);
	} catch (err) {
		return {
			status: "skipped",
			path,
			message: `could not write ${real}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return { status: "installed", path };
}
