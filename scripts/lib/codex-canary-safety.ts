/**
 * The rules a live Codex canary keeps (AGEN-115, phase 5), as code, so a CI test with no Codex can hold them.
 *
 *  1. A canary runs Codex only under a throwaway `CODEX_HOME` that sits strictly inside a scratch directory:
 *     never unset, relative, the person's home or real `~/.codex`, or a path that reaches them through a link.
 *  2. Only `scripts/lib/codex-canary-spawn.ts` starts Codex (and the older spike's own `Session` class, named
 *     below): one place that sets the environment and allows only the subcommands a canary needs.
 *  3. Only `start`, `stop` and `version` are run under `codex app-server daemon`: never `bootstrap`, `update`,
 *     `restart` or anything else that could change a machine-wide service.
 *  4. Nothing is killed by name. A process is signalled by a pid this run started, or by a pid whose own
 *     environment names this run's exact `CODEX_HOME` (`lib/codex-own-pids.ts`, the one searching helper).
 *  5. No terminal user interface: a TUI shows an update dialog and takes keys, and nothing here sends keys.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const ALLOWED_DAEMON_SUBCOMMANDS = ["start", "stop", "version"] as const;
export const ALLOWED_CODEX_SUBCOMMANDS = ["exec", "app-server", "daemon", "--version"] as const;

/** Files that may start a Codex process. The spike's `Session` class predates this rule and is the one older caller. */
export const CODEX_SPAWN_ALLOWED_FILES = [
	"scripts/lib/codex-canary-spawn.ts",
	"scripts/codex-approvals-live.ts",
];
/** The file that holds the rules; the scan doesn't read it, since its own patterns and name lists are what it looks for. */
export const RULES_FILE = "scripts/lib/codex-canary-safety.ts";
/** The one file that may search for processes and signal what it finds. */
export const PROCESS_SEARCH_FILE = "scripts/lib/codex-own-pids.ts";

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Throws unless `codexHome` is a throwaway home: absolute, strictly inside `scratchRoot` (a path that merely
 * starts with the same characters is a different directory), not the person's real home or `.codex`, and
 * still outside them once links are followed.
 */
export function assertThrowawayCodexHome(
	codexHome: string | undefined,
	scratchRoot: string,
	realHome: string,
): string {
	if (!codexHome) throw new Error("CODEX_HOME is not set");
	if (!isAbsolute(codexHome)) throw new Error("CODEX_HOME is not an absolute path");
	const path = resolve(codexHome);
	const realCodex = join(realHome, ".codex");
	const forbidden = (candidate: string) =>
		candidate === realHome ||
		candidate === realCodex ||
		inside(realCodex, candidate) ||
		inside(candidate, realCodex);
	if (forbidden(path)) throw new Error("CODEX_HOME is the real home or its .codex");
	if (!inside(resolve(scratchRoot), path)) {
		throw new Error("CODEX_HOME is not strictly inside the scratch directory");
	}
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		real = path;
	}
	if (forbidden(real)) throw new Error("CODEX_HOME reaches the real home through a link");
	let realRoot = resolve(scratchRoot);
	try {
		realRoot = realpathSync(realRoot);
	} catch {}
	if (!inside(realRoot, real))
		throw new Error("CODEX_HOME leaves the scratch directory through a link");
	return path;
}

export interface SourceFile {
	path: string;
	text: string;
}
export interface Finding {
	rule: "codex-spawn" | "daemon-subcommand" | "kill-by-name" | "process-search" | "tui";
	path: string;
	detail: string;
}

const stripComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** What each rule looks for, applied to one file's text; `scanCanarySource` adds the file's identity. */
export function scanText(path: string, raw: string): Finding[] {
	// This file defines the patterns below (and lists the allowed names), so it would flag itself.
	if (path === RULES_FILE) return [];
	const text = stripComments(raw);
	const findings: Finding[] = [];
	const add = (rule: Finding["rule"], detail: string) => findings.push({ rule, path, detail });

	if (!CODEX_SPAWN_ALLOWED_FILES.includes(path)) {
		const spawn =
			/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["'`]codex["'`]|Bun\.spawn(?:Sync)?\(\s*\[\s*["'`]codex["'`]|\bspawn\w*\([^)]*\[\s*["'`]codex["'`]/;
		const m = spawn.exec(text);
		if (m) add("codex-spawn", m[0]);
	}
	for (const m of text.matchAll(/\bdaemon\b["'`,\s\[]+([A-Za-z-]+)/g)) {
		if (!(ALLOWED_DAEMON_SUBCOMMANDS as readonly string[]).includes(m[1] as string)) {
			add("daemon-subcommand", m[0]);
		}
	}
	const byName =
		/\bpkill\b|\bkillall\b|xargs\s+kill|kill\s+(?:-\w+\s+)?\$\(\s*pgrep|kill\s+(?:-\w+\s+)?`pgrep/;
	const nameMatch = byName.exec(text);
	if (nameMatch) add("kill-by-name", nameMatch[0]);
	if (path !== PROCESS_SEARCH_FILE) {
		const search =
			/["'`]pgrep["'`]\s*,\s*\[[^\]]*["'`]-x["'`]|["'`]pgrep["'`]\s*,\s*\[[^\]]*["'`]-f["'`][^\]]*\][\s\S]{0,200}process\.kill/;
		const m = search.exec(text);
		if (m) add("process-search", m[0]);
	}
	const tui = /node-pty|\bopenpty\b|pty\.spawn|["'`]script["'`]\s*,\s*\[\s*["'`]-q|--no-alt-screen/;
	const tuiMatch = tui.exec(text);
	if (tuiMatch) add("tui", tuiMatch[0]);
	return findings;
}

export function scanCanarySource(files: SourceFile[]): Finding[] {
	return files.flatMap((file) => scanText(file.path, file.text));
}

export const DIRECTORY_SEPARATOR = sep;
