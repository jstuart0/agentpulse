/**
 * The shared exclude-rules evaluator: lets a user list directories whose
 * sessions should never be reported, checked locally on their own machine
 * before anything is sent anywhere. One module, imported by the relay, the
 * supervisor and the CLI; the Codex/Copilot command-hook shim carries an
 * inline POSIX/PowerShell transcription of the same rules (a later phase),
 * proven byte-for-byte equivalent against the fixture matrix this module's
 * own tests consume.
 *
 * Threat model: these checks defend against two things — another local
 * user on the same machine, and an accidentally-misconfigured rules file
 * (wrong permissions, a stray symlink). They do NOT defend against code
 * already running as the same user: that code can already read the
 * agents' transcripts directly, so hardening the rules file against it
 * would add ceremony without adding safety. Consequences of that framing:
 *  - `~/.agentpulse` being itself a symlink is allowed (dotfile managers
 *    do this) — but whatever it resolves to must be owned by the current
 *    user and not group- or world-writable, or the result is invalid.
 *  - The rules FILE itself may never be a symlink (that one case is about
 *    the file's own identity, not about how its parent directory is
 *    reached).
 *
 * Invariants, enforced throughout this file:
 *  - never throws, for any input, including a rules file this process
 *    can't read or a cwd string containing bytes a real filesystem path
 *    never would;
 *  - an invalid rules file always evaluates to excluded (fail closed) —
 *    callers never need a separate "is this safe to forward" check beyond
 *    evaluateExclusion's own result;
 *  - loading the file touches it exactly once as a sequence (one lstat to
 *    reject a symlink at the final path component, one open, one fstat on
 *    the opened descriptor, one read from that same descriptor — never a
 *    second open or a second read), with the opened descriptor's identity
 *    (device + inode) checked against the initial lstat so a file swapped
 *    in between is caught rather than silently read. Path *resolution*
 *    (for rule directories and for the cwd being matched) is a different,
 *    bounded-but-not-fixed cost: each resolution may retry `realpath`
 *    against shrinking ancestors, bounded by the path's own depth.
 *
 * Deliberately NOT this module's job (owned by the caller instead):
 *  - stickiness (once a session is excluded, it stays excluded for its
 *    lifetime even if a later event's cwd doesn't match);
 *  - caching/reload-on-change (callers decide when to call loadExcludeRules
 *    again);
 *  - resolving a session id to a cwd when the current event carries none.
 *
 * Deliberately out of scope for the rules file's line syntax: an inline
 * `# comment` after a path (a path may legitimately contain a literal
 * ` #`, so there's no unambiguous way to tell them apart) and a rules file
 * using a bare CR as its line ending (only `\n` and `\r\n` are
 * recognised). Neither is validated against; a path containing either
 * shape is treated as the path it looks like. A later phase warns when a
 * rule's directory doesn't exist on disk at write time.
 *
 * `.`/`..` segments are handled asymmetrically, on purpose. A RULE line
 * containing either is rejected outright (invalid line) rather than
 * resolved: resolving `..` lexically, before any symlink in the path is
 * followed, can disagree with what the kernel actually does — given
 * `~/a/link` → `~/b/c`, the rule `~/a/link/../x` would lexically become
 * `~/a/x`, silently protecting nothing, when the real (kernel) target is
 * `~/b/x`. Asking the user to write the already-resolved path removes the
 * ambiguity instead of trying to out-think the kernel. A CWD containing
 * `.`/`..` is resolved with `realpath` of the whole string in one call —
 * the kernel's own answer — and treated as unknown (`no_cwd`) if that
 * fails; this is safe because a real process's cwd always exists.
 */
import { execFileSync } from "node:child_process";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	EXCLUDE_INVALID_MARKER_RELATIVE_PATH,
	EXCLUDE_MAX_RULES,
	EXCLUDE_RULES_RELATIVE_PATH,
	SKIP_HEADER_MAX_LENGTH,
} from "./hook-headers.js";

export const MAX_RULES_FILE_BYTES = 64 * 1024;

/**
 * A working directory longer than this (in characters) is treated as unknown,
 * exactly like no cwd at all. Real paths are bounded by the operating system's
 * path limit, but a hook payload's cwd is data anyone local can post: matching
 * a multi-megabyte one walks every parent directory and would stall a
 * long-running evaluator. The shell and PowerShell checks take the process's
 * own working directory, which can never be this long.
 */
export const MAX_CWD_LENGTH = 4096;

/** `agentpulse exclude list` and `exclude check` warn above this many rules: every hook event evaluates the whole file. */
export const RULES_COUNT_WARNING_THRESHOLD = 50;

/** The one plain-words warning both commands print for a long rule list, or null when the count is fine. */
export function rulesCountWarning(count: number): string | null {
	if (count <= RULES_COUNT_WARNING_THRESHOLD) return null;
	return `warning: ${count} rules; more than ${RULES_COUNT_WARNING_THRESHOLD} rules is slow: every hook event checks every rule, so a long list costs CPU on every event. Prefer one parent directory over many sibling directories.`;
}

/**
 * A rules file under the account's own home directory that this process never
 * looks at, because it runs with another HOME (a service manager, `sudo -E`, a
 * wrapper that sets HOME): the evaluators then see no rules and report
 * everything, which is the opposite of what the user asked. Returns one sentence
 * naming both directories when that is the situation, otherwise null. It changes
 * nothing: only the process's own local log and `agentpulse exclude check` say it.
 */
export function homeMismatchWarning(
	usedHome: string | undefined,
	accountHome: string | undefined,
): string | null {
	if (!usedHome || !accountHome) return null;
	try {
		if (sameHomeDirectory(usedHome, accountHome)) return null;
		const rulesPath = join(accountHome, EXCLUDE_RULES_RELATIVE_PATH);
		lstatSync(rulesPath);
		return `The exclude rules in ${rulesPath} are not being applied: this process uses ${usedHome} as its home (HOME), not ${accountHome}. Run it with HOME=${accountHome}, or move the rules to ${join(usedHome, EXCLUDE_RULES_RELATIVE_PATH)}.`;
	} catch {
		return null;
	}
}

/** The same directory under another spelling: a trailing separator, a symlink to it. */
function sameHomeDirectory(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}
const WILDCARD_CHARS_RE = /[*?[\]]/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const SKIP_ALLOWLIST = new Set(["1", "true", "yes", "on"]);
const SKIP_TRIM_RE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
/** Matches a drive root in its canonical resolved form — ALWAYS with the trailing separator ("c:/"), never the bare "c:" a splitter bug once produced (that bare form means "current directory on drive C" to Windows, not the root). */
const WINDOWS_DRIVE_ROOT_RE = /^[a-z]:\/$/i;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** The minimal stat surface this module needs — a real `fs.Stats` already satisfies it structurally, and a test can hand-build a plain object with the same shape. */
export interface StatLike {
	dev: number;
	ino: number;
	nlink: number;
	uid: number;
	mode: number;
	size: number;
	mtimeMs: number;
	isSymbolicLink(): boolean;
	isFile(): boolean;
	isDirectory(): boolean;
}

/**
 * Every field optional and independently overridable, defaulting to the
 * real `node:fs` call — a test overrides just the one function it needs
 * (e.g. `getuid` alone, to simulate a foreign-owned file with no root
 * privileges) while every other call still touches the real filesystem.
 */
export interface ExcludeRulesFsProvider {
	lstat?(path: string): StatLike;
	open?(path: string): number;
	fstat?(fd: number): StatLike;
	readFd?(fd: number): string;
	close?(fd: number): void;
	getuid?(): number | undefined;
	realpath?(path: string): string;
}

type ResolvedProvider = Required<ExcludeRulesFsProvider>;

const defaultProvider: ResolvedProvider = {
	lstat: (path) => lstatSync(path),
	open: (path) => openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW),
	fstat: (fd) => fstatSync(fd),
	readFd: (fd) => readFileSync(fd, "utf-8"),
	close: (fd) => closeSync(fd),
	getuid: () => process.getuid?.(),
	realpath: (path) => realpathSync.native(path),
};

export function mergeProvider(provider: ExcludeRulesFsProvider): ResolvedProvider {
	return {
		lstat: provider.lstat ?? defaultProvider.lstat,
		open: provider.open ?? defaultProvider.open,
		fstat: provider.fstat ?? defaultProvider.fstat,
		readFd: provider.readFd ?? defaultProvider.readFd,
		close: provider.close ?? defaultProvider.close,
		getuid: provider.getuid ?? defaultProvider.getuid,
		realpath: provider.realpath ?? defaultProvider.realpath,
	};
}

/** The two calls that tell whether the rules file (or the directory holding it) changed; replaceable so a test can count them. */
export type ExcludeProbeFs = {
	statSync: (path: string) => { dev: number; ino: number; mode: number; uid: number };
	lstatSync: (path: string) => {
		dev: number;
		ino: number;
		mode: number;
		uid: number;
		nlink: number;
		size: number;
		mtimeMs: number;
	};
};

/**
 * What changes when the rules (or the directory holding them) change: the
 * directory's identity, mode and owner, and the rules file's identity, mode,
 * owner, link count, size and mtime. Two cheap calls and no read, so a
 * long-running evaluator can ask on every event and parse the file only when
 * the answer differs from the last one.
 */
export function excludeRulesSignature(
	home: string,
	fs: ExcludeProbeFs = { statSync, lstatSync },
): string {
	const code = (err: unknown) => (err as { code?: string }).code ?? "ERR";
	const rulesPath = join(home, EXCLUDE_RULES_RELATIVE_PATH);
	const dirPath = dirname(rulesPath);
	let dirPart: string;
	try {
		const st = fs.statSync(dirPath);
		dirPart = `d:${st.dev}:${st.ino}:${st.mode}:${st.uid}`;
	} catch (err) {
		dirPart = `d!${code(err)}`;
		try {
			fs.lstatSync(dirPath);
			dirPart += ":link";
		} catch {}
		return dirPart;
	}
	try {
		const st = fs.lstatSync(rulesPath);
		return `${dirPart}|f:${st.dev}:${st.ino}:${st.mode}:${st.uid}:${st.nlink}:${st.size}:${st.mtimeMs}`;
	} catch (err) {
		return `${dirPart}|f!${code(err)}`;
	}
}

export interface ExcludeRule {
	/** 1-based line number in the rules file, for display and for exclude-check-style tooling. */
	line: number;
	/** The rule exactly as the user wrote it (after normalisation, before `~` expansion). */
	raw: string;
	/** The physically resolved form — see resolvePhysicalPath's docstring. */
	resolved: string;
}

export interface LoadExcludeRulesResult {
	state: "none" | "ok" | "invalid";
	rules: ExcludeRule[];
	/** Set only for "invalid" — a complete, user-actionable message, not a bare code. */
	reason?: string;
	/** Set only for "invalid", when a single line is at fault. */
	line?: number;
	/** File mode (lowest 9 bits), when a file exists. */
	mode?: number;
	mtimeMs?: number;
	/** Where the rules file really lives, after resolving any symlink on its parent directory — for exclude-check-style tooling to print. Set whenever the file exists (state "ok" or "invalid" from the file itself, not from a directory-level problem). */
	resolvedPath?: string;
}

export type ExcludeDecisionReason = "env" | "path" | "rules_invalid" | "no_cwd" | null;

export interface EvaluateExclusionInput {
	/** The session's working directory, or null/undefined when it couldn't be determined. An empty string or a relative path is treated the same as "couldn't be determined". */
	cwd: string | null | undefined;
	/** The raw AGENTPULSE_SKIP value (env var or header), unparsed — isSkipValue decides. */
	skip: string | null | undefined;
	rules: LoadExcludeRulesResult;
	/** The case rule to apply (see normalizeForCompare); defaults to the host's. Lets every branch run under test on any host. */
	platform?: NodeJS.Platform;
}

export interface EvaluateExclusionResult {
	excluded: boolean;
	reason: ExcludeDecisionReason;
	/** The matched rule, as the user wrote it. Set only when reason is "path". */
	rule?: string;
	/** The matched rule's line number. Set only when reason is "path". */
	line?: number;
}

/**
 * Fixture-matrix row shape (src/shared/__fixtures__/exclude-cases.json),
 * shared with this module's own test so a future edit to one can't drift
 * from the other silently. `dedicated: true` marks a case whose real
 * behavior needs on-disk construction a declarative row can't express
 * (a symlink, a specific permission bit, a Windows ACL) and is asserted by
 * a dedicated test instead of a generic, data-driven loop.
 */
export interface ExcludeFixtureCase {
	name: string;
	platform: "any" | "darwin" | "linux" | "win32" | "posix";
	home?: string;
	cwd?: string | null;
	rulesFileLines?: string[];
	rulesFileLinesRaw?: string;
	skip?: string;
	expectedSkip?: boolean;
	expected: { excluded: boolean; reason: ExcludeDecisionReason };
	expectedLine?: number;
	dedicated?: boolean;
	/** The cwd is data a hook payload can carry (any length); a real process can't start in it, so the shell and PowerShell runners never run this row. */
	dataCwdOnly?: boolean;
	skippable?: boolean;
}

/**
 * Skip only for these values, case-insensitive, after trimming surrounding
 * space, tab, CR and LF — exactly that set, in every evaluator (the shell
 * and PowerShell snippets can't trim more without a program). Everything
 * else — including an unset or whitespace-only value, one wrapped in form
 * feed, vertical tab, NBSP or a BOM, or a literal, unexpanded
 * `$AGENTPULSE_SKIP` — is "not set".
 */
export function isSkipValue(value: string | null | undefined): boolean {
	if (!value) return false;
	const trimmed = value.replace(SKIP_TRIM_RE, "");
	if (!trimmed) return false;
	return SKIP_ALLOWLIST.has(trimmed.toLowerCase());
}

/**
 * The skip header's form of isSkipValue, for the relay and the server: a
 * header is untrusted input, so a value longer than SKIP_HEADER_MAX_LENGTH is
 * "not set" without being looked at. Every other rule is isSkipValue's.
 */
export function isSkipHeaderValue(value: string | null | undefined): boolean {
	if (typeof value !== "string" || value.length > SKIP_HEADER_MAX_LENGTH) return false;
	return isSkipValue(value);
}

export function loadExcludeRules(
	home: string,
	provider: ExcludeRulesFsProvider = {},
): LoadExcludeRulesResult {
	const p = mergeProvider(provider);
	const path = join(home, EXCLUDE_RULES_RELATIVE_PATH);
	const dirPath = dirname(path);
	const currentUid = p.getuid();

	let realDir: string;
	try {
		realDir = p.realpath(dirPath);
	} catch (err) {
		if (isNotFound(err)) {
			// realpath fails "not found" for a link whose target is missing as
			// well as for a path that isn't there; only the second is "no rules".
			if (isDanglingLink(dirPath, p)) {
				return {
					state: "invalid",
					rules: [],
					reason: "the .agentpulse path is a link that points nowhere",
				};
			}
			return { state: "none", rules: [] };
		}
		return { state: "invalid", rules: [], reason: "could not resolve the .agentpulse directory" };
	}

	// Only "not found" means "no rules". The file is looked up before the
	// directory is judged, so an untrusted directory with no rules file is
	// still "none" (the shell never lists such a directory either), while
	// any other lookup failure — an unsearchable directory, an I/O error —
	// is invalid, never silently "none".
	const resolvedPath = join(realDir, "exclude");
	let initialLstat: StatLike;
	try {
		initialLstat = p.lstat(path);
	} catch (err) {
		if (isNotFound(err)) return { state: "none", rules: [] };
		return {
			state: "invalid",
			rules: [],
			reason: "the rules file could not be looked up (is the .agentpulse directory searchable?)",
		};
	}

	let dirStat: StatLike;
	try {
		dirStat = p.lstat(realDir);
	} catch {
		return { state: "invalid", rules: [], reason: "could not inspect the .agentpulse directory" };
	}
	if (!dirStat.isDirectory()) {
		return { state: "invalid", rules: [], reason: "the .agentpulse path is not a directory" };
	}
	if (process.platform === "win32") {
		const windowsDirReason = checkWindowsSecurityAt(realDir);
		if (windowsDirReason) {
			return {
				state: "invalid",
				rules: [],
				reason: `the .agentpulse directory ${windowsDirReason}`,
			};
		}
	} else {
		if (currentUid !== undefined && dirStat.uid !== currentUid) {
			return {
				state: "invalid",
				rules: [],
				reason: "the .agentpulse directory is not owned by you",
			};
		}
		if ((dirStat.mode & 0o022) !== 0) {
			return {
				state: "invalid",
				rules: [],
				reason: "the .agentpulse directory is group- or world-writable",
			};
		}
	}

	if (initialLstat.isSymbolicLink()) {
		return invalidFile(
			"the rules file is a symlink; recreate it with `agentpulse exclude add`",
			initialLstat,
			resolvedPath,
		);
	}

	let fd: number;
	try {
		fd = p.open(path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") {
			return invalidFile("the rules file is unreadable", initialLstat, resolvedPath);
		}
		return invalidFile(
			"the rules file changed while it was being opened",
			initialLstat,
			resolvedPath,
		);
	}

	try {
		const opened = p.fstat(fd);
		if (opened.dev !== initialLstat.dev || opened.ino !== initialLstat.ino) {
			return invalidFile("the rules file changed while it was being opened", opened, resolvedPath);
		}
		if (!opened.isFile()) {
			return invalidFile("the rules file is not a regular file", opened, resolvedPath);
		}
		if (opened.nlink > 1) {
			return invalidFile(
				"the rules file is a hardlink; recreate it with `agentpulse exclude add`",
				opened,
				resolvedPath,
			);
		}

		if (process.platform === "win32") {
			const windowsReason = checkWindowsRulesFileSecurity(path, p, initialLstat);
			if (windowsReason) {
				return invalidFile(`the rules file ${windowsReason}`, opened, resolvedPath);
			}
		} else {
			if (currentUid !== undefined && opened.uid !== currentUid) {
				return invalidFile(
					"the rules file is not owned by you; recreate it with `agentpulse exclude add`",
					opened,
					resolvedPath,
				);
			}
			if ((opened.mode & 0o022) !== 0) {
				return invalidFile(
					"the rules file is group- or world-writable; run `chmod 600` on it, or recreate it with `agentpulse exclude add`",
					opened,
					resolvedPath,
				);
			}
		}

		if (opened.size > MAX_RULES_FILE_BYTES) {
			return invalidFile("the rules file is larger than 64 KiB", opened, resolvedPath);
		}

		let content: string;
		try {
			content = p.readFd(fd);
		} catch {
			return invalidFile("the rules file is unreadable", opened, resolvedPath);
		}

		const parsed = parseRulesContent(content, home, p);
		if (parsed.invalidLine) {
			return invalidFile(parsed.invalidLine.message, opened, resolvedPath, parsed.invalidLine.line);
		}
		if (parsed.rules.length === 0) {
			return { state: "none", rules: [] };
		}
		return {
			state: "ok",
			rules: parsed.rules,
			mode: opened.mode & 0o777,
			mtimeMs: opened.mtimeMs,
			resolvedPath,
		};
	} finally {
		p.close(fd);
	}
}

/** True when `path` is itself a symbolic link (whatever it points at): called only after realpath said "not found", so the link's target is what's missing. */
function isDanglingLink(path: string, p: ResolvedProvider): boolean {
	try {
		return p.lstat(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** ENOENT and ENOTDIR are the two ways a path can simply not be there; anything else (EACCES, EIO, ELOOP...) means "could not tell". */
function isNotFound(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function invalidFile(
	reason: string,
	stat: StatLike,
	resolvedPath: string,
	line?: number,
): LoadExcludeRulesResult {
	return {
		state: "invalid",
		rules: [],
		reason,
		...(line !== undefined ? { line } : {}),
		mode: stat.mode & 0o777,
		mtimeMs: stat.mtimeMs,
		resolvedPath,
	};
}

export function evaluateExclusion(
	input: EvaluateExclusionInput,
	provider: ExcludeRulesFsProvider = {},
): EvaluateExclusionResult {
	const p = mergeProvider(provider);
	const { rules } = input;

	if (isSkipValue(input.skip)) {
		return { excluded: true, reason: "env" };
	}
	if (rules.state === "invalid") {
		return { excluded: true, reason: "rules_invalid" };
	}
	if (rules.state === "none") {
		return { excluded: false, reason: null };
	}

	const cwd = input.cwd;
	if (
		cwd === null ||
		cwd === undefined ||
		cwd.length === 0 ||
		cwd.length > MAX_CWD_LENGTH ||
		!isAbsolutePathForPlatform(cwd)
	) {
		return { excluded: true, reason: "no_cwd" };
	}

	let resolvedCwd: string;
	if (hasDotSegment(cwd)) {
		// A `.`/`..` segment is resolved the kernel's way — never lexically
		// (see the module docstring) — one path segment at a time, applying
		// ".." as "take the parent of what's already resolved" rather than
		// handing the whole string to realpath in one call. This isn't just
		// stylistic: a runtime's realpath can fail on a single combined
		// symlink-then-".." call even though the kernel resolves it fine
		// (observed on Bun 1.3.12 — a path like `a/link/../x`, where `link`
		// is a symlink to a directory under a different parent, throws
		// ENOENT from both realpathSync.native and the plain fs fallback; a
		// step-by-step walk, resolving one segment per call, doesn't hit it).
		// A cwd that doesn't resolve this way is unknown, not a match
		// attempt against a guessed path.
		try {
			resolvedCwd = resolveStepByStep(cwd, p);
		} catch {
			return { excluded: true, reason: "no_cwd" };
		}
	} else {
		resolvedCwd = resolvePhysicalPath(cwd, p);
	}

	const platform = input.platform ?? process.platform;
	const normalizedCwd = normalizeForCompare(resolvedCwd, platform);
	for (const rule of rules.rules) {
		const normalizedRule = normalizeForCompare(rule.resolved, platform);
		if (matchesRule(normalizedCwd, normalizedRule)) {
			return { excluded: true, reason: "path", rule: rule.raw, line: rule.line };
		}
	}
	return { excluded: false, reason: null };
}

/**
 * Turns the invalid-rules marker on or off. Returns whether the marker now
 * is in the requested state.
 *
 * The marker lives in a directory another local user may be able to write
 * to, so it is touched only when the directory itself passes the same owner
 * and mode checks the rules file needs, in either direction. Turning it ON
 * is the dangerous one: the open is create-or-open with O_NOFOLLOW and no
 * truncation, so a planted symlink (a victim file's path) is left alone and
 * no marker is written. Turning it OFF removes a stale one once the rules
 * file is gone or valid, and only from a trusted directory (an untrusted
 * directory's marker is left, and `false` says so); unlinking a link removes
 * the link, never its target. A directory that is itself the reason for
 * invalidity gets no marker at all (the event is still dropped by the
 * evaluator), and a missing directory is not created just to hold one.
 */
export function setInvalidMarker(home: string, on: boolean): boolean {
	const path = join(home, EXCLUDE_INVALID_MARKER_RELATIVE_PATH);
	const dirPath = dirname(path);
	let realDir: string;
	try {
		realDir = realpathSync.native(dirPath);
	} catch (err) {
		// No directory, so no marker to remove (and none to create).
		return on ? false : isNotFound(err);
	}
	try {
		const dirStat = lstatSync(realDir);
		if (!dirStat.isDirectory()) return !on;
		if (process.platform === "win32") {
			if (checkWindowsSecurityAt(realDir)) return false;
		} else {
			const uid = process.getuid?.();
			if (uid !== undefined && dirStat.uid !== uid) return false;
			if ((dirStat.mode & 0o022) !== 0) return false;
		}
	} catch {
		return false;
	}

	if (!on) {
		try {
			unlinkSync(join(realDir, basename(path)));
		} catch (err) {
			return isNotFound(err);
		}
		return true;
	}

	let fd: number;
	try {
		fd = openSync(
			join(realDir, basename(path)),
			fsConstants.O_WRONLY | fsConstants.O_CREAT | O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0),
			0o600,
		);
	} catch {
		return false;
	}
	try {
		return fstatSync(fd).isFile();
	} finally {
		closeSync(fd);
	}
}

export interface ParsedRulesContent {
	rules: ExcludeRule[];
	invalidLine?: { line: number; message: string };
}

/**
 * Normalisation order (fixed, must match the generated shell/PowerShell
 * snippets byte-for-byte in a later phase): strip one leading UTF-8 BOM
 * from the whole file, then per line strip a trailing CR, then trim
 * trailing spaces/tabs, then skip blank lines and `#` comments, then
 * validate what's left.
 */
function parseRulesContent(content: string, home: string, p: ResolvedProvider): ParsedRulesContent {
	const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	const rules: ExcludeRule[] = [];

	const rawLines = withoutBom.split("\n");
	for (let i = 0; i < rawLines.length; i++) {
		let line = rawLines[i];
		if (line.endsWith("\r")) line = line.slice(0, -1);
		line = line.replace(/[ \t]+$/, "");
		if (line.length === 0 || line.startsWith("#")) continue;

		const lineNo = i + 1;
		if (rules.length >= EXCLUDE_MAX_RULES) {
			return {
				rules: [],
				invalidLine: {
					line: lineNo,
					message: `more than ${EXCLUDE_MAX_RULES} rules: every hook event checks every rule, so a list this long costs CPU on every event; use one parent directory instead of many siblings`,
				},
			};
		}
		if (line.includes("\0")) {
			return {
				rules: [],
				invalidLine: { line: lineNo, message: "the line has an embedded NUL byte; remove it" },
			};
		}
		if (WILDCARD_CHARS_RE.test(line)) {
			const suggestion = stripTrailingSlash(line.replace(/[*?[\]].*$/, "")) || line;
			return {
				rules: [],
				invalidLine: {
					line: lineNo,
					message: `wildcards aren't supported. use the directory itself: ${suggestion}`,
				},
			};
		}
		if (!isAbsoluteRuleLine(line)) {
			return {
				rules: [],
				invalidLine: {
					line: lineNo,
					message: `use an absolute path (or ~/...): ${join(home, line)}`,
				},
			};
		}

		const expanded = expandTilde(line, home);
		if (hasDotSegment(expanded)) {
			return {
				rules: [],
				invalidLine: { line: lineNo, message: dotSegmentMessage(expanded, p) },
			};
		}

		rules.push({
			line: lineNo,
			raw: line,
			resolved: resolvePhysicalPath(expanded, p),
		});
	}
	return { rules };
}

/**
 * The same rules, each resolved against the filesystem as it is now. A rule's
 * resolved form is computed when the file is read, but a directory it names
 * can be created as a symlink later, or a symlink inside it retargeted; the
 * shell check resolves on every event, so a long-running evaluator that keeps
 * the parsed rules calls this on a timer to agree with it. One resolution per
 * rule (at most EXCLUDE_MAX_RULES), never a file read; a rule whose resolved
 * form did not change is returned as the same object.
 */
export function reresolveRules(
	rules: ExcludeRule[],
	home: string,
	provider: ExcludeRulesFsProvider = {},
): ExcludeRule[] {
	const p = mergeProvider(provider);
	return rules.map((rule) => {
		const resolved = resolvePhysicalPath(expandTilde(rule.raw, home), p);
		return resolved === rule.resolved ? rule : { ...rule, resolved };
	});
}

/** Runs the real rules parser over `content` — the same code loadExcludeRules applies to the file — so a caller about to write a file can ask whether it would be valid and what each line resolves to. */
export function parseExcludeRulesContent(
	content: string,
	home: string,
	provider: ExcludeRulesFsProvider = {},
): ParsedRulesContent {
	return parseRulesContent(content, home, mergeProvider(provider));
}

/** Best-effort only — this is purely to make the error message helpful; the dot-segment rejection itself never depends on whether this resolves. */
function dotSegmentMessage(expanded: string, p: ResolvedProvider): string {
	try {
		const real = p.realpath(expanded);
		return `a rule can't contain '.' or '..' segments; did you mean: ${real}`;
	} catch {
		return "a rule can't contain '.' or '..' segments; write the fully-resolved directory path instead";
	}
}

/**
 * Pure and platform-independent, so it's unit-testable from any host —
 * the shape of a Windows absolute path ("C:\..." or "C:/..."). Never
 * matches a bare drive letter ("C:", which Windows reads as "the current
 * directory on drive C", not drive C's root) or a UNC path
 * ("\\server\share\..."); both are rejected the same way an ordinary
 * relative path is.
 */
export function isWindowsAbsolutePath(line: string): boolean {
	return WINDOWS_ABSOLUTE_RE.test(line);
}

function isAbsoluteRuleLine(line: string): boolean {
	if (line === "~" || line.startsWith("~/")) return true;
	if (line.startsWith("/")) return true;
	if (process.platform === "win32" && isWindowsAbsolutePath(line)) return true;
	return false;
}

function isAbsolutePathForPlatform(p: string): boolean {
	if (p.startsWith("/")) return true;
	if (process.platform === "win32" && isWindowsAbsolutePath(p)) return true;
	return false;
}

/**
 * Plain string concatenation, deliberately never `path.join` — `join`
 * lexically collapses a `..` segment (`join("/home/alice", "../x")` ===
 * "/home/x"), which would erase a `~/../x`-style escape attempt before
 * hasDotSegment ever gets to see and reject it: a
 * rule line is validated on its EXPANDED form, so the expansion step
 * itself must not be the one place in this module that still resolves a
 * path lexically — see the module docstring for why lexical `..`
 * handling is rejected everywhere else here.
 */
function expandTilde(line: string, home: string): string {
	if (line === "~") return home;
	if (line.startsWith("~/")) return `${home}/${line.slice(2)}`;
	return line;
}

function stripTrailingSlash(p: string): string {
	if (p.length <= 1) return p;
	return p.replace(/[/\\]+$/, "");
}

const WINDOWS_DRIVE_PREFIX_RE = /^([A-Za-z]):[\\/]?/;

/**
 * Splits a path into its root prefix ("/" for a POSIX-shaped path, "C:/"
 * — WITH the trailing separator, never a bare "C:" — for a Windows-
 * drive-shaped one) and its segments, without resolving anything.
 *
 * Recognises a Windows drive letter by the STRING'S OWN SHAPE, not by
 * `process.platform` — the one upstream gate that decides whether a
 * Windows-shaped line is even valid INPUT on this host
 * (isAbsoluteRuleLine/isAbsolutePathForPlatform) still checks the real
 * host platform, exactly as before; everything downstream of that gate
 * just manipulates whatever shape of string it was handed, which is also
 * what makes this (and everything built on it) unit-testable on any host
 * via an injected provider, not only on a real Windows machine.
 */
export function splitPathForPlatform(raw: string): { prefix: string; segments: string[] } {
	const drive = WINDOWS_DRIVE_PREFIX_RE.exec(raw);
	let prefix: string;
	let rest: string;
	if (drive) {
		prefix = `${drive[1]}:/`;
		rest = raw.slice(drive[0].length);
	} else {
		prefix = "/";
		rest = raw.startsWith("/") ? raw.slice(1) : raw;
	}
	const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0);
	return { prefix, segments };
}

/** True if any path segment is exactly `.` or `..` — checked BEFORE any resolution, never resolved lexically (see the module docstring for why). */
function hasDotSegment(raw: string): boolean {
	return splitPathForPlatform(raw).segments.some((s) => s === "." || s === "..");
}

/**
 * Collapses duplicate separators as a pure string operation — never
 * touches the filesystem, and never resolves `.`/`..` (the caller must
 * have already rejected those via hasDotSegment; this function assumes
 * there are none left).
 */
export function collapseSeparators(raw: string): string {
	const { prefix, segments } = splitPathForPlatform(raw);
	const joined = segments.join("/");
	return joined === "" ? prefix : `${prefix}${joined}`;
}

/**
 * The parent of an already-collapsed (prefix + "/"-joined segments) path,
 * never the host-platform `path.dirname` — that function's separator and
 * drive-letter handling follows the REAL host OS, so on a POSIX test host
 * it would mishandle a Windows-drive-shaped string (and, independent of
 * host, naively stripping back to "C:" loses the trailing separator that
 * marks a drive root — the same bug this module had in its splitter).
 * The drive root and the POSIX root are both their own parent (can't go
 * any higher) — this is also what makes this the right primitive for both
 * `resolvePhysicalPath`'s ancestor walk and `resolveStepByStep`'s ".."
 * handling to converge on a stable fixed point at the root.
 */
export function parentOf(p: string): string {
	if (p === "/" || WINDOWS_DRIVE_ROOT_RE.test(p)) return p;
	const idx = p.lastIndexOf("/");
	if (idx < 0) return p;
	const parent = p.slice(0, idx);
	if (parent === "") return "/";
	if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`;
	return parent;
}

/**
 * Physical-path resolution for a path already known to have no `.`/`..`
 * segments (a rule, always; a cwd, only when hasDotSegment is false — see
 * evaluateExclusion): collapse duplicate separators, then resolve the
 * deepest existing ancestor through `realpath` (following any symlink on
 * the way), then append whatever remainder doesn't exist yet, verbatim.
 * This is also what makes the darwin on-disk-case assumption hold for a
 * path that fully exists, with no separate case-folding step — a
 * directory that doesn't exist (yet, or ever) keeps its as-written
 * case/form for the unresolved tail, a known and accepted limitation
 * (nothing can authoritatively resolve the case of a path that isn't
 * there).
 */
export function resolvePhysicalPath(raw: string, p: ResolvedProvider): string {
	const normalized = collapseSeparators(raw);
	let candidate = normalized;
	while (true) {
		try {
			const real = p.realpath(candidate);
			return real + normalized.slice(candidate.length);
		} catch {
			const parent = parentOf(candidate);
			if (parent === candidate) return normalized;
			candidate = parent;
		}
	}
}

/**
 * Resolves a path that MAY contain `.`/`..` segments, one segment at a
 * time, the way the kernel would: `.` is skipped, `..` takes the parent
 * of whatever's already been resolved (safe — a canonical path's parent
 * is itself canonical, no re-resolution needed), and every other segment
 * is appended and resolved through realpath individually (following a
 * symlink if that segment is one). Throws if any segment along the way
 * doesn't exist — the caller treats that as "unknown", matching that a
 * cwd with a `.`/`..` segment that doesn't fully exist can't be
 * meaningfully resolved at all.
 *
 * Deliberately never hands a multi-segment, pre-assembled string
 * containing both a symlink traversal and a `..` to a single realpath
 * call — see evaluateExclusion's call site for why.
 */
export function resolveStepByStep(raw: string, p: ResolvedProvider): string {
	const { prefix, segments } = splitPathForPlatform(raw);
	let resolved = p.realpath(prefix);
	for (const seg of segments) {
		if (seg === ".") continue;
		if (seg === "..") {
			resolved = parentOf(resolved);
			continue;
		}
		resolved = p.realpath(join(resolved, seg));
	}
	return resolved;
}

/** Shape-driven, not process.platform-gated — see splitPathForPlatform's docstring for why. */
export function isRootPath(p: string): boolean {
	return p === "/" || WINDOWS_DRIVE_ROOT_RE.test(p);
}

/** A root rule ("/" on POSIX, "C:\" on win32) excludes every path under it — including the root itself. */
export function matchesRule(normalizedCwd: string, normalizedRule: string): boolean {
	if (normalizedCwd === normalizedRule) return true;
	if (isRootPath(normalizedRule)) return normalizedCwd.startsWith(normalizedRule);
	return normalizedCwd.startsWith(`${normalizedRule}/`);
}

/**
 * Case-insensitivity policy, applied identically in this evaluator, the
 * shell snippet, and the PowerShell snippet: macOS and Windows compare
 * resolved paths case-insensitively; Linux compares case-sensitively.
 * This is a POLICY decision, not a probe of the actual filesystem (a
 * case-sensitive APFS volume or a case-sensitive exFAT mount on Windows
 * both exist) — it trades a rare false-exclusion (two real directories
 * that differ only by case, on a volume that's actually case-sensitive,
 * both reachable from the same rule) for correctness on the much more
 * common case-insensitive default and for not needing to probe the
 * filesystem's actual case sensitivity per path, which is what made the
 * old implementation need a process spawn per rule in the shell snippet.
 * Over-excluding is the safe direction for a privacy feature. A drive-
 * letter-prefixed value is unambiguously Windows-resolved by its own
 * shape, regardless of what host ran the resolution — see
 * splitPathForPlatform's docstring; any other value follows `platform`
 * (default: the host's), since nothing in its shape says which OS
 * resolved it.
 */
export function normalizeForCompare(
	p: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (WINDOWS_DRIVE_PREFIX_RE.test(p) || platform === "win32") {
		return p.replace(/\\/g, "/").toLowerCase();
	}
	if (platform === "darwin") return foldAsciiCase(p);
	return p;
}

/**
 * ASCII-only fold on macOS, deliberately: the POSIX sh snippet can only
 * fold A-Z portably (no locale-dependent `tr`, no external process), so
 * folding more here would make this evaluator and the shell disagree.
 * Non-ASCII letters that differ only by case are not folded: a documented
 * limitation, identical in every evaluator. NFC and NFD spellings of the
 * same character are a separate matter: for a directory that EXISTS, the
 * on-disk spelling is what gets compared (this module through realpath, the
 * shell through the external pwd), so both evaluators agree on macOS for an
 * existing directory. Only a rule naming a path that does not exist keeps its
 * written form, so two spellings of such a path don't match (pinned by the
 * darwin-nfc-nfd-mismatch-nonexistent-leaf fixture).
 */
function foldAsciiCase(p: string): string {
	return p.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Pure decision over already-gathered Windows security data — no I/O, so
 * it's unit-testable on every platform, which is how this module's own
 * test gives the Windows branch real coverage off a Windows machine.
 *
 * Matching is by SID, never by display name: a principal's name can be
 * localized, renamed, or coincidentally reused (a custom group literally
 * named "Administrators" is not the built-in Administrators group — only
 * its SID, `S-1-5-32-544`, says what it actually is). `SYSTEM`
 * (`S-1-5-18`) and the built-in `Administrators` group (`S-1-5-32-544`)
 * are exempt alongside the file's own owner SID: both can already do
 * anything on the machine, so excluding them would make every ordinary
 * Windows profile's file invalid. An identity that can't be translated to
 * a SID is never exempt (fail closed on uncertainty). A Deny ACE grants
 * nothing, so it's never itself a reason to fail; an inherited Allow ACE
 * is evaluated exactly like a direct one.
 */
export interface WindowsAce {
	/** The ACE's principal, as a SID string (e.g. "S-1-5-21-...-1001"), or null if it couldn't be translated. */
	principalSid: string | null;
	/** FileSystemRights as PowerShell reports it: a comma-separated list of names, or (rarely) a numeric mask. */
	rights: string;
	type: "Allow" | "Deny";
	isInherited?: boolean;
}

export interface WindowsSecurityInfo {
	ownerSid: string | null;
	aces: WindowsAce[];
}

export interface WindowsSecurityVerdict {
	valid: boolean;
	reason?: string;
}

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

/**
 * Every named FileSystemRights value that grants some form of write
 * capability (data, attributes, permissions, ownership, or delete),
 * matched exactly — no substring/regex matching, so a read-only right
 * whose name happens to contain a similar word never misfires. Read-only
 * rights that must stay valid: ReadAndExecute, Read, Synchronize (and any
 * other name not in this set).
 */
/** Exported so the PowerShell exclude snippet's own write-rights name list/mask can be asserted equal to this one in a test — they must never drift apart. */
export const WRITE_CAPABLE_RIGHT_NAMES = new Set([
	"WriteData",
	"AppendData",
	"WriteAttributes",
	"WriteExtendedAttributes",
	"WriteDac",
	"ChangePermissions",
	"WriteOwner",
	"TakeOwnership",
	"Delete",
	"DeleteSubdirectoriesAndFiles",
	"Modify",
	"FullControl",
	"Write",
	"GenericWrite",
	"GenericAll",
]);

/**
 * The numeric FileSystemRights bit value of every ATOMIC write-capable
 * right, for the rare case where .NET's Flags-enum ToString() falls back
 * to a raw integer instead of named flags. Deliberately excludes the
 * COMBINED rights (Write, Modify, FullControl) that the name-based check
 * above already covers by name: those composites also set read-only bits
 * (e.g. Modify = ReadAndExecute | Write | Delete), so OR-ing their full
 * numeric value in here would make a read-only mask that happens to share
 * one of those bits (e.g. plain Read, 0x20089) wrongly test as write-
 * capable. Atomic bits don't have that overlap problem.
 */
export const WRITE_CAPABLE_RIGHTS_MASK =
	0x2 | // WriteData / CreateFiles
	0x4 | // AppendData / CreateDirectories
	0x10 | // WriteExtendedAttributes
	0x40 | // DeleteSubdirectoriesAndFiles
	0x100 | // WriteAttributes
	0x10000 | // Delete
	0x40000 | // WriteDac / ChangePermissions
	0x80000 | // WriteOwner / TakeOwnership
	0x40000000 | // GenericWrite
	0x10000000; // GenericAll

function hasWriteCapableRight(rights: string): boolean {
	const trimmed = rights.trim();
	if (/^-?\d+$/.test(trimmed)) {
		return (Number(trimmed) & WRITE_CAPABLE_RIGHTS_MASK) !== 0;
	}
	return trimmed
		.split(",")
		.map((s) => s.trim())
		.some((name) => WRITE_CAPABLE_RIGHT_NAMES.has(name));
}

export function evaluateWindowsSecurity(
	info: WindowsSecurityInfo,
	currentUserSid: string,
): WindowsSecurityVerdict {
	const isExemptSid = (sid: string | null | undefined): boolean => {
		if (!sid) return false;
		return sid === currentUserSid || sid === SYSTEM_SID || sid === ADMINISTRATORS_SID;
	};

	if (!isExemptSid(info.ownerSid)) {
		return {
			valid: false,
			reason: `is owned by a principal (SID ${info.ownerSid ?? "unknown — could not be translated"}) that isn't you`,
		};
	}
	for (const ace of info.aces) {
		if (ace.type !== "Allow") continue;
		if (!hasWriteCapableRight(ace.rights)) continue;
		if (isExemptSid(ace.principalSid)) continue;
		return {
			valid: false,
			reason: `grants write access to a principal (SID ${ace.principalSid ?? "unknown — could not be translated"})`,
		};
	}
	return { valid: true };
}

interface RawWindowsSecurityQuery {
	currentUserSid?: string;
	ownerSid?: string;
	aces?: { principalSid?: string | null; rights?: string; type?: string; isInherited?: boolean }[];
}

/**
 * Only ever called on win32. Queries owner + ACE data for `targetPath` via
 * PowerShell, translating every identity (the owner and each ACE's
 * principal) to a SID in the SAME call that reports the current user's
 * own SID — one subprocess, not one per identity. The path is passed
 * through an environment variable rather than interpolated into the
 * script string, so a path containing a quote or a PowerShell
 * metacharacter can't affect what gets executed. Bounded by a timeout; a
 * failure, a timeout, or unparseable output fails closed (returns null,
 * which the caller treats as "could not verify").
 */
function queryWindowsSecurity(targetPath: string): RawWindowsSecurityQuery | null {
	let raw: string;
	try {
		const script = [
			"$p = $env:AP_SECURITY_TARGET_PATH",
			"$acl = Get-Acl -LiteralPath $p",
			"$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
			"$ownerSid = $null",
			"try { $ownerSid = $acl.Owner.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}",
			"if (-not $ownerSid) { try { $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {} }",
			"$aces = @()",
			"foreach ($a in $acl.Access) {",
			"  $sid = $null",
			"  try { $sid = $a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}",
			"  $aces += [PSCustomObject]@{ principalSid = $sid; rights = $a.FileSystemRights.ToString(); type = $a.AccessControlType.ToString(); isInherited = $a.IsInherited }",
			"}",
			"[PSCustomObject]@{ currentUserSid = $currentUserSid; ownerSid = $ownerSid; aces = $aces } | ConvertTo-Json -Compress",
		].join("; ");
		raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf-8",
			timeout: 5000,
			env: { ...process.env, AP_SECURITY_TARGET_PATH: targetPath },
		});
	} catch {
		return null;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Checks a directory's Windows security (no identity-before/after check —
 * that's specific to the rules file's open/fstat/read sequence, which a
 * directory never goes through). Returns a reason fragment (no leading
 * capital, no trailing punctuation) describing what's wrong, or null when
 * the directory passes.
 */
export function checkWindowsSecurityAt(targetPath: string): string | null {
	const raw = queryWindowsSecurity(targetPath);
	if (!raw || !raw.currentUserSid) {
		return "could not be verified (Windows security query failed or timed out)";
	}
	const info: WindowsSecurityInfo = {
		ownerSid: raw.ownerSid ?? null,
		aces: (raw.aces ?? []).map((a) => ({
			principalSid: a.principalSid ?? null,
			rights: a.rights ?? "",
			type: a.type === "Deny" ? ("Deny" as const) : ("Allow" as const),
			isInherited: a.isInherited,
		})),
	};
	const verdict = evaluateWindowsSecurity(info, raw.currentUserSid);
	return verdict.valid ? null : (verdict.reason ?? "failed the security check");
}

/**
 * The rules file's own Windows check: the same security query as
 * checkWindowsSecurityAt, plus a before/after identity (device + inode)
 * recheck — it's a slow, external call, and the only part of this
 * module's file-validity check that doesn't read through the
 * already-opened descriptor, so a swap during the query needs its own
 * guard.
 */
function checkWindowsRulesFileSecurity(
	path: string,
	p: ResolvedProvider,
	beforeStat: StatLike,
): string | null {
	const reason = checkWindowsSecurityAt(path);
	if (reason) return `${reason}; recreate it with \`agentpulse exclude add\`, or take ownership`;

	let afterStat: StatLike;
	try {
		afterStat = p.lstat(path);
	} catch {
		return "disappeared while its security info was being checked";
	}
	if (afterStat.dev !== beforeStat.dev || afterStat.ino !== beforeStat.ino) {
		return "changed while its security info was being checked";
	}
	return null;
}
