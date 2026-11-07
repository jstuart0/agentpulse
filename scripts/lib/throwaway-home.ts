/**
 * One check for "this directory is a throwaway home for a CLI under test" (AGEN-117, phase 0). Codex's
 * `CODEX_HOME` and Claude's `HOME` and `CLAUDE_CONFIG_DIR` are callers: each names the variable, the scratch
 * root and the paths of the person's real state that must never be reached.
 *
 * A path passes only when it is absolute, strictly inside the scratch root (a sibling that merely shares a
 * prefix is a different directory), not itself a link, not equal to, inside or above any forbidden path, and
 * still inside the scratch root and clear of the forbidden paths once links are followed.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** `realpath` of a path that may not exist yet: the deepest existing ancestor is resolved, the rest appended, so a link in a parent is seen. */
function realpathOfDeepestExisting(path: string): string {
	const missing: string[] = [];
	let current = path;
	for (;;) {
		try {
			return resolve(realpathSync(current), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) return path;
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

export interface ThrowawayHomeCheck {
	/** The variable's name, for the messages. */
	name: string;
	value: string | undefined;
	scratchRoot: string;
	/** The person's real paths (their home, `~/.claude`, `~/.claude.json`, `~/.agentpulse`, `~/.codex`, ...). */
	forbidden: readonly string[];
	/** Appended to the message that names a forbidden path, e.g. "the real home or its .codex". */
	forbiddenLabel: string;
}

/** Returns the resolved path, or throws. */
export function assertThrowawayHome(check: ThrowawayHomeCheck): string {
	const { name, value, scratchRoot, forbidden, forbiddenLabel } = check;
	if (!value) throw new Error(`${name} is not set`);
	if (!isAbsolute(value)) throw new Error(`${name} is not an absolute path`);
	const path = resolve(value);
	const reaches = (candidate: string) =>
		forbidden.some((f) => candidate === f || inside(f, candidate) || inside(candidate, f));
	if (reaches(path)) throw new Error(`${name} is ${forbiddenLabel}`);
	if (!inside(resolve(scratchRoot), path)) {
		throw new Error(`${name} is not strictly inside the scratch directory`);
	}
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error(`${name} is itself a link`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const real = realpathOfDeepestExisting(path);
	if (reaches(real)) throw new Error(`${name} reaches the real home through a link`);
	let realRoot = resolve(scratchRoot);
	try {
		realRoot = realpathSync(realRoot);
	} catch {}
	if (!inside(realRoot, real)) {
		throw new Error(`${name} leaves the scratch directory through a link`);
	}
	return path;
}
