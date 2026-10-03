#!/usr/bin/env bun
/**
 * AgentPulse localhost relay.
 *
 * Agents can only post hooks to localhost, so this process listens on
 * 127.0.0.1, queues hook events on disk and forwards them (with the API key)
 * to the remote AgentPulse server. It also syncs session names (Codex's
 * session_index.jsonl ⇄ the dashboard) and CLAUDE.md/AGENTS.md files.
 *
 * Self-contained by design: it runs from a single copied file on machines that
 * don't have the repo, so it imports only `node:` builtins and duplicates the
 * few server helpers it needs (sanitizeName, computeChecksum) under parity
 * tests (scripts/relay.test.ts).
 *
 * Every side effect (argv, Bun.serve, timers, banner, exit) lives under
 * `import.meta.main`, so tests can import this module freely (F9).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
	constants,
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { homedir as osHomedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const RELAY_FETCH_TIMEOUT_MS = 8_000;
const SYNC_FETCH_TIMEOUT_MS = 5_000;
const RELAY_IDLE_TIMEOUT_S = 30;
const HOOK_RETRY_BASE_MS = 2_000;
const HOOK_RETRY_MAX_MS = 60_000;
const HOOK_RETRY_POLL_MS = 5_000;
const DEFAULT_PORT = 4000;
const DEFAULT_SYNC_MS = 30_000;
const SCOPE_CHECK_MS = 10 * 60_000;
const DRIFT_CHECK_MS = 60 * 60_000;
const CODEX_PAGE_SIZE = 50;
const CODEX_MAX_PAGES = 4;
// F128: the narrow projection; a server without it ignores the parameter and
// returns full rows, which carry the same three fields.
const CODEX_LIST_FIELDS = "sessionId,displayName,nameSource";
const MAX_PUSHES_PER_TICK = CODEX_PAGE_SIZE * CODEX_MAX_PAGES;
const STORM_WINDOW_MS = 60 * 60_000;
/** F109: at most this many appends per Codex id per rolling STORM_WINDOW_MS, of any kind. */
const STORM_MAX_PUSHES = 3;
const PULL_MAX_CONSECUTIVE_404 = 5;
const PULL_STALE_ENTRY_MS = 24 * 60 * 60_000;
/** F125: bounds the post-restart burst against the server's /native-name rate limit. */
const MAX_PULL_PUTS_PER_TICK = 50;
/** F149: a full-ledger rewrite is attempted at most this often. */
const LEDGER_COMPACT_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const CLAUDE_MD_SESSION_LIMIT = 20;
/** F106: sessions this relay forwarded, remembered for CLAUDE.md sync. */
const MAX_LOCAL_SESSIONS = 1000;
/** A session that stays active in one directory has its last-seen time rewritten to disk at most this often, so a restart keeps the active ones when it trims. */
const LOCAL_SESSION_TOUCH_PERSIST_MS = 5 * 60_000;
/** The sticky excluded-session set is bounded; the least recently seen id is trimmed first. */
const MAX_EXCLUDED_IDS = 2000;
/** How often the rules file is looked at when no traffic asks (keeps the marker and the status line current). */
const EXCLUDE_TICK_MS = 5_000;
/** The stored form of a session id the sticky set will keep: what real agents emit, never a path-shaped string. */
const EXCLUDED_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const HASHED_ID_PREFIX = "sha256:";
/** A queued hook that is waiting because the rules file is invalid carries this as its last error. */
const HELD_ERROR = "held: exclude rules invalid";
/** A temp file this much older than now is no write in flight: the process that made it is gone. */
const ORPHAN_TMP_MIN_AGE_MS = 60_000;
/** An item whose handling throws this many times is set aside in the parked directory (never deleted) so the queue moves on. */
const HANDLING_MAX_FAILURES = 5;
/** What is set aside is kept for the user, but not forever: past this many the oldest is dropped (queue items are transient hook payloads, not user data). */
export const MAX_PARKED_ITEMS = 500;
/** A lease older than this is no handling in flight: forwarding takes at most RELAY_FETCH_TIMEOUT_MS, so whoever leased it is gone. */
const LEASE_TIMEOUT_MS = 10 * 60_000;

/** F122: a revoked key must not grow the queue without bound. */
const MAX_QUEUE_FILES = 10_000;
const MAX_QUEUE_AGE_MS = 24 * 60 * 60_000;
/** F109: past this many ledger lines, drop rows no longer in the index. */
const LEDGER_COMPACT_THRESHOLD = 2000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
// O_NOFOLLOW is POSIX-only; on platforms without it the lstat check still runs.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const REQUIRED_SCOPES = ["ingest", "observe"] as const;
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
const DEFAULT_AGENT_TYPE = "claude_code";
const USAGE =
	"Usage: relay.ts [<url>] [--config <path>] [--port N] [--key K] [--codex-name-policy agentpulse|codex]";

// ── Exclude rules (the shared evaluator, embedded) ───────────────────────────

// >>> exclude-rules: generated from src/shared/exclude-rules.ts and src/shared/hook-headers.ts by `bun run embed:exclude-rules`; edit those, never this block
export const SKIP_HEADER = "X-AgentPulse-Skip";
export const SKIP_HEADER_MAX_LENGTH = 64;
export const EXCLUDE_RULES_RELATIVE_PATH = ".agentpulse/exclude";
export const EXCLUDE_INVALID_MARKER_RELATIVE_PATH = ".agentpulse/exclude.invalid";
export const EXCLUDE_MAX_RULES = 500;

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
// <<< exclude-rules

// ── Config ───────────────────────────────────────────────────────────────────

export type CodexNamePolicy = "agentpulse" | "codex";
const CODEX_NAME_POLICIES: readonly string[] = ["agentpulse", "codex"];

/** The installer-written config.json (snake_case keys). */
export type RelayFileConfig = {
	remote_url?: string;
	api_key?: string;
	port?: number;
	codex_name_policy?: string;
	state_dir?: string;
};

export type RelayConfig = {
	remoteUrl: string;
	apiKey: string;
	port: number;
	codexNamePolicy: CodexNamePolicy;
	/** Hook queue, status file, ledger and cache all live here (F51). */
	stateDir: string;
	configPath: string | null;
};

export type ParseResult = { ok: true; config: RelayConfig } | { ok: false; error: string };

/**
 * AGEN-16: stamped on queued forwards to exactly /api/v1/hooks with the queue
 * item's id (stable across retries). The event-dedup server asserts the same
 * literal (F158).
 */
export const DELIVERY_ID_HEADER = "X-AgentPulse-Delivery-Id";

/** RFC 6750 b64token: what a Bearer credential may contain. */
const API_KEY_TOKEN_RE = /^[A-Za-z0-9._~+/-]+=*$/;

const VALUE_FLAGS: Record<string, "port" | "key" | "config" | "policy"> = {
	"--port": "port",
	"--key": "key",
	"--config": "config",
	"--codex-name-policy": "policy",
};

/**
 * Pure: no I/O, no exit. Precedence is argv > config file > default, like
 * src/supervisor/config.ts. `env` carries the two environment-derived stateDir
 * fallbacks so the function stays deterministic.
 */
export function parseArgs(
	argv: string[],
	fileConfig: RelayFileConfig,
	env: { agentpulseDir?: string; scriptDir?: string } = {},
): ParseResult {
	const flags: Partial<Record<"url" | "port" | "key" | "config" | "policy", string>> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const name = VALUE_FLAGS[arg];
		if (name) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				return { ok: false, error: `${arg} needs a value` };
			}
			flags[name] = value;
			i++;
			continue;
		}
		if (arg.startsWith("--")) return { ok: false, error: `unknown option ${arg}` };
		flags.url = arg;
	}

	const rawUrl = flags.url ?? fileConfig.remote_url;
	if (!rawUrl) return { ok: false, error: "the remote AgentPulse URL is required" };
	const remoteUrl = rawUrl.replace(/\/+$/, "");
	if (!/^https?:\/\/[^\s/]+/i.test(remoteUrl)) {
		return {
			ok: false,
			error: `the remote URL must start with http:// or https:// (${remoteUrl})`,
		};
	}

	const rawPort = flags.port ?? fileConfig.port ?? DEFAULT_PORT;
	const port = Number(rawPort);
	if (String(rawPort).trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535) {
		return { ok: false, error: `invalid port ${String(rawPort)}` };
	}

	const policy = flags.policy ?? fileConfig.codex_name_policy ?? "codex";
	if (!CODEX_NAME_POLICIES.includes(policy)) {
		return { ok: false, error: `codex name policy must be agentpulse or codex (got ${policy})` };
	}

	const configPath = flags.config ?? null;
	const stateDir =
		fileConfig.state_dir ??
		(configPath ? dirname(configPath) : undefined) ??
		env.agentpulseDir ??
		env.scriptDir ??
		".";

	const apiKey = flags.key ?? fileConfig.api_key ?? "";
	// F127: a key that can't be a header token (e.g. a hand-edited config.json
	// with a trailing newline) would make fetch throw with the key in the error.
	if (apiKey && !API_KEY_TOKEN_RE.test(apiKey)) {
		return {
			ok: false,
			error:
				"the API key has characters an Authorization header can't carry (check config.json for stray whitespace)",
		};
	}

	return {
		ok: true,
		config: {
			remoteUrl,
			apiKey,
			port,
			codexNamePolicy: policy as CodexNamePolicy,
			stateDir,
			configPath,
		},
	};
}

/** Reads config.json. A missing file is `{}`; malformed JSON throws. */
export async function loadConfigFile(path: string): Promise<RelayFileConfig> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return {};
		throw err;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${path}: expected a JSON object`);
	}
	const o = parsed as Record<string, unknown>;
	const out: RelayFileConfig = {};
	if (typeof o.remote_url === "string") out.remote_url = o.remote_url;
	if (typeof o.api_key === "string") out.api_key = o.api_key;
	if (typeof o.port === "number" || (typeof o.port === "string" && o.port.trim() !== "")) {
		out.port = Number(o.port);
	}
	if (typeof o.codex_name_policy === "string") out.codex_name_policy = o.codex_name_policy;
	if (typeof o.state_dir === "string") out.state_dir = o.state_dir;
	return out;
}

function findConfigPath(argv: string[]): string | null {
	const i = argv.indexOf("--config");
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

// ── Duplicated server helpers (parity-tested) ────────────────────────────────

// Deliberate duplicate of src/server/services/name-sanitizer.ts. The global
// flag makes .test() stateful, so this pattern is only ever used with
// .replace() (F93).
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0/DEL control characters from untrusted input
const UNSAFE_NAME_CHARS_RE = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g;
const MAX_NAME_CODE_POINTS = 200;
const NAME_PRE_CAP_CODE_UNITS = 4096;

export function sanitizeName(raw: string): string {
	let bounded = raw;
	if (bounded.length > NAME_PRE_CAP_CODE_UNITS) {
		let end = NAME_PRE_CAP_CODE_UNITS;
		const lastUnit = bounded.charCodeAt(end - 1);
		if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
		bounded = bounded.slice(0, end);
	}
	const stripped = bounded.replace(UNSAFE_NAME_CHARS_RE, "").trim();
	const codePoints = [...stripped];
	return codePoints.length > MAX_NAME_CODE_POINTS
		? codePoints.slice(0, MAX_NAME_CODE_POINTS).join("")
		: stripped;
}

// F80: intentionally duplicates src/server/util/checksum.ts's computeChecksum
// (same algorithm, same `trimEnd` option) rather than importing it.
export async function computeChecksum(
	content: string,
	options?: { trimEnd?: boolean },
): Promise<string> {
	const input = options?.trimEnd ? content.trimEnd() : content;
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

// ── State and context ────────────────────────────────────────────────────────

export type DriftStatus = "ok" | "outdated" | "missing" | "unknown";
export type SyncStatus = {
	status: string;
	lastError: string | null;
	lastSuccessAt: string | null;
};
type PullEntryState = { seenKey: string | null; missKey: string | null; missCount: number };
export type LocalSession = { cwd: string; agentType: string | null; seenAt: string };

export function createRelayState() {
	return {
		queue: {
			lastHookEnqueuedAt: null as string | null,
			lastHookForwardedAt: null as string | null,
			lastHookFailureAt: null as string | null,
			lastHookError: null as string | null,
			consecutiveHookFailures: 0,
			dropped: 0,
			/** Items set aside in the parked directory (counted at startup, and as they are parked). */
			parked: 0,
			/** Queue file name → how many times handling it threw, and when it may be tried again (this run only). */
			handling: new Map<string, { failures: number; nextAtMs: number }>(),
			/** Queue file names this process moved into processing/ and has not seen leave it. */
			leased: new Set<string>(),
		},
		lastEventAtByAgent: {} as Record<string, string>,
		/** D22: per-agent "installed but never fired" signal, evidence-based (SPIKE fact 6: TUI-only). */
		hooksNotFiring: {} as Record<string, boolean>,
		/** F106: sessionId → cwd, only from hooks this relay enqueued. Map order = recency. */
		localSessions: new Map<string, LocalSession>(),
		localSessionsWrite: Promise.resolve() as Promise<void>,
		/** Each session's seenAt as last written to disk (ms), for the throttled last-seen refresh. */
		localSessionsDiskSeen: new Map<string, number>(),
		auth: {
			scopes: null as string[] | null,
			missing: [] as string[],
			hasManage: false,
			checkedAt: null as string | null,
			degraded: false,
			keyRejected: false,
			lastError: null as string | null,
		},
		sync: {
			codexNames: {
				status: "idle",
				lastError: null,
				lastSuccessAt: null,
				suppressedIds: [] as string[],
			} as SyncStatus & { suppressedIds: string[] },
			claudeMd: { status: "idle", lastError: null, lastSuccessAt: null } as SyncStatus,
		},
		drift: {
			relay: "unknown" as DriftStatus,
			statusline: "unknown" as DriftStatus,
			checkedAt: null as string | null,
		},
		relayHash: "",
		codexPull: new Map<string, PullEntryState>(),
		pullStateLoaded: false,
		listFieldsUnsupported: false,
		lastLedgerCompactionAt: 0,
		/** F125: epoch ms before which the pull doesn't PUT (server Retry-After). */
		pullRetryAt: 0,
		pushGuard: {} as Record<string, number[]>,
		suppressedLogged: new Set<string>(),
		refusedWrites: new Set<string>(),
		localChecksums: new Map<string, string>(),
		lastAuthLine: null as string | null,
		/** undefined = never written, so the first sync always reconciles disk. */
		statusLineWritten: undefined as string | null | undefined,
		statusWrite: Promise.resolve() as Promise<void>,
		queueRunning: false,
		queueTimer: null as ReturnType<typeof setTimeout> | null,
		exclude: {
			/** The rules as last loaded; reloaded only when the file's signature changes. */
			rules: { state: "none", rules: [] } as LoadExcludeRulesResult,
			signature: null as string | null,
			/** How many times the rules file was read and parsed, and how many times its signature was checked. */
			loads: 0,
			probes: 0,
			/** Session ids that are excluded for the rest of their life; map order = recency. */
			excludedIds: new Map<string, true>(),
			/** Entries of the saved list this relay does not recognise, kept verbatim so a save does not lose them. */
			unrecognisedIds: [] as unknown[],
			write: Promise.resolve() as Promise<void>,
			drops: { skip: 0, sticky: 0, path: 0, rules_invalid: 0, no_cwd: 0 } as Record<
				ExcludeReason,
				number
			>,
			heldLogged: false,
			/** Set when the sticky file exists but could not be read or parsed: which sessions are excluded is unknown. */
			stickyProblem: null as string | null,
			/** Set while saving the sticky set is failing. */
			persistProblem: null as string | null,
		},
	};
}
export type RelayState = ReturnType<typeof createRelayState>;

export type RelayPaths = {
	stateDir: string;
	hookPendingDir: string;
	hookProcessingDir: string;
	/** Items the relay could not handle, kept for the user: never read again, never deleted. */
	hookParkedDir: string;
	statusFile: string;
	ledgerFile: string;
	localSessionsFile: string;
	pullStateFile: string;
	home: string;
	codexIndexFile: string;
	installedStatuslineFile: string;
	relayScriptFile: string;
	/** D22: written by the installers (codexHooksWrittenAt/copilotHooksWrittenAt). */
	installedFile: string;
	/** Session ids that stay excluded across restarts: ids only, mode 0600. */
	excludedSessionsFile: string;
};

export type RelayContext = {
	config: RelayConfig;
	state: RelayState;
	paths: RelayPaths;
	/** The actually-bound port (differs from config.port when that is 0). */
	port: number;
	fetch: typeof fetch;
	now: () => number;
	log: (line: string) => void;
	/** false in tests: nothing is scheduled behind the caller's back. */
	autoSchedule: boolean;
	/** F127: replaces the API key in any text bound for logs or diagnostics. */
	redact: (text: string) => string;
	limits: RelayLimits;
	/** The two calls that tell whether the rules file changed; replaceable so a test can count them. */
	excludeFs: ExcludeProbeFs;
	/** The account's home from the user database (not HOME), or undefined when the system has none. */
	accountHome: () => string | undefined;
	/** Test seam: called while a queue file is being written, once the temp file is open and once it is complete, just before the rename. */
	queueWriteHook?: (stage: "opened" | "written", tmpPath: string, finalPath: string) => void;
	/** Test seam: called while the status file is being written, once the file being written is open and once its content is complete. */
	statusWriteHook?: (stage: "opened" | "written", writingPath: string) => void | Promise<void>;
};

export type RelayLimits = {
	maxLocalSessions: number;
	maxQueueFiles: number;
	maxQueueAgeMs: number;
	ledgerCompactThreshold: number;
	maxPullPutsPerTick: number;
	maxExcludedIds: number;
	/** How many set-aside items are kept; the oldest goes first. */
	maxParkedItems: number;
	/** How old a lease in processing/ must be before a round queues it again when this process did not take it. */
	leaseTimeoutMs: number;
};

const DEFAULT_LIMITS: RelayLimits = {
	maxLocalSessions: MAX_LOCAL_SESSIONS,
	maxQueueFiles: MAX_QUEUE_FILES,
	maxQueueAgeMs: MAX_QUEUE_AGE_MS,
	ledgerCompactThreshold: LEDGER_COMPACT_THRESHOLD,
	maxPullPutsPerTick: MAX_PULL_PUTS_PER_TICK,
	maxExcludedIds: MAX_EXCLUDED_IDS,
	maxParkedItems: MAX_PARKED_ITEMS,
	leaseTimeoutMs: LEASE_TIMEOUT_MS,
};

type ContextOptions = {
	env?: { HOME?: string; CODEX_HOME?: string };
	scriptPath?: string;
	fetch?: typeof fetch;
	now?: () => number;
	log?: (line: string) => void;
	state?: RelayState;
	limits?: Partial<RelayLimits>;
	excludeFs?: ExcludeProbeFs;
	/** The account's home directory, used only when HOME is unset or empty. */
	homedir?: () => string;
	/** The account's home as the operating system's user database has it (not HOME); only used to notice rules the relay never reads. */
	accountHome?: () => string | undefined;
};

/** HOME, else the operating system's answer for this account; "" only when neither exists. */
function resolveHome(envHome: string | undefined, homedir: () => string): string {
	if (envHome) return envHome;
	try {
		return homedir();
	} catch {
		return "";
	}
}

export function resolveRelayPaths(
	config: RelayConfig,
	env: { HOME?: string; CODEX_HOME?: string },
	scriptPath: string,
): RelayPaths {
	const home = env.HOME ?? "";
	const codexHome = env.CODEX_HOME || join(home, ".codex");
	const hookQueueDir = join(config.stateDir, "hook-queue");
	return {
		stateDir: config.stateDir,
		hookPendingDir: join(hookQueueDir, "pending"),
		hookProcessingDir: join(hookQueueDir, "processing"),
		hookParkedDir: join(hookQueueDir, "parked"),
		statusFile: join(config.stateDir, "status"),
		ledgerFile: join(config.stateDir, "codex-pushed.jsonl"),
		localSessionsFile: join(config.stateDir, "local-sessions.json"),
		pullStateFile: join(config.stateDir, "codex-pull-state.json"),
		home,
		codexIndexFile: join(codexHome, "session_index.jsonl"),
		installedStatuslineFile: join(home, ".claude", "statusline-agentpulse.sh"),
		relayScriptFile: scriptPath,
		installedFile: join(config.stateDir, "installed.json"),
		excludedSessionsFile: join(config.stateDir, "excluded-sessions.json"),
	};
}

/**
 * The account's home as the operating system's user database has it (HOME is not consulted).
 * AGENTPULSE_TEST_RELAY_ACCOUNT_HOME stands in for it in tests only, so a relay a test spawns never
 * looks at the real account's directory; an empty value means "none".
 */
function defaultAccountHome(): string | undefined {
	const forTests = process.env.AGENTPULSE_TEST_RELAY_ACCOUNT_HOME;
	if (forTests !== undefined) return forTests || undefined;
	try {
		return userInfo().homedir;
	} catch {
		return undefined;
	}
}

export function createRelayContext(config: RelayConfig, opts: ContextOptions = {}): RelayContext {
	const rawEnv = opts.env ?? { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
	const env = { ...rawEnv, HOME: resolveHome(rawEnv.HOME, opts.homedir ?? osHomedir) };
	const baseLog = opts.log ?? ((line: string) => console.log(line));
	const redact = (text: string) =>
		config.apiKey ? text.split(config.apiKey).join("[redacted]") : text;
	return {
		config,
		state: opts.state ?? createRelayState(),
		paths: resolveRelayPaths(config, env, opts.scriptPath ?? import.meta.path),
		port: config.port,
		fetch: opts.fetch ?? fetch,
		now: opts.now ?? Date.now,
		log: (line) => baseLog(redact(line)),
		redact,
		autoSchedule: false,
		limits: { ...DEFAULT_LIMITS, ...opts.limits },
		excludeFs: opts.excludeFs ?? { statSync, lstatSync },
		accountHome: opts.accountHome ?? defaultAccountHome,
	};
}

// ── Small helpers ────────────────────────────────────────────────────────────

function iso(ms: number) {
	return new Date(ms).toISOString();
}

function redact(ctx: RelayContext, text: string) {
	return ctx.redact(text);
}

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters before logging
const LOG_UNSAFE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** F111: server- and Codex-controlled text can't forge log lines or escapes. */
function logSafe(value: unknown): string {
	return String(value).replace(LOG_UNSAFE_RE, "");
}

async function ensurePrivateDir(path: string) {
	await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

// F201: `mode` on writeFile/appendFile is a POSIX open(2) create mode — it
// only applies when the call creates the file. If the path already existed
// at some other permission (an older Bun, F190; a race; a manual copy),
// neither call tightens it back down. The explicit chmod after each write
// makes the private-file guarantee hold regardless of what created the path.
//
// F203: both this open and that chmod must resolve the *same* file a
// symlink can't redirect. openPrivateNoFollow refuses a symlink/non-regular
// path (reusing lstatKind/assertSameFile, the same F107/F136 machinery
// writeFileNoFollow already uses below) and returns the open handle;
// chmod-ing the handle (fchmod), not the path, closes the TOCTOU gap a
// by-path chmod would leave between the write and the permission tighten.
async function openPrivateNoFollow(path: string, extraFlags: number) {
	const kind = await lstatKind(path);
	if (kind !== "file" && kind !== "missing") {
		throw new Error(`refusing to write through ${kind}: ${path}`);
	}
	const seen = kind === "file" ? await lstat(path) : null;
	// F154: a file that appears after lstat said "missing" makes open fail
	// (EEXIST) instead of being written through.
	const createFlags = kind === "missing" ? constants.O_CREAT | constants.O_EXCL : 0;
	const handle = await open(path, extraFlags | createFlags | O_NOFOLLOW, PRIVATE_FILE_MODE);
	assertSameFile(path, seen ?? (await lstat(path)), await handle.stat());
	return handle;
}

async function writePrivateFile(path: string, content: string) {
	const handle = await openPrivateNoFollow(path, constants.O_WRONLY);
	try {
		await handle.truncate(0);
		await handle.writeFile(content, "utf-8");
		await handle.chmod(PRIVATE_FILE_MODE);
	} finally {
		await handle.close();
	}
}

async function appendPrivateFile(path: string, content: string) {
	const handle = await openPrivateNoFollow(path, constants.O_WRONLY | constants.O_APPEND);
	try {
		await handle.writeFile(content, "utf-8");
		await handle.chmod(PRIVATE_FILE_MODE);
	} finally {
		await handle.close();
	}
}

/**
 * A queue file appears all at once: written to a name no lease looks at (it does not end in
 * .json), then renamed. O_EXCL on a fresh name means nothing already there (a symlink
 * included) can be written through, so none of the checks openPrivateNoFollow makes for an
 * existing path are needed, and this does less work per hook than the in-place write it replaces.
 */
async function writeQueueFile(ctx: RelayContext, path: string, content: string) {
	const tmp = `${path}.${process.pid}.tmp`;
	const handle = await open(
		tmp,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
		PRIVATE_FILE_MODE,
	);
	ctx.queueWriteHook?.("opened", tmp, path);
	try {
		await handle.writeFile(content, "utf-8");
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	} finally {
		await handle.close();
	}
	ctx.queueWriteHook?.("written", tmp, path);
	await rename(tmp, path);
}

/** Atomic replace (temp + rename), private mode. */
async function replacePrivateFile(path: string, content: string) {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writePrivateFile(tmp, content);
		await chmod(tmp, PRIVATE_FILE_MODE);
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

type LstatKind = "file" | "symlink" | "hardlink" | "other" | "missing";

/** F107/F135: only a plain, singly-linked regular file counts as "file". */
async function lstatKind(path: string): Promise<LstatKind> {
	try {
		const st = await lstat(path);
		if (st.isSymbolicLink()) return "symlink";
		if (!st.isFile()) return "other";
		return st.nlink > 1 ? "hardlink" : "file";
	} catch {
		return "missing";
	}
}

type FileIdentity = { dev: number; ino: number; nlink: number; isFile: () => boolean };

/**
 * F136: where O_NOFOLLOW is unavailable (Windows) the open can race a swap
 * of the path, so after opening, the handle must still be the file lstat saw.
 */
function assertSameFile(path: string, seen: FileIdentity, opened: FileIdentity) {
	if (seen.dev !== opened.dev || seen.ino !== opened.ino || !opened.isFile() || opened.nlink > 1) {
		throw new Error(`file changed while opening: ${path}`);
	}
}

/** F107: reads a regular file without following a symlink at the final component. */
async function readFileNoFollow(path: string): Promise<string> {
	if ((await lstatKind(path)) !== "file") throw new Error(`not a regular file: ${path}`);
	const seen = await lstat(path);
	const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
	try {
		assertSameFile(path, seen, await handle.stat());
		return await handle.readFile("utf-8");
	} finally {
		await handle.close();
	}
}

/**
 * F107: writes (creating or replacing content) without following a symlink.
 * Truncation happens only after the opened handle is verified (F136), so a
 * swapped-in file is never emptied.
 */
async function writeFileNoFollow(path: string, content: string) {
	const kind = await lstatKind(path);
	if (kind !== "file" && kind !== "missing")
		throw new Error(`refusing to write through ${kind}: ${path}`);
	const seen = kind === "file" ? await lstat(path) : null;
	// F154: a file that appears after lstat said "missing" makes open fail
	// (EEXIST) instead of being written through.
	const createFlags = kind === "missing" ? constants.O_CREAT | constants.O_EXCL : 0;
	const handle = await open(path, constants.O_WRONLY | createFlags | O_NOFOLLOW, 0o644);
	try {
		const opened = await handle.stat();
		assertSameFile(path, seen ?? (await lstat(path)), opened);
		await handle.truncate(0);
		await handle.writeFile(content, "utf-8");
	} finally {
		await handle.close();
	}
}

async function readTextOrEmpty(path: string) {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return "";
	}
}

async function hashFile(path: string): Promise<string | null> {
	try {
		return await computeChecksum(await readFile(path, "utf-8"), { trimEnd: true });
	} catch {
		return null;
	}
}

function remoteFetch(
	ctx: RelayContext,
	path: string,
	init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<Response> {
	const headers: Record<string, string> = {};
	if (init.body !== undefined) headers["Content-Type"] = "application/json";
	if (ctx.config.apiKey && init.auth !== false) {
		headers.Authorization = `Bearer ${ctx.config.apiKey}`;
	}
	return ctx.fetch(`${ctx.config.remoteUrl}${path}`, {
		method: init.method ?? "GET",
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
	});
}

// ── Scopes, status file, drift (D3, D10, D17) ────────────────────────────────

export type ScopeEvaluation = {
	scopes: string[] | null;
	missing: string[];
	hasManage: boolean;
	/** The server didn't say (pre-scope server or unexpected body). */
	degraded: boolean;
};

/** Evaluates a `GET /api/v1/auth/me` body. Never throws. */
export function evaluateScopes(me: unknown): ScopeEvaluation {
	const degraded: ScopeEvaluation = { scopes: null, missing: [], hasManage: false, degraded: true };
	if (!me || typeof me !== "object") return degraded;
	const body = me as { disableAuth?: unknown; authenticated?: unknown; user?: unknown };
	if (body.disableAuth === true) {
		return { scopes: null, missing: [], hasManage: true, degraded: false };
	}
	if (body.authenticated === false) {
		return { scopes: null, missing: [...REQUIRED_SCOPES], hasManage: false, degraded: false };
	}
	const raw = (body.user as { scopes?: unknown } | null | undefined)?.scopes;
	if (!Array.isArray(raw)) return degraded;
	const scopes = raw.filter((s): s is string => typeof s === "string");
	const all = scopes.includes("*");
	const hasManage = all || scopes.includes("manage");
	const missing: string[] = [];
	if (!all && !scopes.includes("ingest")) missing.push("ingest");
	// manage satisfies every observe read (route-scope-policy.ts).
	if (!hasManage && !scopes.includes("observe")) missing.push("observe");
	return { scopes, missing, hasManage, degraded: false };
}

function authWarning(state: RelayState): string | null {
	const a = state.auth;
	if (a.keyRejected) return "key rejected — re-run setup-relay";
	if (a.checkedAt && a.missing.length > 0) {
		return `key lacks ${a.missing.join(" + ")} — re-run setup-relay`;
	}
	return null;
}

/** Every current problem, most important first. */
export function computeWarnings(state: RelayState, withReason = false): string[] {
	const warnings: string[] = [];
	const rules = state.exclude.rules;
	if (rules.state === "invalid") {
		const where = rules.line !== undefined ? ` (line ${rules.line})` : "";
		// The reason can quote the rule; only the owner's own status file carries it, never the local HTTP surface.
		const why = withReason && rules.reason ? `${logSafe(rules.reason)}; ` : "";
		warnings.push(
			`exclude rules invalid${where}: ${why}the relay is sending no session data; run: agentpulse exclude check`,
		);
	}
	if (state.exclude.stickyProblem) warnings.push(state.exclude.stickyProblem);
	if (state.exclude.persistProblem) warnings.push(state.exclude.persistProblem);
	if (state.queue.parked > 0) {
		warnings.push(
			`${state.queue.parked} queued hook(s) set aside after repeated errors (kept in hook-queue/parked in the relay's state directory)`,
		);
	}
	const auth = authWarning(state);
	if (auth) warnings.push(auth);
	if (state.drift.relay === "outdated") warnings.push("relay outdated — re-run setup-relay");
	if (state.drift.statusline === "outdated") {
		warnings.push("statusline outdated — re-run setup-relay");
	}
	// D22: evidence-based — only fires once Codex has demonstrably run since
	// install (see checkHooksNotFiring).
	if (state.hooksNotFiring.codex_cli) {
		warnings.push("codex hooks not firing — run /hooks in Codex to trust them");
	}
	return warnings;
}

/** The single line the statusline shows (D17), or null when healthy. */
export function computeStatusLine(state: RelayState): string | null {
	return computeWarnings(state, true)[0] ?? null;
}

/** One write at a time, in the order asked: each write computes the line when it runs, so the last state is the last file renamed into place (the replace itself already keeps any reader from seeing a partial file). */
export function writeStatusFile(ctx: RelayContext): Promise<void> {
	const run = ctx.state.statusWrite.then(() => writeStatusFileNow(ctx));
	ctx.state.statusWrite = run.catch(() => {});
	return run;
}

/**
 * The statusline reads this file on every render, so it is replaced as a whole: the new line is
 * written to a file of its own (O_EXCL on a fresh name, so nothing planted there is written
 * through) and renamed over the old one. A reader sees the old line or the new one, never an
 * empty or half-written file. Anything at the status path that is not a plain file (a symlink
 * somebody planted, say) is refused and left exactly as it is.
 */
async function writeStatusContent(ctx: RelayContext, content: string) {
	const path = ctx.paths.statusFile;
	const kind = await lstatKind(path);
	if (kind !== "file" && kind !== "missing") {
		throw new Error(`refusing to write through ${kind}: ${path}`);
	}
	const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const handle = await open(
		tmp,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
		PRIVATE_FILE_MODE,
	);
	try {
		await ctx.statusWriteHook?.("opened", tmp);
		await handle.writeFile(content, "utf-8");
		await ctx.statusWriteHook?.("written", tmp);
		await handle.chmod(PRIVATE_FILE_MODE);
	} catch (err) {
		await handle.close().catch(() => {});
		await unlink(tmp).catch(() => {});
		throw err;
	}
	await handle.close();
	try {
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

async function writeStatusFileNow(ctx: RelayContext) {
	const line = computeStatusLine(ctx.state);
	if (line === ctx.state.statusLineWritten) return;
	try {
		if (line === null) {
			await unlink(ctx.paths.statusFile).catch((err: { code?: string }) => {
				if (err.code !== "ENOENT") throw err;
			});
		} else {
			await ensurePrivateDir(ctx.paths.stateDir);
			await writeStatusContent(ctx, `${line}\n`);
		}
		ctx.state.statusLineWritten = line;
	} catch (err) {
		ctx.log(`[relay] couldn't update ${ctx.paths.statusFile}: ${errorMessage(err)}`);
	}
}

function announceAuth(ctx: RelayContext) {
	const line = authWarning(ctx.state);
	if (line === ctx.state.lastAuthLine) return;
	const previous = ctx.state.lastAuthLine;
	ctx.state.lastAuthLine = line;
	if (line) {
		const missing = ctx.state.auth.missing;
		ctx.log("");
		ctx.log(`  ! AgentPulse relay: ${line}`);
		if (missing.includes("observe")) {
			ctx.log("    Codex name sync and CLAUDE.md download are paused until the key can observe.");
		}
		ctx.log(
			'    Fix: Settings → API Keys → mint a key with "Hook ingest" + "Observe (read-only)", then re-run setup-relay.',
		);
		ctx.log("");
	} else if (previous) {
		ctx.log("[relay] API key scopes OK");
	}
}

export async function checkScopesTick(ctx: RelayContext) {
	const auth = ctx.state.auth;
	try {
		const res = await remoteFetch(ctx, "/api/v1/auth/me");
		if (res.status === 401) {
			Object.assign(auth, {
				scopes: null,
				missing: [...REQUIRED_SCOPES],
				hasManage: false,
				degraded: false,
				keyRejected: true,
				checkedAt: iso(ctx.now()),
				lastError: "HTTP 401 from /auth/me",
			});
		} else if (!res.ok) {
			auth.lastError = `HTTP ${res.status} from /auth/me`;
		} else {
			const body: unknown = await res.json().catch(() => null);
			Object.assign(auth, evaluateScopes(body), {
				keyRejected: false,
				checkedAt: iso(ctx.now()),
				lastError: null,
			});
		}
	} catch (err) {
		auth.lastError = redact(ctx, errorMessage(err));
	}
	announceAuth(ctx);
	await writeStatusFile(ctx);
}

function compareHash(local: string | null, remote: unknown): DriftStatus {
	if (typeof remote !== "string" || !local) return "unknown";
	return local === remote ? "ok" : "outdated";
}

export async function checkDriftTick(ctx: RelayContext) {
	const state = ctx.state;
	if (!state.relayHash) state.relayHash = (await hashFile(ctx.paths.relayScriptFile)) ?? "";
	let clients: Record<string, unknown> | undefined;
	try {
		const res = await remoteFetch(ctx, "/api/v1/health", { auth: false });
		if (res.ok) {
			const body = (await res.json().catch(() => null)) as { clients?: unknown } | null;
			if (body?.clients && typeof body.clients === "object") {
				clients = body.clients as Record<string, unknown>;
			}
		}
	} catch {
		// Unreachable server: drift stays unknown for this round.
	}
	const installedStatusline = await hashFile(ctx.paths.installedStatuslineFile);
	const previous = `${state.drift.relay}/${state.drift.statusline}`;
	state.drift.relay = compareHash(state.relayHash || null, clients?.relay);
	state.drift.statusline =
		installedStatusline === null
			? "missing"
			: compareHash(installedStatusline, clients?.statusline);
	state.drift.checkedAt = iso(ctx.now());
	if (`${state.drift.relay}/${state.drift.statusline}` !== previous) {
		ctx.log(`[relay] drift: relay ${state.drift.relay}, statusline ${state.drift.statusline}`);
	}
	await writeStatusFile(ctx);
}

function observeMissing(ctx: RelayContext) {
	return ctx.state.auth.checkedAt !== null && ctx.state.auth.missing.includes("observe");
}

/** F106: fails closed — only a confirmed manage-capable key uploads. */
function canUpload(ctx: RelayContext) {
	const a = ctx.state.auth;
	return a.checkedAt !== null && !a.degraded && a.hasManage;
}

function setSyncStatus(
	ctx: RelayContext,
	key: "codexNames" | "claudeMd",
	status: string,
	error: string | null,
) {
	const s = ctx.state.sync[key];
	const previous = s.status;
	s.status = status;
	s.lastError = error === null ? null : redact(ctx, error);
	if (!error && !status.startsWith("disabled")) s.lastSuccessAt = iso(ctx.now());
	if (previous !== status) {
		ctx.log(`[sync] ${key}: ${status}${error ? ` (${error})` : ""}`);
	}
}

// ── Local request filter and instruction-file guard (D4, D11) ────────────────

export type LocalRequestVerdict =
	| { ok: true }
	| { ok: false; reason: "relay_rejects_browser_requests"; detail: "origin" | "host" };

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/i;

/**
 * Browsers always send Origin on cross-origin POSTs (the literal "null" from
 * sandboxed frames); agents and curl don't. A loopback Host with our exact
 * port defeats DNS rebinding. No path allowlist: same-user processes can read
 * config.json anyway.
 */
export function isAllowedLocalRequest(headers: Headers, port: number): LocalRequestVerdict {
	if (headers.has("origin")) {
		return { ok: false, reason: "relay_rejects_browser_requests", detail: "origin" };
	}
	const match = LOCAL_HOST_RE.exec(headers.get("host") ?? "");
	if (!match || Number(match[2]) !== port) {
		return { ok: false, reason: "relay_rejects_browser_requests", detail: "host" };
	}
	return { ok: true };
}

export type InstructionsPathVerdict =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "path_not_absolute"
				| "path_traversal_rejected"
				| "path_outside_session_cwd"
				| "path_forbidden_directory";
	  };

function hasDotDotSegment(path: string) {
	return path.split(/[\\/]/).includes("..");
}

function isWithin(child: string, parent: string) {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * F106 defense in depth: directories whose CLAUDE.md/AGENTS.md is never
 * synced — $HOME itself, any ancestor of it, and anything under ~/.claude or
 * ~/.codex (agent-global instructions and state). A relative cwd is refused.
 */
export function isForbiddenCwd(
	cwd: string,
	home: string,
	opts: { caseInsensitive?: boolean } = {},
): boolean {
	if (!isAbsolute(cwd)) return true;
	// F134: APFS and NTFS are case-insensitive by default, so ~/.Claude is ~/.claude.
	const caseInsensitive =
		opts.caseInsensitive ?? (process.platform === "darwin" || process.platform === "win32");
	const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
	const c = fold(resolve(cwd));
	if (c === sep) return true;
	if (!home || !isAbsolute(home)) return false;
	const h = fold(resolve(home));
	return isWithin(h, c) || isWithin(c, join(h, ".claude")) || isWithin(c, join(h, ".codex"));
}

async function realpathOr(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

/**
 * F134: the string check plus the same check on both paths resolved through
 * symlinks, so a link (or a linked parent) into ~/.claude is still refused.
 */
async function isForbiddenCwdOnDisk(cwd: string, home: string): Promise<boolean> {
	if (isForbiddenCwd(cwd, home)) return true;
	return isForbiddenCwd(await realpathOr(cwd), home ? await realpathOr(home) : home);
}

/**
 * The server may only write `<session cwd>/CLAUDE.md` or `AGENTS.md`, compared
 * byte-exactly (no case folding, even on case-insensitive filesystems). The
 * caller passes the cwd this relay itself recorded, never the server's (F106).
 */
export function isSafeInstructionsPath(
	path: string,
	cwd: string,
	home?: string,
): InstructionsPathVerdict {
	if (!isAbsolute(path)) return { ok: false, reason: "path_not_absolute" };
	if (hasDotDotSegment(path) || hasDotDotSegment(cwd)) {
		return { ok: false, reason: "path_traversal_rejected" };
	}
	if (!isAbsolute(cwd) || !INSTRUCTION_FILES.some((name) => path === join(cwd, name))) {
		return { ok: false, reason: "path_outside_session_cwd" };
	}
	if (home !== undefined && isForbiddenCwd(cwd, home)) {
		return { ok: false, reason: "path_forbidden_directory" };
	}
	return { ok: true };
}

/** CLAUDE.md first only for Claude Code (the default agent when unlabeled). */
export function instructionFileOrder(agentType?: string | null): string[] {
	return !agentType || agentType === DEFAULT_AGENT_TYPE
		? ["CLAUDE.md", "AGENTS.md"]
		: ["AGENTS.md", "CLAUDE.md"];
}

// ── CLAUDE.md / AGENTS.md sync (D11, F106, F107) ─────────────────────────────
//
// Only sessions this relay forwarded a hook for are synced, and only in the
// cwd that hook reported (the local session map, persisted under the state
// dir). The server's own `cwd` is never trusted: an ingest key can set it.

function parseLocalSessions(raw: string): Array<[string, LocalSession]> {
	const data = JSON.parse(raw) as { sessions?: Record<string, Partial<LocalSession>> };
	const entries: Array<[string, LocalSession]> = [];
	for (const [id, v] of Object.entries(data?.sessions ?? {})) {
		if (!v || typeof v.cwd !== "string" || !isAbsolute(v.cwd) || hasDotDotSegment(v.cwd)) continue;
		entries.push([
			id,
			{
				cwd: v.cwd,
				agentType: typeof v.agentType === "string" ? v.agentType : null,
				seenAt: typeof v.seenAt === "string" ? v.seenAt : "",
			},
		]);
	}
	return entries.sort((a, b) => a[1].seenAt.localeCompare(b[1].seenAt));
}

function trimLocalSessions(ctx: RelayContext): boolean {
	const map = ctx.state.localSessions;
	let trimmed = false;
	while (map.size > ctx.limits.maxLocalSessions) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
		trimmed = true;
	}
	return trimmed;
}

function persistLocalSessions(ctx: RelayContext): Promise<void> {
	const snapshot = `${JSON.stringify({ version: 1, sessions: Object.fromEntries(ctx.state.localSessions) })}\n`;
	ctx.state.localSessionsDiskSeen = new Map(
		[...ctx.state.localSessions].map(([id, entry]) => [id, Date.parse(entry.seenAt)]),
	);
	const write = ctx.state.localSessionsWrite.then(async () => {
		try {
			await ensurePrivateDir(ctx.paths.stateDir);
			await replacePrivateFile(ctx.paths.localSessionsFile, snapshot);
		} catch (err) {
			ctx.log(
				`[relay] couldn't save ${ctx.paths.localSessionsFile}: ${logSafe(errorMessage(err))}`,
			);
		}
	});
	ctx.state.localSessionsWrite = write;
	return write;
}

/** Remembers the cwd a hook this relay forwarded reported for a session. */
export async function recordLocalSession(
	ctx: RelayContext,
	sessionId: string,
	cwd: unknown,
	agentType: string | null,
) {
	if (!sessionId || typeof cwd !== "string" || cwd.length > MAX_CWD_LENGTH) return;
	if (!isAbsolute(cwd) || hasDotDotSegment(cwd)) return;
	const map = ctx.state.localSessions;
	const previous = map.get(sessionId);
	map.delete(sessionId);
	map.set(sessionId, { cwd, agentType, seenAt: iso(ctx.now()) });
	const changed = !previous || previous.cwd !== cwd || previous.agentType !== agentType;
	// A session that stays put still gets its last-seen time written now and then: the file is
	// trimmed by it after a restart, and an active session must not look like the oldest.
	const writtenAt = ctx.state.localSessionsDiskSeen.get(sessionId);
	const stale =
		writtenAt === undefined ||
		Number.isNaN(writtenAt) ||
		ctx.now() - writtenAt >= LOCAL_SESSION_TOUCH_PERSIST_MS;
	if (trimLocalSessions(ctx) || changed || stale) await persistLocalSessions(ctx);
}

/** A session that became excluded must not leave its directory behind: a lost sticky file would otherwise let cwd-less traffic fall back to it. */
function forgetLocalSession(ctx: RelayContext, sessionId: string): void {
	if (!ctx.state.localSessions.delete(sessionId)) return;
	ctx.state.localSessionsDiskSeen.delete(sessionId);
	void persistLocalSessions(ctx);
}

export async function loadLocalSessions(ctx: RelayContext) {
	let raw: string;
	try {
		raw = await readFile(ctx.paths.localSessionsFile, "utf-8");
	} catch {
		return;
	}
	try {
		for (const [id, entry] of parseLocalSessions(raw)) {
			ctx.state.localSessions.set(id, entry);
			ctx.state.localSessionsDiskSeen.set(id, Date.parse(entry.seenAt));
		}
		trimLocalSessions(ctx);
	} catch (err) {
		ctx.log(
			`[relay] ignoring unreadable ${ctx.paths.localSessionsFile}: ${logSafe(errorMessage(err))}`,
		);
	}
}

function refuseOnce(ctx: RelayContext, sessionId: string, path: string, reason: string) {
	const key = `${sessionId}\0${path}\0${reason}`;
	if (ctx.state.refusedWrites.has(key)) return;
	ctx.state.refusedWrites.add(key);
	ctx.log(`[sync] Refused ${logSafe(path)} for ${logSafe(sessionId)}: ${reason}`);
}

export async function uploadClaudeMd(
	ctx: RelayContext,
	sessionId: string,
	cwd: string,
	agentType?: string | null,
) {
	if (!sessionId || !cwd) return;
	if (!gateSession(ctx, { sessionId, cwd }).send) return;
	if (await isForbiddenCwdOnDisk(cwd, ctx.paths.home)) {
		refuseOnce(ctx, sessionId, cwd, "path_forbidden_directory");
		return;
	}
	for (const name of instructionFileOrder(agentType)) {
		const filePath = join(cwd, name);
		const kind = await lstatKind(filePath);
		if (kind === "missing") continue;
		if (kind !== "file") {
			refuseOnce(ctx, sessionId, filePath, `refused_${kind}`);
			return;
		}
		try {
			const content = await readFileNoFollow(filePath);
			const checksum = await computeChecksum(content);
			const res = await remoteFetch(
				ctx,
				`/api/v1/sessions/${encodeURIComponent(sessionId)}/claude-md`,
				{
					method: "PUT",
					body: { content, path: filePath, checksum },
				},
			);
			if (res.ok) {
				ctx.log(
					`[sync] Uploaded ${name} for ${logSafe(sessionId)} (${(content.length / 1024).toFixed(1)}KB)`,
				);
			}
		} catch {
			// Retried on the next sync tick while the server has no checksum.
		}
		return;
	}
}

type ClaudeMdSessionRow = {
	sessionId: string;
	cwd?: string | null;
	agentType?: string | null;
	claudeMdPath?: string | null;
	claudeMdChecksum?: string | null;
};

export async function syncClaudeMdTick(ctx: RelayContext) {
	if (observeMissing(ctx)) {
		setSyncStatus(ctx, "claudeMd", "disabled_missing_observe", null);
		return;
	}
	let sessions: ClaudeMdSessionRow[];
	try {
		const res = await remoteFetch(ctx, `/api/v1/sessions?limit=${CLAUDE_MD_SESSION_LIMIT}`);
		if (!res.ok) {
			setSyncStatus(ctx, "claudeMd", "error", `HTTP ${res.status} on GET /sessions`);
			return;
		}
		const data = (await res.json()) as { sessions?: ClaudeMdSessionRow[] };
		sessions = Array.isArray(data.sessions) ? data.sessions : [];
	} catch (err) {
		setSyncStatus(ctx, "claudeMd", "error", errorMessage(err));
		return;
	}

	const upload = canUpload(ctx);
	let error: string | null = null;
	for (const session of sessions) {
		const local = ctx.state.localSessions.get(session.sessionId);
		if (!local) continue;
		if (!gateSession(ctx, { sessionId: session.sessionId, cwd: local.cwd }).send) continue;
		try {
			if (session.cwd && session.cwd !== local.cwd) {
				refuseOnce(ctx, session.sessionId, session.cwd, "server_cwd_mismatch");
				continue;
			}
			if (await isForbiddenCwdOnDisk(local.cwd, ctx.paths.home)) {
				refuseOnce(ctx, session.sessionId, local.cwd, "path_forbidden_directory");
				continue;
			}
			if (!session.claudeMdChecksum) {
				if (upload) {
					await uploadClaudeMd(
						ctx,
						session.sessionId,
						local.cwd,
						local.agentType ?? session.agentType,
					);
				}
				continue;
			}
			if (!session.claudeMdPath) continue;
			const lastKnown = ctx.state.localChecksums.get(session.sessionId);
			if (lastKnown === session.claudeMdChecksum) continue;

			const res = await remoteFetch(
				ctx,
				`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/claude-md`,
			);
			if (!res.ok) {
				error = `HTTP ${res.status} on GET /claude-md`;
				continue;
			}
			const md = (await res.json()) as { content?: string; path?: string; checksum?: string };
			if (!md.content || !md.path || !md.checksum) continue;

			const verdict = isSafeInstructionsPath(md.path, local.cwd, ctx.paths.home);
			if (!verdict.ok) {
				refuseOnce(ctx, session.sessionId, md.path, verdict.reason);
				continue;
			}
			const kind = await lstatKind(md.path);
			if (kind === "symlink" || kind === "hardlink" || kind === "other") {
				refuseOnce(ctx, session.sessionId, md.path, `refused_${kind}`);
				continue;
			}

			const localContent = kind === "file" ? await readFileNoFollow(md.path) : "";
			const localChecksum = localContent ? await computeChecksum(localContent) : "";
			if (localChecksum === md.checksum) {
				ctx.state.localChecksums.set(session.sessionId, md.checksum);
				continue;
			}
			if (lastKnown && localChecksum !== lastKnown) {
				ctx.log(`[sync] Conflict on ${logSafe(md.path)} -- server version wins`);
			}
			await writeFileNoFollow(md.path, md.content);
			ctx.state.localChecksums.set(session.sessionId, md.checksum);
			ctx.log(
				`[sync] Wrote ${logSafe(md.path)} from server (${(md.content.length / 1024).toFixed(1)}KB)`,
			);
		} catch (err) {
			error = errorMessage(err);
		}
	}
	setSyncStatus(
		ctx,
		"claudeMd",
		error ? "error" : upload ? "ok" : "upload_disabled_missing_manage",
		error,
	);
}

// ── Codex thread names (D2, D23) ─────────────────────────────────────────────
//
// ~/.codex/session_index.jsonl (or $CODEX_HOME/…) is append-only
// {id, thread_name, updated_at}; the last row per id wins. Codex's /resume
// picker reads it. Every row this relay appends is first recorded in
// <stateDir>/codex-pushed.jsonl (the ledger), so a row can always be told
// apart as AgentPulse-written or Codex-written.
//
// Policy `codex` (default): pull Codex-written names into the dashboard via
// PUT /native-name (a manual dashboard rename still wins, D2); push only
// (a) manual names, (b) names into unnamed threads, (c) restores over our own
// earlier rows. Policy `agentpulse`: never pull; push the dashboard name
// whenever the latest row differs. Every append is capped per id per
// rolling hour (the storm guard, F109), so no id is appended more than 3x/h.

export type CodexIndexRow = { id: string; thread_name: string; updated_at: string };
export type CodexSessionRow = {
	sessionId: string;
	displayName?: string | null;
	nameSource?: string | null;
};

function parseIndexLine(line: string): CodexIndexRow | null {
	if (!line.trim()) return null;
	try {
		const e = JSON.parse(line) as Record<string, unknown>;
		if (typeof e?.id !== "string" || !e.id) return null;
		if (typeof e.thread_name !== "string" || !e.thread_name) return null;
		return {
			id: e.id,
			thread_name: e.thread_name,
			updated_at: typeof e.updated_at === "string" ? e.updated_at : "",
		};
	} catch {
		return null;
	}
}

export function ledgerKey(row: CodexIndexRow): string {
	return JSON.stringify([row.id, row.thread_name, row.updated_at]);
}

/** Malformed ledger lines are skipped; valid ones around them are kept. */
export function parseLedger(raw: string): Set<string> {
	const keys = new Set<string>();
	for (const line of raw.split("\n")) {
		const row = parseIndexLine(line);
		if (row) keys.add(ledgerKey(row));
	}
	return keys;
}

function parseIndexWithKeys(raw: string, ledger: Set<string>) {
	const latest = new Map<string, CodexIndexRow>();
	const latestForeign = new Map<string, CodexIndexRow>();
	const keys = new Set<string>();
	for (const line of raw.split("\n")) {
		const row = parseIndexLine(line);
		if (!row) continue;
		const key = ledgerKey(row);
		keys.add(key);
		latest.set(row.id, row);
		if (!ledger.has(key)) latestForeign.set(row.id, row);
	}
	return { latest, latestForeign, keys };
}

export function parseCodexIndex(
	raw: string,
	ledger: Set<string>,
): { latest: Map<string, CodexIndexRow>; latestForeign: Map<string, CodexIndexRow> } {
	const { latest, latestForeign } = parseIndexWithKeys(raw, ledger);
	return { latest, latestForeign };
}

function shouldPush(
	policy: CodexNamePolicy,
	nameSource: string | null | undefined,
	current: CodexIndexRow | undefined,
	foreign: boolean,
) {
	if (policy === "agentpulse") return true;
	if (nameSource === "user") return true; // (a) a manual name wins
	if (!current) return true; // (b) fill an unnamed thread
	return !foreign; // (c) restore over our own row; never over Codex's
}

/**
 * Pure. Returns the rows to append this tick, the ids the storm guard held
 * back, and the next guard state (push timestamps per id, last hour only).
 */
export function planCodexPushes(
	sessions: CodexSessionRow[],
	latest: Map<string, CodexIndexRow>,
	ledger: Set<string>,
	policy: CodexNamePolicy,
	guard: Record<string, number[]>,
	now: number,
): { rows: CodexIndexRow[]; suppressedIds: string[]; guard: Record<string, number[]> } {
	const nextGuard: Record<string, number[]> = {};
	for (const [id, times] of Object.entries(guard)) {
		const recent = times.filter((t) => now - t < STORM_WINDOW_MS);
		if (recent.length > 0) nextGuard[id] = recent;
	}
	const rows: CodexIndexRow[] = [];
	const suppressedIds: string[] = [];
	const updatedAt = iso(now);
	// F124: offset paging over an activity-ordered list can repeat a row.
	const seen = new Set<string>();
	for (const session of sessions) {
		if (rows.length >= MAX_PUSHES_PER_TICK) break;
		if (!session.sessionId || typeof session.displayName !== "string") continue;
		if (seen.has(session.sessionId)) continue;
		seen.add(session.sessionId);
		const name = sanitizeName(session.displayName);
		if (!name) continue;
		const current = latest.get(session.sessionId);
		if (current?.thread_name === name) continue;
		const foreign = current !== undefined && !ledger.has(ledgerKey(current));
		if (!shouldPush(policy, session.nameSource, current, foreign)) continue;
		const recent = nextGuard[session.sessionId] ?? [];
		if (recent.length >= STORM_MAX_PUSHES) {
			suppressedIds.push(session.sessionId);
			continue;
		}
		nextGuard[session.sessionId] = [...recent, now];
		rows.push({ id: session.sessionId, thread_name: name, updated_at: updatedAt });
	}
	return { rows, suppressedIds, guard: nextGuard };
}

export type CodexIndexSnapshot = {
	/** size/mtime of session_index.jsonl when read ("" if absent), for F145. */
	indexVersion: string;
	ledger: Set<string>;
	ledgerRows: CodexIndexRow[];
	indexKeys: Set<string>;
	latest: Map<string, CodexIndexRow>;
	latestForeign: Map<string, CodexIndexRow>;
};

/** F129: read and parse the index and the ledger once per tick. */
async function indexVersion(path: string): Promise<string> {
	try {
		const st = await stat(path);
		return `${st.size}:${st.mtimeMs}`;
	} catch {
		return "";
	}
}

export async function readCodexIndex(ctx: RelayContext): Promise<CodexIndexSnapshot> {
	const ledgerRaw = await readTextOrEmpty(ctx.paths.ledgerFile);
	// Stat before reading: a write in between makes the version look older
	// than the content, which only costs one extra re-read before appending.
	const version = await indexVersion(ctx.paths.codexIndexFile);
	const indexRaw = await readTextOrEmpty(ctx.paths.codexIndexFile);
	const ledgerRows: CodexIndexRow[] = [];
	for (const line of ledgerRaw.split("\n")) {
		const r = parseIndexLine(line);
		if (r) ledgerRows.push(r);
	}
	const ledger = new Set(ledgerRows.map(ledgerKey));
	// F150: one pass over the index yields latest, latestForeign and keys.
	const { latest, latestForeign, keys } = parseIndexWithKeys(indexRaw, ledger);
	return { indexVersion: version, ledger, ledgerRows, indexKeys: keys, latest, latestForeign };
}

/**
 * F145: the snapshot is taken at tick start, before the pull PUTs and the
 * session list. If Codex wrote a row in that window, a planned row for the
 * same id is stale (a generated fill could land after Codex's title). Re-read
 * the index only if it changed, and return the ids whose latest row moved.
 */
async function idsChangedSinceSnapshot(
	ctx: RelayContext,
	snap: CodexIndexSnapshot,
	ids: string[],
): Promise<Set<string>> {
	const changed = new Set<string>();
	if ((await indexVersion(ctx.paths.codexIndexFile)) === snap.indexVersion) return changed;
	const { latest } = parseCodexIndex(await readTextOrEmpty(ctx.paths.codexIndexFile), snap.ledger);
	for (const id of ids) {
		const before = snap.latest.get(id);
		const now = latest.get(id);
		if ((before ? ledgerKey(before) : "") !== (now ? ledgerKey(now) : "")) changed.add(id);
	}
	return changed;
}

/**
 * F109: the ledger only needs rows that still exist in the index (they're what
 * it classifies). Dropping any row that is still in the index could make one
 * of our own rows look Codex-written, so that is the only compaction done.
 */
async function compactLedgerIfLarge(ctx: RelayContext, snap: CodexIndexSnapshot) {
	if (snap.ledgerRows.length <= ctx.limits.ledgerCompactThreshold) return;
	// F149: Codex's index is append-only, so most attempts would find nothing
	// to drop. Attempt at most once a day, and rewrite only if rows go.
	const now = ctx.now();
	if (now - ctx.state.lastLedgerCompactionAt < LEDGER_COMPACT_INTERVAL_MS) return;
	ctx.state.lastLedgerCompactionAt = now;
	const kept = snap.ledgerRows.filter((r) => snap.indexKeys.has(ledgerKey(r)));
	if (kept.length === snap.ledgerRows.length) return;
	await replacePrivateFile(ctx.paths.ledgerFile, kept.length ? jsonlLines(kept) : "");
	ctx.log(`[codex-name-sync] compacted ledger: ${snap.ledgerRows.length} → ${kept.length} rows`);
}

// F148: no count cap. The index is the real bound: entries for ids no longer
// in it are pruned each tick (pruneMissingPullEntries). A count cap with
// eviction never converged past the cap (an evicted id looks unseen again).
function setPullEntry(ctx: RelayContext, id: string, entry: PullEntryState) {
	ctx.state.codexPull.set(id, entry);
}

function pruneMissingPullEntries(ctx: RelayContext, present: Map<string, unknown>): boolean {
	let pruned = false;
	for (const id of ctx.state.codexPull.keys()) {
		if (!present.has(id)) {
			ctx.state.codexPull.delete(id);
			pruned = true;
		}
	}
	return pruned;
}

async function loadPullState(ctx: RelayContext) {
	ctx.state.pullStateLoaded = true;
	let raw: string;
	try {
		raw = await readFile(ctx.paths.pullStateFile, "utf-8");
	} catch {
		return;
	}
	try {
		const data = JSON.parse(raw) as { entries?: Record<string, Partial<PullEntryState>> };
		for (const [id, e] of Object.entries(data?.entries ?? {})) {
			if (!e || typeof e !== "object") continue;
			setPullEntry(ctx, id, {
				seenKey: typeof e.seenKey === "string" ? e.seenKey : null,
				missKey: typeof e.missKey === "string" ? e.missKey : null,
				missCount: typeof e.missCount === "number" && e.missCount >= 0 ? e.missCount : 0,
			});
		}
	} catch (err) {
		ctx.log(`[codex-name-sync] ignoring unreadable pull state: ${logSafe(errorMessage(err))}`);
	}
}

async function persistPullState(ctx: RelayContext) {
	try {
		await ensurePrivateDir(ctx.paths.stateDir);
		await replacePrivateFile(
			ctx.paths.pullStateFile,
			`${JSON.stringify({ version: 1, entries: Object.fromEntries(ctx.state.codexPull) })}\n`,
		);
	} catch (err) {
		ctx.log(`[codex-name-sync] couldn't save pull state: ${logSafe(errorMessage(err))}`);
	}
}

function retryAfterMs(res: Response, now: number): number {
	const header = res.headers.get("Retry-After");
	let ms = DEFAULT_RETRY_AFTER_MS;
	if (header && /^\d+$/.test(header.trim())) ms = Number(header.trim()) * 1000;
	else if (header && Number.isFinite(Date.parse(header))) ms = Date.parse(header) - now;
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

function isStaleEntry(entry: CodexIndexRow, now: number) {
	const t = Date.parse(entry.updated_at);
	return Number.isFinite(t) && now - t > PULL_STALE_ENTRY_MS;
}

type StepResult = { ok: true; rateLimited?: boolean } | { ok: false; error: string };

/**
 * Codex-written names → PUT /native-name (codex policy only). `applied:false`
 * (a pinned session) counts as seen. Unknown sessions (404) are retried at
 * most 5 times per index entry, or once if the entry is over 24h old, until
 * the entry changes (F18). The seen/miss state is persisted so a restart
 * doesn't re-PUT everything (F125); at most 50 PUTs go out per tick, and a
 * 429 pauses the pull until Retry-After. Any other failure stops the tick.
 */
export async function pullCodexNames(
	ctx: RelayContext,
	snapshot?: CodexIndexSnapshot,
): Promise<StepResult> {
	if (ctx.config.codexNamePolicy !== "codex") return { ok: true };
	if (!ctx.state.pullStateLoaded) await loadPullState(ctx);
	const now = ctx.now();
	if (now < ctx.state.pullRetryAt) return { ok: true, rateLimited: true };
	const { latest, latestForeign } = snapshot ?? (await readCodexIndex(ctx));
	let puts = 0;
	let changed = pruneMissingPullEntries(ctx, latest);
	let result: StepResult = { ok: true };
	for (const [id, entry] of latestForeign) {
		const key = ledgerKey(entry);
		const st = ctx.state.codexPull.get(id) ?? { seenKey: null, missKey: null, missCount: 0 };
		if (st.seenKey === key) continue;
		if (
			st.missKey === key &&
			(st.missCount >= PULL_MAX_CONSECUTIVE_404 || (isStaleEntry(entry, now) && st.missCount >= 1))
		) {
			continue;
		}
		if (puts >= ctx.limits.maxPullPutsPerTick) break;
		// A Codex index row has no cwd: the gate knows the id from its hooks, or not at all.
		if (!gateSession(ctx, { sessionId: id }).send) continue;
		puts++;
		let res: Response;
		try {
			res = await remoteFetch(ctx, `/api/v1/sessions/${encodeURIComponent(id)}/native-name`, {
				method: "PUT",
				body: { name: entry.thread_name },
			});
		} catch (err) {
			result = { ok: false, error: errorMessage(err) };
			break;
		}
		if (res.ok || res.status === 400) {
			// 400 = the name sanitizes to empty; retrying the same entry can't help.
			setPullEntry(ctx, id, { seenKey: key, missKey: null, missCount: 0 });
			changed = true;
			if (res.ok) {
				ctx.log(
					`[codex-name-sync] pull ${logSafe(id.slice(0, 8))} → ${logSafe(entry.thread_name)}`,
				);
			}
		} else if (res.status === 404) {
			const missCount = st.missKey === key ? st.missCount + 1 : 1;
			setPullEntry(ctx, id, { seenKey: st.seenKey, missKey: key, missCount });
			changed = true;
		} else if (res.status === 429) {
			ctx.state.pullRetryAt = now + retryAfterMs(res, now);
			result = { ok: true, rateLimited: true };
			break;
		} else {
			result = { ok: false, error: `HTTP ${res.status} on PUT /native-name` };
			break;
		}
	}
	if (changed) await persistPullState(ctx);
	return result;
}

async function fetchCodexSessions(
	ctx: RelayContext,
): Promise<{ ok: true; sessions: CodexSessionRow[] } | { ok: false; error: string }> {
	const sessions: CodexSessionRow[] = [];
	try {
		for (let page = 0; page < CODEX_MAX_PAGES; page++) {
			const fields = ctx.state.listFieldsUnsupported ? "" : `&fields=${CODEX_LIST_FIELDS}`;
			const res = await remoteFetch(
				ctx,
				`/api/v1/sessions?agent_type=codex_cli&limit=${CODEX_PAGE_SIZE}&offset=${page * CODEX_PAGE_SIZE}${fields}`,
			);
			// F140: a server that doesn't know one of our fields answers 400
			// invalid_field. Fall back to full rows for the life of the process.
			if (res.status === 400 && fields) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				if (body?.error === "invalid_field") {
					ctx.state.listFieldsUnsupported = true;
					ctx.log("[codex-name-sync] server rejected the list projection; using full rows");
					page--;
					continue;
				}
			}
			if (!res.ok) return { ok: false, error: `HTTP ${res.status} on GET /sessions` };
			const data = (await res.json()) as { sessions?: CodexSessionRow[] };
			const rows = Array.isArray(data.sessions) ? data.sessions : [];
			sessions.push(...rows);
			if (rows.length < CODEX_PAGE_SIZE) break;
		}
	} catch (err) {
		return { ok: false, error: errorMessage(err) };
	}
	return { ok: true, sessions };
}

function jsonlLines(rows: CodexIndexRow[]) {
	return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** Dashboard names → session_index.jsonl, ledger first (see header). */
export async function pushCodexNames(
	ctx: RelayContext,
	snapshot?: CodexIndexSnapshot,
): Promise<StepResult> {
	const listed = await fetchCodexSessions(ctx);
	if (!listed.ok) return listed;
	const snap = snapshot ?? (await readCodexIndex(ctx));
	const { latest, ledger } = snap;
	try {
		await compactLedgerIfLarge(ctx, snap);
	} catch (err) {
		ctx.log(`[codex-name-sync] ledger compaction failed: ${logSafe(errorMessage(err))}`);
	}
	const plan = planCodexPushes(
		listed.sessions,
		latest,
		ledger,
		ctx.config.codexNamePolicy,
		ctx.state.pushGuard,
		ctx.now(),
	);
	ctx.state.pushGuard = plan.guard;
	ctx.state.sync.codexNames.suppressedIds = plan.suppressedIds;
	for (const id of plan.suppressedIds) {
		if (ctx.state.suppressedLogged.has(id)) continue;
		ctx.state.suppressedLogged.add(id);
		ctx.log(
			`[codex-name-sync] ${logSafe(id.slice(0, 8))} renamed too often; pushes paused for up to an hour`,
		);
	}
	for (const id of ctx.state.suppressedLogged) {
		if (!plan.suppressedIds.includes(id)) ctx.state.suppressedLogged.delete(id);
	}
	let rows = plan.rows;
	if (rows.length > 0) {
		const stale = await idsChangedSinceSnapshot(
			ctx,
			snap,
			rows.map((r) => r.id),
		);
		if (stale.size > 0) {
			// Drop stale plans and hand their guard slots back; the next tick
			// re-plans against the fresh index.
			rows = rows.filter((r) => !stale.has(r.id));
			const guard = { ...ctx.state.pushGuard };
			for (const id of stale) {
				const slots = (guard[id] ?? []).slice(0, -1);
				if (slots.length > 0) guard[id] = slots;
				else delete guard[id];
			}
			ctx.state.pushGuard = guard;
		}
	}
	if (rows.length === 0) return { ok: true };
	const lines = jsonlLines(rows);
	try {
		// Ledger first: a crash between the two appends leaves an unused ledger
		// row (harmless), never an index row that looks Codex-written.
		await ensurePrivateDir(ctx.paths.stateDir);
		await appendPrivateFile(ctx.paths.ledgerFile, lines);
		await ensurePrivateDir(dirname(ctx.paths.codexIndexFile));
		await appendPrivateFile(ctx.paths.codexIndexFile, lines);
	} catch (err) {
		return { ok: false, error: `append failed: ${errorMessage(err)}` };
	}
	for (const row of rows) {
		ctx.log(`[codex-name-sync] push ${logSafe(row.id.slice(0, 8))} → ${logSafe(row.thread_name)}`);
	}
	return { ok: true };
}

type InstalledState = { codexHooksWrittenAt: string | null; copilotHooksWrittenAt: string | null };

async function readInstalledState(ctx: RelayContext): Promise<InstalledState> {
	const raw = await readTextOrEmpty(ctx.paths.installedFile);
	if (!raw) return { codexHooksWrittenAt: null, copilotHooksWrittenAt: null };
	try {
		const parsed = JSON.parse(raw) as Partial<InstalledState>;
		return {
			codexHooksWrittenAt:
				typeof parsed.codexHooksWrittenAt === "string" ? parsed.codexHooksWrittenAt : null,
			copilotHooksWrittenAt:
				typeof parsed.copilotHooksWrittenAt === "string" ? parsed.copilotHooksWrittenAt : null,
		};
	} catch {
		return { codexHooksWrittenAt: null, copilotHooksWrittenAt: null };
	}
}

/**
 * D22: "Codex hooks installed but never fired" — evidence-based, so it only
 * fires when Codex has demonstrably run since install. SPIKE fact 6 (r6):
 * `codex exec` never writes session_index.jsonl, so this is TUI-only
 * (basis: "tui_activity") by construction — there's no exec-based variant.
 *
 * True iff: codexHooksWrittenAt is set, AND at least one *foreign*
 * (Codex-written, not this relay's own push — see the ledger, F59) index
 * row has updated_at later than it, AND no codex_cli hook has been enqueued
 * since codexHooksWrittenAt.
 */
export function computeCodexHooksNotFiring(
	installed: InstalledState,
	snapshot: CodexIndexSnapshot,
	lastCodexEventAt: string | undefined,
): boolean {
	if (!installed.codexHooksWrittenAt) return false;
	const installedAt = Date.parse(installed.codexHooksWrittenAt);
	if (!Number.isFinite(installedAt)) return false;

	let sawForeignActivitySince = false;
	for (const row of snapshot.latestForeign.values()) {
		const t = Date.parse(row.updated_at);
		if (Number.isFinite(t) && t > installedAt) {
			sawForeignActivitySince = true;
			break;
		}
	}
	if (!sawForeignActivitySince) return false;

	const lastEventAt = lastCodexEventAt ? Date.parse(lastCodexEventAt) : Number.NaN;
	const hookFiredSinceInstall = Number.isFinite(lastEventAt) && lastEventAt > installedAt;
	return !hookFiredSinceInstall;
}

export async function syncCodexNamesTick(ctx: RelayContext) {
	// D22: independent of the observe-gated push/pull below — evidence comes
	// from the local Codex index and this relay's own enqueue history, not
	// from the server.
	const installed = await readInstalledState(ctx);
	const indexSnapshot = await readCodexIndex(ctx);
	ctx.state.hooksNotFiring.codex_cli = computeCodexHooksNotFiring(
		installed,
		indexSnapshot,
		ctx.state.lastEventAtByAgent.codex_cli,
	);
	await writeStatusFile(ctx);

	if (observeMissing(ctx)) {
		setSyncStatus(ctx, "codexNames", "disabled_missing_observe", null);
		return;
	}
	const snapshot = indexSnapshot;
	const pull = await pullCodexNames(ctx, snapshot);
	const push = await pushCodexNames(ctx, snapshot);
	const error = (!pull.ok && pull.error) || (!push.ok && push.error) || null;
	const status = error
		? "error"
		: pull.ok && pull.rateLimited
			? "rate_limited"
			: ctx.state.sync.codexNames.suppressedIds.length > 0
				? "push_suppressed"
				: "ok";
	setSyncStatus(ctx, "codexNames", status, error);
}

// ── Exclude rules: the one gate every outbound path asks ─────────────────────
//
// A user can list directories whose sessions must never be reported. The relay
// evaluates BEFORE anything touches disk or the network, with this precedence:
// the skip header (or allowlisted value), then a session already excluded
// (sticky: once any event of a session is excluded, the id stays excluded for
// its life), then the path rules. "Included" is never sticky. Traffic without a
// cwd (status updates, native-name pushes) is looked up by session id: in the
// excluded set, then in the session → cwd map; only when both miss and rules
// exist is it dropped as `no_cwd`. Invalid rules mean nothing leaves: live hooks
// are dropped, queued ones are held and retried on the normal backoff.

export type ExcludeReason = "skip" | "sticky" | "path" | "rules_invalid" | "no_cwd";
export type ExcludeVerdict = { send: true } | { send: false; reason: ExcludeReason; hold: boolean };
export type GateInput = {
	sessionId?: string | null;
	/** Further ids the same event carries (a payload can spell its id two ways); all are treated as one session. */
	sessionIds?: readonly string[];
	cwd?: string | null;
	/** The raw skip header value, when the request carried one. */
	skip?: string | null;
};

const NO_HOME_RULES: LoadExcludeRulesResult = {
	state: "invalid",
	rules: [],
	reason: "HOME is not set, so the rules file cannot be located",
};

function errnoCode(err: unknown): string {
	return (err as { code?: string }).code ?? "ERR";
}

/** The current rules, re-read only when their signature changed. */
export function refreshExcludeRules(ctx: RelayContext): LoadExcludeRulesResult {
	const ex = ctx.state.exclude;
	ex.probes++;
	const signature = ctx.paths.home
		? excludeRulesSignature(ctx.paths.home, ctx.excludeFs)
		: "no-home";
	if (ex.signature === signature) return ex.rules;
	ex.signature = signature;
	ex.loads++;
	const next = ctx.paths.home ? loadExcludeRules(ctx.paths.home) : NO_HOME_RULES;
	const wasInvalid = ex.rules.state === "invalid";
	ex.rules = next;
	if (ctx.paths.home) setInvalidMarker(ctx.paths.home, next.state === "invalid");
	if (next.state !== "invalid") ex.heldLogged = false;
	if (wasInvalid !== (next.state === "invalid") || next.state === "invalid") {
		if (next.state === "invalid") {
			ctx.log(
				`[relay] exclude rules invalid${next.line !== undefined ? ` (line ${next.line})` : ""}: the relay is sending nothing until the file is fixed`,
			);
		} else {
			ctx.log("[relay] exclude rules are valid again; sending resumes");
		}
		void writeStatusFile(ctx);
	}
	return next;
}

function persistExcludedIds(ctx: RelayContext): void {
	const ex = ctx.state.exclude;
	// An unreadable list is left exactly as found: replacing it would turn "unknown" into "empty".
	if (ex.stickyProblem) return;
	const ids = [...ex.excludedIds.keys(), ...ex.unrecognisedIds];
	const snapshot = `${JSON.stringify({ version: 1, ids })}\n`;
	ex.write = ex.write.then(async () => {
		const before = ex.persistProblem;
		try {
			await ensurePrivateDir(ctx.paths.stateDir);
			await replacePrivateFile(ctx.paths.excludedSessionsFile, snapshot);
			ex.persistProblem = null;
		} catch (err) {
			ctx.log(`[relay] couldn't save the excluded-session list: ${logSafe(errorMessage(err))}`);
			ex.persistProblem = `couldn't save the excluded-session list (${errnoCode(err)}): sessions excluded since the last save may report again after a restart`;
		}
		if (ex.persistProblem !== before) await writeStatusFile(ctx);
	});
}

/**
 * What the sticky set stores for a session id: the id itself when it is shaped
 * like a real one, otherwise a hash of it, so an odd or oversized id is still
 * remembered as excluded (never skipped) without the set holding arbitrary
 * text from a payload.
 */
function stickyKey(id: string): string {
	if (EXCLUDED_ID_RE.test(id)) return id;
	return `${HASHED_ID_PREFIX}${createHash("sha256").update(id).digest("hex")}`;
}

/** Marks `id` excluded for the rest of its life (or touches it, when it already is). */
function markExcludedId(ctx: RelayContext, id: string): void {
	forgetLocalSession(ctx, id);
	const key = stickyKey(id);
	const ids = ctx.state.exclude.excludedIds;
	let changed = !ids.has(key);
	ids.delete(key);
	ids.set(key, true);
	while (ids.size > ctx.limits.maxExcludedIds) {
		const oldest = ids.keys().next().value;
		if (oldest === undefined) break;
		ids.delete(oldest);
		changed = true;
	}
	if (changed) persistExcludedIds(ctx);
}

/** Restores the sticky set at startup; anything not shaped like a session id matches nothing and is kept as it was. */
export async function loadExcludedIds(ctx: RelayContext): Promise<void> {
	const unknown = (why: string) => {
		ctx.state.exclude.stickyProblem = `excluded-session list unreadable (${why}): events without a directory are not sent until it is fixed or deleted and the relay restarted`;
		ctx.log(
			`[relay] the excluded-session list is unreadable (${why}); nothing without a directory is sent`,
		);
	};
	let raw: string;
	try {
		raw = await readFile(ctx.paths.excludedSessionsFile, "utf-8");
	} catch (err) {
		// No file is simply no excluded sessions yet; a file that is there but cannot be read is not.
		if (errnoCode(err) !== "ENOENT") unknown(errnoCode(err));
		return;
	}
	try {
		const data = JSON.parse(raw) as { ids?: unknown };
		if (!Array.isArray(data?.ids)) throw new Error("no ids list");
		const ids = data.ids;
		for (const id of ids) {
			if (typeof id === "string" && EXCLUDED_ID_RE.test(id)) {
				ctx.state.exclude.excludedIds.set(id, true);
			} else if (ctx.state.exclude.unrecognisedIds.length < ctx.limits.maxExcludedIds) {
				// Not an id this relay would have written (another version's, or typed by hand): it matches
				// nothing, but a save must not be the thing that deletes it.
				ctx.state.exclude.unrecognisedIds.push(id);
			}
		}
		while (ctx.state.exclude.excludedIds.size > ctx.limits.maxExcludedIds) {
			const oldest = ctx.state.exclude.excludedIds.keys().next().value;
			if (oldest === undefined) break;
			ctx.state.exclude.excludedIds.delete(oldest);
		}
	} catch {
		unknown("not valid");
	}
}

/** The distinct non-empty ids an input names, in the order given. */
function sessionIdsOf(input: GateInput): string[] {
	const out: string[] = [];
	for (const id of [input.sessionId, ...(input.sessionIds ?? [])]) {
		if (typeof id === "string" && id && !out.includes(id)) out.push(id);
	}
	return out;
}

/** Decides whether anything about this session may leave the machine. Never throws. */
export function gateSession(ctx: RelayContext, input: GateInput): ExcludeVerdict {
	const rules = refreshExcludeRules(ctx);
	const sticky = ctx.state.exclude.excludedIds;
	const ids = sessionIdsOf(input);
	const markAll = () => {
		for (const id of ids) markExcludedId(ctx, id);
	};
	if (isSkipHeaderValue(input.skip)) {
		markAll();
		return { send: false, reason: "skip", hold: false };
	}
	if (ids.some((id) => sticky.has(stickyKey(id)))) {
		markAll();
		return { send: false, reason: "sticky", hold: false };
	}
	if (rules.state === "invalid") return { send: false, reason: "rules_invalid", hold: true };
	// Which sessions are excluded is unknown, so traffic that cannot be judged by a directory is not sent.
	if (ctx.state.exclude.stickyProblem && !input.cwd) {
		return { send: false, reason: "no_cwd", hold: false };
	}
	if (rules.state === "none") return { send: true };
	let cwd = input.cwd;
	if (!cwd) {
		for (const id of ids) {
			cwd = ctx.state.localSessions.get(id)?.cwd;
			if (cwd) break;
		}
	}
	const verdict = evaluateExclusion({ cwd, skip: undefined, rules });
	if (!verdict.excluded) return { send: true };
	if (verdict.reason === "path") {
		markAll();
		return { send: false, reason: "path", hold: false };
	}
	// An unknown or unusable cwd: dropped, but not remembered; a later event may carry a real one.
	return { send: false, reason: "no_cwd", hold: false };
}

function countExcludeDrop(ctx: RelayContext, reason: ExcludeReason) {
	ctx.state.exclude.drops[reason]++;
}

type HookPayload = {
	session_id?: unknown;
	sessionId?: unknown;
	cwd?: unknown;
	hook_event_name?: unknown;
};

function parseHookPayload(body: string): HookPayload | null {
	try {
		const value = JSON.parse(body) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as HookPayload)
			: null;
	} catch {
		return null;
	}
}

/**
 * Who an event is about. The server accepts the id as `session_id` (Claude,
 * Codex) or `sessionId` (Copilot's own spelling); so does this: every
 * non-empty string among them counts, and a present value that is not a string
 * is not an id (the directory rule decides).
 */
function payloadIdentity(payload: HookPayload | null): { sessionIds: string[]; cwd?: string } {
	return {
		sessionIds: sessionIdsOf({
			sessionIds: [payload?.session_id, payload?.sessionId].filter(
				(id): id is string => typeof id === "string",
			),
		}),
		cwd: typeof payload?.cwd === "string" ? payload.cwd : undefined,
	};
}

/** The same decision for a queued item, against the rules as they are now (the skip header is not stored with it). */
function gateQueuedItem(ctx: RelayContext, item: { body: string }): ExcludeVerdict {
	return gateSession(ctx, payloadIdentity(parseHookPayload(item.body)));
}

/** `/api/v1/sessions/stats` is the dashboard's aggregate read, not a session. */
const SESSIONS_COLLECTION_SEGMENTS = new Set(["stats"]);

/** The id in a proxied session path, when it is one of the session-bearing forms. */
function proxiedSessionId(pathname: string): string | null {
	if (!SESSION_DETAIL_PATH_RE.test(pathname) && !NATIVE_NAME_PATH_RE.test(pathname)) return null;
	try {
		const id = decodeURIComponent(pathname.split("/")[4] ?? "");
		return id && !SESSIONS_COLLECTION_SEGMENTS.has(id) ? id : null;
	} catch {
		return null;
	}
}

/**
 * What the proxy tells a local caller whose session lookup was refused. Only
 * the three reasons that mean "this session is excluded" say so: a session the
 * relay has simply never seen (a direct-mode session, or one from before the
 * relay started) must not be reported as excluded, because the caller shows
 * that sentence to the user.
 */
function refusedLookupError(
	reason: ExcludeReason,
): "excluded" | "unknown_session" | "rules_invalid" {
	if (reason === "skip" || reason === "sticky" || reason === "path") return "excluded";
	return reason === "rules_invalid" ? "rules_invalid" : "unknown_session";
}

/** Follows symlinks that moved since the rules were read; bounded by the rule cap, no file read. */
function reresolveExcludeRules(ctx: RelayContext): void {
	const ex = ctx.state.exclude;
	if (ex.rules.state !== "ok" || !ctx.paths.home) return;
	const next = reresolveRules(ex.rules.rules, ctx.paths.home);
	if (next.some((rule, i) => rule !== ex.rules.rules[i])) ex.rules = { ...ex.rules, rules: next };
}

export async function excludeTick(ctx: RelayContext) {
	refreshExcludeRules(ctx);
	reresolveExcludeRules(ctx);
	await writeStatusFile(ctx);
}

// ── Hook queue and forwarding ────────────────────────────────────────────────

type HookQueueItem = {
	id: string;
	pathname: string;
	search: string;
	method: string;
	contentType: string;
	agentType: string | null;
	body: string;
	createdAt: string;
	attempts: number;
	nextAttemptAt: string;
	lastError: string | null;
};

export type ForwardVerdict = "delivered" | "retry" | "drop";

/** 2xx delivered; auth, timeout, rate-limit and server errors retry; other 4xx drop. */
export function classifyForwardStatus(status: number): ForwardVerdict {
	if (status >= 200 && status < 300) return "delivered";
	if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) {
		return "retry";
	}
	return "drop";
}

function agentKey(header: string | null): string {
	const value = (header ?? "").trim().toLowerCase();
	if (!value) return DEFAULT_AGENT_TYPE;
	return /^[a-z0-9_]{1,32}$/.test(value) ? value : "unknown";
}

async function ensureQueueDirs(ctx: RelayContext) {
	await ensurePrivateDir(ctx.paths.hookPendingDir);
	await ensurePrivateDir(ctx.paths.hookProcessingDir);
}

/**
 * A queue file is written under a `.tmp` name and renamed into place; one that
 * outlives a crash holds a hook payload and no lease will ever read it. Old
 * ones are deleted (a young one may be a write still in flight).
 */
async function sweepOrphanedTempFiles(ctx: RelayContext, entries: string[]) {
	for (const name of entries) {
		if (!name.endsWith(".tmp")) continue;
		const path = join(ctx.paths.hookPendingDir, name);
		try {
			if (Date.now() - (await stat(path)).mtimeMs < ORPHAN_TMP_MIN_AGE_MS) continue;
			await unlink(path);
		} catch {}
	}
}

/**
 * At startup nothing of this process is in flight, so whatever a crashed run left in processing/ is
 * queued again. A round after that only takes back what is stranded: an item this process leased and
 * could not hand back, or one whose lease is older than the lease timeout (a relay that crashed).
 * A lease some other relay sharing the state directory took a moment ago is left alone.
 */
async function recoverInterruptedHooks(ctx: RelayContext, scope: "startup" | "round") {
	const leased = ctx.state.queue.leased;
	const inProcessing = (await readdir(ctx.paths.hookProcessingDir)).filter((n) =>
		n.endsWith(".json"),
	);
	for (const name of [...leased]) if (!inProcessing.includes(name)) leased.delete(name);
	for (const name of inProcessing) {
		const path = join(ctx.paths.hookProcessingDir, name);
		try {
			if (scope === "round" && !leased.has(name)) {
				// The change time is when the item was moved into processing/ (a rename leaves the modification time alone).
				const leasedAtMs = (await stat(path)).ctimeMs;
				if (ctx.now() - leasedAtMs < ctx.limits.leaseTimeoutMs) continue;
			}
			await rename(path, join(ctx.paths.hookPendingDir, name));
			leased.delete(name);
		} catch (err) {
			ctx.log(`[relay] queue: couldn't requeue ${logSafe(name)}: ${logSafe(errorMessage(err))}`);
		}
	}
}

/**
 * F122: pending files are named `<enqueue ms>-<uuid>.json`, so the name order
 * is the age order. Drops everything past the max age, then the oldest past
 * the max count, with one log line per drop.
 */
async function enforceQueueLimits(ctx: RelayContext) {
	const entries = await readdir(ctx.paths.hookPendingDir);
	await sweepOrphanedTempFiles(ctx, entries);
	const names = entries.filter((n) => n.endsWith(".json")).sort();
	const cutoff = ctx.now() - ctx.limits.maxQueueAgeMs;
	const drop: string[] = [];
	const keep: string[] = [];
	for (const name of names) {
		const enqueuedAt = Number(name.split("-")[0]);
		if (Number.isFinite(enqueuedAt) && enqueuedAt < cutoff) drop.push(name);
		else keep.push(name);
	}
	const overflow = keep.length - ctx.limits.maxQueueFiles;
	if (overflow > 0) drop.push(...keep.slice(0, overflow));
	if (drop.length === 0) return;
	for (const name of drop) {
		try {
			await unlink(join(ctx.paths.hookPendingDir, name));
		} catch {}
	}
	ctx.state.queue.dropped += drop.length;
	ctx.log(
		`[relay] dropped ${drop.length} queued hook(s): the queue keeps at most ${ctx.limits.maxQueueFiles} files, none older than ${Math.round(ctx.limits.maxQueueAgeMs / 3_600_000)}h`,
	);
}

async function forwardApiRequest(
	ctx: RelayContext,
	input: {
		pathname: string;
		search: string;
		method: string;
		contentType: string;
		agentType?: string | null;
		body?: string;
		/** AGEN-16: stamped only on queued POSTs to exactly /api/v1/hooks; stable across retries. */
		deliveryId?: string;
	},
) {
	const headers = new Headers();
	headers.set("Content-Type", input.contentType || "application/json");
	if (ctx.config.apiKey) headers.set("Authorization", `Bearer ${ctx.config.apiKey}`);
	if (input.agentType) headers.set("X-Agent-Type", input.agentType);
	if (input.deliveryId && input.pathname === "/api/v1/hooks") {
		headers.set(DELIVERY_ID_HEADER, input.deliveryId);
	}

	const response = await ctx.fetch(`${ctx.config.remoteUrl}${input.pathname}${input.search}`, {
		method: input.method,
		headers,
		body: input.method !== "GET" ? input.body : undefined,
		signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
	});

	return new Response(await response.text(), {
		status: response.status,
		headers: {
			"Content-Type": response.headers.get("Content-Type") || "application/json",
		},
	});
}

function nextBackoffMs(attempts: number) {
	return Math.min(HOOK_RETRY_MAX_MS, HOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function scheduleQueue(ctx: RelayContext, delayMs = 0) {
	if (!ctx.autoSchedule) return;
	if (ctx.state.queueTimer) clearTimeout(ctx.state.queueTimer);
	ctx.state.queueTimer = setTimeout(() => {
		ctx.state.queueTimer = null;
		void processHookQueue(ctx);
	}, delayMs);
}

async function enqueueHook(ctx: RelayContext, req: Request, url: URL) {
	const body = await req.text();
	const payload = parseHookPayload(body);
	const identity = payloadIdentity(payload);
	const verdict = gateSession(ctx, { ...identity, skip: req.headers.get(SKIP_HEADER) });
	if (!verdict.send) {
		// Nothing is written, recorded or uploaded; the agent gets the answer a forwarded hook gets.
		countExcludeDrop(ctx, verdict.reason);
		return { queued: true, queueId: crypto.randomUUID() };
	}

	await ensureQueueDirs(ctx);
	const createdAt = iso(ctx.now());
	const item: HookQueueItem = {
		id: crypto.randomUUID(),
		pathname: url.pathname,
		search: url.search,
		method: req.method,
		contentType: req.headers.get("Content-Type") || "application/json",
		agentType: req.headers.get("X-Agent-Type"),
		body,
		createdAt,
		attempts: 0,
		nextAttemptAt: createdAt,
		lastError: null,
	};

	// Atomic: a lease running at the same moment must never see a half-written file (it would
	// delete it as corrupt).
	await writeQueueFile(
		ctx,
		join(ctx.paths.hookPendingDir, `${ctx.now()}-${item.id}.json`),
		JSON.stringify(item),
	);
	ctx.state.queue.lastHookEnqueuedAt = createdAt;
	ctx.state.lastEventAtByAgent[agentKey(item.agentType)] = createdAt;
	await enforceQueueLimits(ctx);
	scheduleQueue(ctx);

	// The only source of the cwds CLAUDE.md sync may touch.
	if (identity.cwd) {
		for (const id of identity.sessionIds) {
			await recordLocalSession(ctx, id, identity.cwd, agentKey(item.agentType));
		}
	}
	if (
		url.pathname === "/api/v1/hooks" &&
		payload?.hook_event_name === "SessionStart" &&
		identity.cwd &&
		canUpload(ctx)
	) {
		void uploadClaudeMd(ctx, identity.sessionIds[0] ?? "", identity.cwd, item.agentType);
	}

	return { queued: true, queueId: item.id };
}

async function leaseNextHook(
	ctx: RelayContext,
): Promise<{ fileName: string; item: HookQueueItem } | null> {
	await ensureQueueDirs(ctx);
	const fileNames = (await readdir(ctx.paths.hookPendingDir))
		.filter((name) => name.endsWith(".json"))
		.sort();
	const now = Date.now();

	for (const fileName of fileNames) {
		const pendingPath = join(ctx.paths.hookPendingDir, fileName);
		// An item whose handling threw waits out its backoff; the ones behind it are not held up.
		if ((ctx.state.queue.handling.get(fileName)?.nextAtMs ?? 0) > ctx.now()) continue;
		try {
			const item = JSON.parse(await readFile(pendingPath, "utf-8")) as HookQueueItem;
			if (Date.parse(item.nextAttemptAt) > now) continue;
			await rename(pendingPath, join(ctx.paths.hookProcessingDir, fileName));
			ctx.state.queue.leased.add(fileName);
			return { fileName, item };
		} catch (error) {
			ctx.log(`[relay] Failed to lease queued hook: ${errorMessage(error)}`);
			try {
				await unlink(pendingPath);
			} catch {}
		}
	}

	return null;
}

async function releaseHookFailure(
	ctx: RelayContext,
	fileName: string,
	item: HookQueueItem,
	rawMessage: string,
) {
	const message = redact(ctx, rawMessage);
	const updated: HookQueueItem = {
		...item,
		attempts: item.attempts + 1,
		lastError: message,
		nextAttemptAt: new Date(Date.now() + nextBackoffMs(item.attempts + 1)).toISOString(),
	};

	await writeQueueFile(ctx, join(ctx.paths.hookPendingDir, fileName), JSON.stringify(updated));
	try {
		await unlink(join(ctx.paths.hookProcessingDir, fileName));
	} catch {}

	const q = ctx.state.queue;
	q.lastHookFailureAt = iso(ctx.now());
	q.lastHookError = message;
	q.consecutiveHookFailures += 1;
	ctx.log(`[relay] Hook forward failed (${updated.attempts} attempts): ${message}`);
	scheduleQueue(ctx, nextBackoffMs(updated.attempts));
}

async function dropHook(ctx: RelayContext, fileName: string, status: number) {
	try {
		await unlink(join(ctx.paths.hookProcessingDir, fileName));
	} catch {}
	const q = ctx.state.queue;
	q.lastHookFailureAt = iso(ctx.now());
	q.lastHookError = `dropped: HTTP ${status}`;
	q.consecutiveHookFailures += 1;
	ctx.log(`[relay] Dropped hook the server rejected (HTTP ${status})`);
}

/** Waits out the normal backoff without counting as a failure: the server was never asked. */
async function holdHook(ctx: RelayContext, fileName: string, item: HookQueueItem) {
	const updated: HookQueueItem = {
		...item,
		attempts: item.attempts + 1,
		lastError: HELD_ERROR,
		nextAttemptAt: new Date(Date.now() + nextBackoffMs(item.attempts + 1)).toISOString(),
	};
	await writeQueueFile(ctx, join(ctx.paths.hookPendingDir, fileName), JSON.stringify(updated));
	try {
		await unlink(join(ctx.paths.hookProcessingDir, fileName));
	} catch {}
	if (!ctx.state.exclude.heldLogged) {
		ctx.state.exclude.heldLogged = true;
		ctx.log(
			"[relay] holding queued hooks: the exclude rules are invalid; nothing is sent until the file is fixed",
		);
	}
	scheduleQueue(ctx, nextBackoffMs(updated.attempts));
}

async function dropExcludedHook(ctx: RelayContext, fileName: string, reason: ExcludeReason) {
	try {
		await unlink(join(ctx.paths.hookProcessingDir, fileName));
	} catch {}
	countExcludeDrop(ctx, reason);
	ctx.log("[relay] dropped a queued hook: its session is excluded");
}

async function completeHookSuccess(ctx: RelayContext, fileName: string) {
	try {
		await unlink(join(ctx.paths.hookProcessingDir, fileName));
	} catch {}
	const q = ctx.state.queue;
	q.lastHookForwardedAt = iso(ctx.now());
	q.lastHookError = null;
	q.consecutiveHookFailures = 0;
}

async function handleLeasedHook(
	ctx: RelayContext,
	leased: { fileName: string; item: HookQueueItem },
) {
	const gate = gateQueuedItem(ctx, leased.item);
	if (!gate.send) {
		if (gate.hold) await holdHook(ctx, leased.fileName, leased.item);
		else await dropExcludedHook(ctx, leased.fileName, gate.reason);
		return;
	}
	try {
		const res = await forwardApiRequest(ctx, { ...leased.item, deliveryId: leased.item.id });
		const verdict = classifyForwardStatus(res.status);
		if (verdict === "delivered") await completeHookSuccess(ctx, leased.fileName);
		else if (verdict === "retry") {
			await releaseHookFailure(ctx, leased.fileName, leased.item, `HTTP ${res.status}`);
		} else await dropHook(ctx, leased.fileName, res.status);
	} catch (error) {
		await releaseHookFailure(ctx, leased.fileName, leased.item, errorMessage(error));
	}
}

/** Puts a leased item back as it was, so an unexpected error never strands it in processing/. */
async function returnToPending(ctx: RelayContext, fileName: string, cause: unknown) {
	ctx.log(
		`[relay] queue: couldn't finish a queued hook (${logSafe(errorMessage(cause))}); it stays queued`,
	);
	try {
		await rename(
			join(ctx.paths.hookProcessingDir, fileName),
			join(ctx.paths.hookPendingDir, fileName),
		);
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return;
		ctx.log(`[relay] queue: couldn't requeue ${logSafe(fileName)}: ${logSafe(errorMessage(err))}`);
	}
}

/** Moves a leased item to the parked directory: kept for the user, never read or sent again. False when it could not be moved. */
async function parkHook(ctx: RelayContext, fileName: string): Promise<boolean> {
	try {
		await ensurePrivateDir(ctx.paths.hookParkedDir);
		await rename(
			join(ctx.paths.hookProcessingDir, fileName),
			join(ctx.paths.hookParkedDir, fileName),
		);
	} catch (err) {
		ctx.log(
			`[relay] queue: couldn't set aside ${logSafe(fileName)}: ${logSafe(errorMessage(err))}`,
		);
		return false;
	}
	ctx.state.queue.parked += 1;
	await trimParked(ctx);
	void writeStatusFile(ctx);
	return true;
}

/** Keeps the parked directory to its cap: the oldest goes first (names sort by enqueue time), one log line each, naming only the file. */
async function trimParked(ctx: RelayContext) {
	let names: string[];
	try {
		names = (await readdir(ctx.paths.hookParkedDir)).filter((n) => n.endsWith(".json")).sort();
	} catch {
		return;
	}
	for (const name of names.slice(0, Math.max(0, names.length - ctx.limits.maxParkedItems))) {
		try {
			await unlink(join(ctx.paths.hookParkedDir, name));
		} catch {
			continue;
		}
		ctx.state.queue.parked = Math.max(0, ctx.state.queue.parked - 1);
		ctx.log(
			`[relay] queue: the parked directory keeps at most ${ctx.limits.maxParkedItems} items; dropped ${logSafe(name)}`,
		);
	}
}

/**
 * Handling a leased item threw. It is counted and backed off, so it neither blocks the items behind
 * it nor is tried in a tight loop; after enough failures it is set aside instead.
 */
async function recordHandlingFailure(ctx: RelayContext, fileName: string, cause: unknown) {
	const handling = ctx.state.queue.handling;
	const failures = (handling.get(fileName)?.failures ?? 0) + 1;
	if (failures >= HANDLING_MAX_FAILURES) {
		ctx.log(
			`[relay] queue: set aside a queued hook after ${failures} failures (${logSafe(errorMessage(cause))}); it is kept in hook-queue/parked`,
		);
		if (await parkHook(ctx, fileName)) {
			handling.delete(fileName);
			return;
		}
	}
	handling.set(fileName, { failures, nextAtMs: ctx.now() + nextBackoffMs(failures) });
	await returnToPending(ctx, fileName, cause);
}

export async function processHookQueue(ctx: RelayContext) {
	if (ctx.state.queueRunning) return;
	ctx.state.queueRunning = true;
	try {
		// Nothing of this process is in flight when a round starts (rounds never overlap), so whatever
		// this process leased and finds in processing/ was stranded by a lease or a release that failed:
		// it is queued again now (and so is a lease old enough that nobody can still be handling it).
		await recoverInterruptedHooks(ctx, "round");
		while (true) {
			const leased = await leaseNextHook(ctx);
			if (!leased) break;
			try {
				await handleLeasedHook(ctx, leased);
				ctx.state.queue.handling.delete(leased.fileName);
			} catch (error) {
				await recordHandlingFailure(ctx, leased.fileName, error);
			}
		}
	} catch (error) {
		ctx.log(`[relay] queue: a round failed (${logSafe(errorMessage(error))}); trying again later`);
		scheduleQueue(ctx, nextBackoffMs(1));
	} finally {
		ctx.state.queueRunning = false;
	}
}

export async function getQueueDiagnostics(ctx: RelayContext) {
	await ensureQueueDirs(ctx);
	const pending = (await readdir(ctx.paths.hookPendingDir)).filter((n) => n.endsWith(".json"));
	const processing = (await readdir(ctx.paths.hookProcessingDir)).filter((n) =>
		n.endsWith(".json"),
	);
	let oldestPendingAt: string | null = null;
	for (const fileName of pending) {
		try {
			const item = JSON.parse(
				await readFile(join(ctx.paths.hookPendingDir, fileName), "utf-8"),
			) as HookQueueItem;
			if (!oldestPendingAt || item.createdAt < oldestPendingAt) oldestPendingAt = item.createdAt;
		} catch {}
	}
	const q = ctx.state.queue;
	return {
		pending: pending.length,
		processing: processing.length,
		oldestPendingAt,
		lastHookEnqueuedAt: q.lastHookEnqueuedAt,
		lastHookForwardedAt: q.lastHookForwardedAt,
		lastHookFailureAt: q.lastHookFailureAt,
		lastHookError: q.lastHookError === null ? null : redact(ctx, q.lastHookError),
		consecutiveHookFailures: q.consecutiveHookFailures,
		dropped: q.dropped,
		parked: q.parked,
	};
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

async function countHeldHooks(ctx: RelayContext): Promise<number> {
	let held = 0;
	for (const name of await readdir(ctx.paths.hookPendingDir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const item = JSON.parse(await readFile(join(ctx.paths.hookPendingDir, name), "utf-8")) as {
				lastError?: string | null;
			};
			if (item.lastError === HELD_ERROR) held++;
		} catch {}
	}
	return held;
}

/** Counts and states only: no paths, no session ids. */
async function buildExcludeDiagnostics(ctx: RelayContext) {
	const rules = refreshExcludeRules(ctx);
	return {
		state: rules.state,
		ruleCount: rules.rules.length,
		mode: rules.mode === undefined ? null : rules.mode.toString(8).padStart(4, "0"),
		mtime: rules.mtimeMs === undefined ? null : iso(rules.mtimeMs),
		invalidLine: rules.state === "invalid" ? (rules.line ?? null) : null,
		drops: { ...ctx.state.exclude.drops },
		held: await countHeldHooks(ctx),
	};
}

/** Additive over the pre-Phase-3 shape {status, relay, remote, queue} (F34). */
export async function buildDiagnostics(ctx: RelayContext) {
	const { auth, sync, drift } = ctx.state;
	return {
		status: "ok",
		relay: true,
		remote: ctx.config.remoteUrl,
		queue: await getQueueDiagnostics(ctx),
		exclude: await buildExcludeDiagnostics(ctx),
		auth: {
			scopes: auth.scopes,
			missing: auth.missing,
			hasManage: auth.hasManage,
			checkedAt: auth.checkedAt,
			degraded: auth.degraded,
			keyRejected: auth.keyRejected,
			lastError: auth.lastError === null ? null : logSafe(redact(ctx, auth.lastError)),
		},
		sync: {
			codexNames: {
				status: sync.codexNames.status,
				lastError: sync.codexNames.lastError && redact(ctx, sync.codexNames.lastError),
				lastSuccessAt: sync.codexNames.lastSuccessAt,
				policy: ctx.config.codexNamePolicy,
				suppressedIds: sync.codexNames.suppressedIds,
			},
			claudeMd: {
				status: sync.claudeMd.status,
				lastError: sync.claudeMd.lastError && redact(ctx, sync.claudeMd.lastError),
				lastSuccessAt: sync.claudeMd.lastSuccessAt,
			},
		},
		drift: { relay: drift.relay, statusline: drift.statusline },
		relayHash: ctx.state.relayHash,
		// D22: an agent key can appear here from either signal — it fired at
		// least once (lastEventAtByAgent) or the hooks_not_firing evidence
		// fired without it ever having (installed, Codex demonstrably ran,
		// but no hook ever arrived).
		agents: Object.fromEntries(
			[
				...new Set([
					...Object.keys(ctx.state.lastEventAtByAgent),
					...Object.keys(ctx.state.hooksNotFiring),
				]),
			].map((agent) => [
				agent,
				{
					lastEventAt: ctx.state.lastEventAtByAgent[agent] ?? null,
					...(ctx.state.hooksNotFiring[agent]
						? { status: "hooks_not_firing", basis: "tui_activity" }
						: {}),
				},
			]),
		),
	};
}

const SESSION_DETAIL_PATH_RE = /^\/api\/v1\/sessions\/[^/]+$/;
const NATIVE_NAME_PATH_RE = /^\/api\/v1\/sessions\/[^/]+\/native-name$/;

/**
 * F108: the proxy lends the relay's API key to any local process, so it
 * forwards only what local producers need: hooks, the statusline's session
 * lookup, and its native-name push.
 */
/** F138: `/api/v1/hooks` and its subpaths only, never `/api/v1/hooksX`. */
function isHooksPath(pathname: string): boolean {
	return pathname === "/api/v1/hooks" || pathname.startsWith("/api/v1/hooks/");
}

export function isForwardAllowed(method: string, pathname: string): boolean {
	if (isHooksPath(pathname)) return true;
	const m = method.toUpperCase();
	if (m === "GET" && SESSION_DETAIL_PATH_RE.test(pathname)) return true;
	if (m === "PUT" && NATIVE_NAME_PATH_RE.test(pathname)) return true;
	return false;
}

/** F111: plain http:// to anything but loopback sends the key in the clear. */
export function isInsecureRemote(remoteUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(remoteUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase();
	return !(host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host));
}

/**
 * F137: older relays left the state dir 0755 and its files 0644. Tighten the
 * relay's own dirs and files at startup, best-effort (a failure logs, never
 * throws). A dev checkout's script directory, used as the state dir only
 * when nothing else is configured, is left alone.
 */
async function tightenStateModes(ctx: RelayContext) {
	const { stateDir, home, relayScriptFile } = ctx.paths;
	const isScriptDir = resolve(stateDir) === resolve(dirname(relayScriptFile));
	const isDefaultDir = Boolean(home) && resolve(stateDir) === resolve(join(home, ".agentpulse"));
	const queueDir = dirname(ctx.paths.hookPendingDir);
	const logsDir = join(stateDir, "logs");
	const dirs = [
		queueDir,
		ctx.paths.hookPendingDir,
		ctx.paths.hookProcessingDir,
		ctx.paths.hookParkedDir,
		logsDir,
	];
	if (!isScriptDir || isDefaultDir) dirs.unshift(stateDir);
	const files = [
		ctx.paths.statusFile,
		ctx.paths.ledgerFile,
		ctx.paths.localSessionsFile,
		ctx.paths.pullStateFile,
		ctx.paths.excludedSessionsFile,
		...(home ? [join(home, EXCLUDE_RULES_RELATIVE_PATH)] : []),
		join(logsDir, "relay.log"),
		join(logsDir, "relay.err"),
		...(ctx.config.configPath ? [ctx.config.configPath] : []),
	];
	for (const dir of [
		ctx.paths.hookPendingDir,
		ctx.paths.hookProcessingDir,
		ctx.paths.hookParkedDir,
	]) {
		try {
			for (const name of await readdir(dir)) files.push(join(dir, name));
		} catch {}
	}
	// F152: lstat first; symlinks and entries of the wrong type are skipped, so
	// a link planted in the state dir can't redirect the chmod.
	const apply = async (path: string, mode: number) => {
		try {
			const st = await lstat(path);
			if (st.isSymbolicLink()) return;
			if (mode === PRIVATE_DIR_MODE ? !st.isDirectory() : !st.isFile()) return;
			await chmod(path, mode);
		} catch (err) {
			if ((err as { code?: string }).code !== "ENOENT") {
				ctx.log(`[relay] couldn't restrict ${logSafe(path)}: ${logSafe(errorMessage(err))}`);
			}
		}
	};
	for (const dir of dirs) await apply(dir, PRIVATE_DIR_MODE);
	for (const file of files) await apply(file, PRIVATE_FILE_MODE);
}

function startupWarnings(ctx: RelayContext) {
	if (isInsecureRemote(ctx.config.remoteUrl)) {
		ctx.log(
			"[relay] warning: the remote uses plain http:// to a non-loopback host; the API key and hook payloads travel unencrypted",
		);
	}
	// F126: statusline.sh reads ${AGENTPULSE_DIR:-$HOME/.agentpulse}/status.
	const home = ctx.paths.home;
	if (home && resolve(ctx.paths.stateDir) !== resolve(join(home, ".agentpulse"))) {
		ctx.log(
			`[relay] statusline: this relay's status file is ${ctx.paths.statusFile}; run Claude with AGENTPULSE_DIR=${ctx.paths.stateDir} so the statusline shows its hints`,
		);
	}
}

export function createFetchHandler(ctx: RelayContext) {
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const verdict = isAllowedLocalRequest(req.headers, ctx.port);
		if (!verdict.ok) {
			ctx.log(
				`[relay] 403 ${verdict.reason} (${verdict.detail}) ${logSafe(req.method)} ${logSafe(url.pathname)}`,
			);
			return Response.json({ error: verdict.reason }, { status: 403 });
		}

		if (url.pathname === "/api/v1/health") {
			return Response.json({
				status: "ok",
				relay: true,
				/** Tells local callers (the statusline) that this relay applies exclude rules; an older relay has no such field. */
				enforcesExcludeRules: true,
				remote: ctx.config.remoteUrl,
				warnings: computeWarnings(ctx.state),
			});
		}

		if (url.pathname === "/api/v1/relay/diagnostics") {
			return Response.json(await buildDiagnostics(ctx));
		}

		if (url.pathname === "/api/v1/relay/exclude-check") {
			const cwd = url.searchParams.get("cwd");
			if (!cwd) return Response.json({ error: "cwd_required" }, { status: 400 });
			const rules = refreshExcludeRules(ctx);
			// Yes or no only: any local process can ask, and the rules file is private to its owner.
			const result = evaluateExclusion({ cwd, skip: undefined, rules });
			return Response.json({
				excluded: result.excluded,
				reason: result.reason,
				rulesState: rules.state,
			});
		}

		if (isHooksPath(url.pathname)) {
			const queued = await enqueueHook(ctx, req, url);
			return Response.json({ ok: true, relayed: false, ...queued });
		}

		if (url.pathname.startsWith("/api/")) {
			if (!isForwardAllowed(req.method, url.pathname)) {
				ctx.log(
					`[relay] 403 relay_path_not_allowed ${logSafe(req.method)} ${logSafe(url.pathname)}`,
				);
				return Response.json({ error: "relay_path_not_allowed" }, { status: 403 });
			}
			const sessionId = proxiedSessionId(url.pathname);
			if (sessionId) {
				const gate = gateSession(ctx, { sessionId, skip: req.headers.get(SKIP_HEADER) });
				if (!gate.send) {
					countExcludeDrop(ctx, gate.reason);
					return Response.json({ error: refusedLookupError(gate.reason) }, { status: 404 });
				}
			}
			try {
				return await forwardApiRequest(ctx, {
					pathname: url.pathname,
					search: url.search,
					method: req.method,
					contentType: req.headers.get("Content-Type") || "application/json",
					agentType: req.headers.get("X-Agent-Type"),
					body: req.method !== "GET" ? await req.text() : undefined,
				});
			} catch {
				return Response.json({ error: "Relay failed" }, { status: 502 });
			}
		}

		return Response.json({
			message: "AgentPulse Relay",
			dashboard: ctx.config.remoteUrl,
			hint: `Open ${ctx.config.remoteUrl} in your browser for the dashboard`,
		});
	};
}

/** Runs `tick` every `ms`, skipping a round while the previous one is still running. */
function everyExclusive(ctx: RelayContext, ms: number, tick: (ctx: RelayContext) => Promise<void>) {
	let busy = false;
	return setInterval(() => {
		if (busy) return;
		busy = true;
		tick(ctx)
			.catch((err) => ctx.log(`[relay] background task failed: ${errorMessage(err)}`))
			.finally(() => {
				busy = false;
			});
	}, ms);
}

export async function startRelay(
	config: RelayConfig,
	opts: ContextOptions & { timers?: boolean; syncMs?: number } = {},
) {
	const timers = opts.timers ?? true;
	const ctx = createRelayContext(config, opts);
	ctx.autoSchedule = timers;
	await ensureQueueDirs(ctx);
	await recoverInterruptedHooks(ctx, "startup");
	ctx.state.queue.parked = await readdir(ctx.paths.hookParkedDir)
		.then((names) => names.filter((n) => n.endsWith(".json")).length)
		.catch(() => 0);
	await sweepOrphanedTempFiles(ctx, await readdir(ctx.paths.hookPendingDir));
	await tightenStateModes(ctx);
	await loadLocalSessions(ctx);
	await loadExcludedIds(ctx);
	refreshExcludeRules(ctx);
	const homeWarning = homeMismatchWarning(ctx.paths.home, ctx.accountHome());
	if (homeWarning) ctx.log(`[relay] ${homeWarning}`);
	ctx.state.relayHash = (await hashFile(ctx.paths.relayScriptFile)) ?? "";
	startupWarnings(ctx);

	const handler = createFetchHandler(ctx);
	const server = Bun.serve({
		port: config.port,
		hostname: "127.0.0.1",
		idleTimeout: RELAY_IDLE_TIMEOUT_S,
		fetch: handler,
	});
	ctx.port = server.port ?? config.port;

	const intervals: ReturnType<typeof setInterval>[] = [];
	let stopped = false;
	let ready: Promise<void> = Promise.resolve();
	if (timers) {
		const syncMs = opts.syncMs ?? DEFAULT_SYNC_MS;
		intervals.push(
			setInterval(() => {
				void enforceQueueLimits(ctx)
					.catch(() => {})
					.then(() => processHookQueue(ctx));
			}, HOOK_RETRY_POLL_MS),
		);
		scheduleQueue(ctx, 250);
		// Scopes first, so the first sync round already knows what it may do.
		ready = (async () => {
			await checkScopesTick(ctx);
			await checkDriftTick(ctx);
			if (stopped) return;
			intervals.push(
				everyExclusive(ctx, SCOPE_CHECK_MS, checkScopesTick),
				everyExclusive(ctx, DRIFT_CHECK_MS, checkDriftTick),
				everyExclusive(ctx, syncMs, syncClaudeMdTick),
				everyExclusive(ctx, syncMs, syncCodexNamesTick),
				everyExclusive(ctx, EXCLUDE_TICK_MS, excludeTick),
			);
		})();
	}

	return {
		ctx,
		server,
		port: ctx.port,
		handler,
		ready,
		stop() {
			stopped = true;
			for (const interval of intervals) clearInterval(interval);
			if (ctx.state.queueTimer) clearTimeout(ctx.state.queueTimer);
			server.stop(true);
		},
	};
}

function parseSyncMs(raw: string | undefined) {
	const n = Number(raw);
	return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_SYNC_MS;
}

/** The key main() started with, so a fatal error message can be redacted. */
let mainApiKey = "";

async function main(argv: string[]) {
	const configPath = findConfigPath(argv);
	let fileConfig: RelayFileConfig = {};
	if (configPath) {
		try {
			fileConfig = await loadConfigFile(configPath);
		} catch (err) {
			// F153: never echo the parser's message; it can quote the file,
			// key included.
			const code = (err as { code?: string }).code;
			console.error(
				err instanceof SyntaxError
					? `relay: invalid JSON in ${configPath}`
					: code
						? `relay: can't read ${configPath} (${code})`
						: `relay: invalid config in ${configPath}`,
			);
			process.exit(1);
		}
	}
	const parsed = parseArgs(argv, fileConfig, {
		agentpulseDir: process.env.AGENTPULSE_DIR || undefined,
		scriptDir: import.meta.dir,
	});
	if (!parsed.ok) {
		console.error(`relay: ${parsed.error}`);
		console.error(USAGE);
		process.exit(1);
	}
	mainApiKey = parsed.config.apiKey;
	const syncMs = parseSyncMs(process.env.AGENTPULSE_RELAY_SYNC_MS);
	const relay = await startRelay(parsed.config, { syncMs });
	const { config } = relay.ctx;
	const seconds = `${Math.round(syncMs / 100) / 10}s`;

	console.log("");
	console.log("  AgentPulse Relay");
	console.log("  ────────────────");
	console.log(`  Local:     http://localhost:${relay.port} (hook forwarding)`);
	console.log(`  Remote:    ${config.remoteUrl} (dashboard)`);
	console.log(`  State:     ${config.stateDir}`);
	console.log("  Queue:     disk-backed hook queue with background retry");
	console.log(
		`  Sync:      CLAUDE.md every ${seconds} · Codex thread names every ${seconds} (policy: ${config.codexNamePolicy})`,
	);
	console.log(`  Auth:      ${config.apiKey ? "API key" : "none"}`);
	console.log("");
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err) => {
		const message = errorMessage(err);
		console.error(`relay: ${mainApiKey ? message.split(mainApiKey).join("[redacted]") : message}`);
		process.exit(1);
	});
}
