import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { PrelaunchAction } from "../../shared/types.js";

export type PrelaunchErrorCode =
	| "path_not_absolute"
	| "path_traversal_rejected"
	| "path_outside_trusted_roots"
	| "symlink_rejected"
	| "path_not_empty"
	| "permission_denied"
	| "disk_full"
	| "git_init_failed"
	| "claude_md_write_failed"
	| "claude_md_sha_mismatch";

export class PrelaunchError extends Error {
	readonly code: PrelaunchErrorCode;
	readonly path?: string;
	readonly cause?: unknown;
	constructor(code: PrelaunchErrorCode, message: string, path?: string, cause?: unknown) {
		super(message);
		this.name = "PrelaunchError";
		this.code = code;
		this.path = path;
		this.cause = cause;
	}

	toJSON() {
		return { code: this.code, path: this.path ?? null, message: this.message };
	}
}

export interface PrelaunchExecutionContext {
	trustedRoots: string[];
	logProgress?: (msg: string) => void;
	logWarning?: (msg: string) => void;
}

export interface ResolvedTrustedRoot {
	original: string;
	resolved: string;
}

/** Expand a leading `~` against the supervisor's own home directory. */
export function expandTilde(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return `${homedir()}${input.slice(1)}`;
	return input;
}

/** Resolve trusted roots through their realpaths so symlink-based aliases match. */
export async function resolveTrustedRoots(roots: string[]): Promise<ResolvedTrustedRoot[]> {
	const resolved: ResolvedTrustedRoot[] = [];
	for (const root of roots) {
		const expanded = expandTilde(root);
		const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
		try {
			resolved.push({ original: root, resolved: await realpath(absolute) });
		} catch {
			// Non-existent trusted roots are still valid as a prefix check fallback;
			// keep the absolute form so we don't silently accept paths under a
			// missing root.
			resolved.push({ original: root, resolved: absolute });
		}
	}
	return resolved;
}

/** True iff `child` is `parent` or a descendant of it (path-segment aware). */
export function isPathInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const withSep = parent.endsWith(sep) ? parent : `${parent}${sep}`;
	return child.startsWith(withSep);
}

export function isUnderAnyRoot(candidate: string, roots: ResolvedTrustedRoot[]): boolean {
	return roots.some((root) => isPathInside(candidate, root.resolved));
}

/**
 * True if `candidate` is either *under* a trusted root or a *parent* of one.
 * Used during symlink validation: an ancestor symlink whose realpath is
 * `/private/var` is acceptable when a trusted root realpath is
 * `/private/var/folders/.../trusted`, because following the symlink keeps the
 * walk on a trusted trajectory. A symlink to `/etc` would not be — it's
 * neither under a trusted root nor a parent of one.
 */
export function isOnTrustedTrajectory(candidate: string, roots: ResolvedTrustedRoot[]): boolean {
	for (const root of roots) {
		if (isPathInside(candidate, root.resolved)) return true;
		if (isPathInside(root.resolved, candidate)) return true;
	}
	return false;
}

/**
 * Walk every existing ancestor of `target`. For each one that is a symlink,
 * resolve it and require the target to land under a trusted root. A symlink
 * whose realpath is still under a trusted root is allowed (e.g. macOS
 * `/var → /private/var`).
 */
export async function rejectEscapingSymlinks(
	target: string,
	roots: ResolvedTrustedRoot[],
): Promise<void> {
	const segments = target.split(sep).filter((s) => s.length > 0);
	let cursor: string = sep;
	for (let i = 0; i < segments.length; i++) {
		cursor = i === 0 ? `${sep}${segments[0]}` : `${cursor}${sep}${segments[i]}`;
		let stat: Awaited<ReturnType<typeof lstat>>;
		try {
			stat = await lstat(cursor);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return; // remaining segments don't exist yet
			if (code === "EACCES" || code === "EPERM") {
				throw new PrelaunchError(
					"permission_denied",
					`Cannot inspect ancestor ${cursor}: permission denied.`,
					cursor,
					err,
				);
			}
			throw err;
		}
		if (stat.isSymbolicLink()) {
			let realTarget: string;
			try {
				realTarget = await realpath(cursor);
			} catch (err) {
				throw new PrelaunchError(
					"symlink_rejected",
					`Symlink at ${cursor} could not be resolved.`,
					cursor,
					err,
				);
			}
			if (!isOnTrustedTrajectory(realTarget, roots)) {
				throw new PrelaunchError(
					"symlink_rejected",
					`Symlink at ${cursor} resolves outside trusted roots (target: ${realTarget}).`,
					cursor,
				);
			}
		}
	}
}

/**
 * Walk up the path until we find an ancestor that exists, then realpath it and
 * append the not-yet-existing tail. This gives us a canonical, symlink-resolved
 * form even when the leaf (and possibly several intermediate dirs) hasn't been
 * created yet.
 */
export async function realpathOfDeepestExistingAncestor(target: string): Promise<string> {
	const segments = target.split(sep).filter((s) => s.length > 0);
	for (let depth = segments.length; depth > 0; depth--) {
		const candidate = sep + segments.slice(0, depth).join(sep);
		try {
			const real = await realpath(candidate);
			const tail = segments.slice(depth);
			return tail.length === 0 ? real : `${real}${sep}${tail.join(sep)}`;
		} catch {
			// keep walking up
		}
	}
	return target;
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
}

async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function ensureDirectory(
	target: string,
	allowedArtifacts: ReadonlySet<string>,
): Promise<void> {
	if (await pathExists(target)) {
		const entries = await readdir(target);
		// Subset-match idempotency (bob §10.6): treat the dir as "empty enough"
		// when every entry is one of the artifacts this action would create
		// (.git/, CLAUDE.md). The per-step idempotency checks below then handle
		// the actual validation (e.g. SHA match for seed file).
		const stray = entries.filter((entry) => !allowedArtifacts.has(entry));
		if (stray.length > 0) {
			throw new PrelaunchError(
				"path_not_empty",
				`Target directory ${target} is not empty.`,
				target,
			);
		}
		return;
	}
	try {
		await mkdir(target, { recursive: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") {
			throw new PrelaunchError(
				"permission_denied",
				`Cannot create ${target}: permission denied.`,
				target,
				err,
			);
		}
		if (code === "ENOSPC") {
			throw new PrelaunchError(
				"disk_full",
				`Cannot create ${target}: no space left on device.`,
				target,
				err,
			);
		}
		throw err;
	}
}

async function runGitInit(target: string): Promise<void> {
	const gitDir = `${target}${sep}.git`;
	if (await pathExists(gitDir)) return; // idempotent: prior run already initialised

	const proc = Bun.spawnSync({
		cmd: ["git", "init", "--quiet"],
		cwd: target,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";
		throw new PrelaunchError(
			"git_init_failed",
			`git init failed in ${target}${stderr ? `: ${stderr}` : ""}.`,
			target,
		);
	}
}

async function writeSeedClaudeMd(
	dir: string,
	seed: { content: string; path: string; sha256: string },
	logWarning: ((msg: string) => void) | undefined,
): Promise<void> {
	const computed = await sha256Hex(seed.content);
	if (computed !== seed.sha256) {
		throw new PrelaunchError(
			"claude_md_sha_mismatch",
			"SHA-256 of supplied CLAUDE.md content does not match the expected digest.",
			dir,
		);
	}

	const targetPath = `${dir}${sep}${seed.path}`;
	if (await pathExists(targetPath)) {
		let existing: string;
		try {
			existing = await readFile(targetPath, "utf8");
		} catch (err) {
			throw new PrelaunchError(
				"claude_md_write_failed",
				`Failed to read existing CLAUDE.md at ${targetPath}.`,
				targetPath,
				err,
			);
		}
		const existingHash = await sha256Hex(existing);
		if (existingHash === seed.sha256) return; // idempotent: already written
		logWarning?.(
			`[prelaunch] CLAUDE.md at ${targetPath} differs from seed; leaving user content untouched.`,
		);
		return;
	}

	try {
		await writeFile(targetPath, seed.content, { encoding: "utf8" });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") {
			throw new PrelaunchError(
				"permission_denied",
				`Cannot write ${targetPath}: permission denied.`,
				targetPath,
				err,
			);
		}
		if (code === "ENOSPC") {
			throw new PrelaunchError(
				"disk_full",
				`Cannot write ${targetPath}: no space left on device.`,
				targetPath,
				err,
			);
		}
		throw new PrelaunchError(
			"claude_md_write_failed",
			`Failed to write ${targetPath}.`,
			targetPath,
			err,
		);
	}
}

async function executeScaffoldWorkArea(
	action: Extract<PrelaunchAction, { kind: "scaffold_workarea" }>,
	context: PrelaunchExecutionContext,
	roots: ResolvedTrustedRoot[],
): Promise<void> {
	const expanded = expandTilde(action.path);

	// Step 1: absolute path required (after ~ expansion).
	if (!isAbsolute(expanded)) {
		throw new PrelaunchError(
			"path_not_absolute",
			`Path must be absolute: ${action.path}`,
			action.path,
		);
	}

	// Step 2: explicit `..` segment rejection — done on the raw input so the
	// signal is the malformed input, not what `path.normalize` would silently
	// "fix".
	const rawSegments = expanded.split(sep);
	if (rawSegments.includes("..")) {
		throw new PrelaunchError(
			"path_traversal_rejected",
			`Path may not contain '..' segments: ${action.path}`,
			action.path,
		);
	}

	const normalised = resolve(expanded);

	// Step 4 (run before step 3): symlink rejection along ancestor chain. The
	// trusted-roots check must use the realpath because platform aliases like
	// macOS's /var → /private/var cause a literal-prefix comparison to fail
	// even when the candidate is genuinely under a trusted root. Doing the
	// symlink walk first ensures we reject any escaping symlinks before
	// trusting the realpath for the prefix check.
	await rejectEscapingSymlinks(normalised, roots);

	// Step 3: trusted-roots prefix check using the realpath of the deepest
	// existing ancestor (so the literal-prefix comparison is platform-correct).
	const probedPath = await realpathOfDeepestExistingAncestor(normalised);
	if (!isUnderAnyRoot(probedPath, roots)) {
		throw new PrelaunchError(
			"path_outside_trusted_roots",
			`Path ${normalised} is not under any trusted root.`,
			normalised,
		);
	}

	// Step 5: mkdir -p (idempotent when target is empty *or* contains only the
	// artifacts this action would have produced — see §10.6).
	const allowedArtifacts = new Set<string>();
	if (action.gitInit) allowedArtifacts.add(".git");
	if (action.seedClaudeMd) allowedArtifacts.add(action.seedClaudeMd.path);
	await ensureDirectory(normalised, allowedArtifacts);
	context.logProgress?.(`scaffolded ${normalised}`);

	// Step 6: optional git init (idempotent).
	if (action.gitInit) {
		await runGitInit(normalised);
		context.logProgress?.(`git init ${normalised}`);
	}

	// Step 7: optional CLAUDE.md seed (idempotent + non-clobbering).
	if (action.seedClaudeMd) {
		await writeSeedClaudeMd(normalised, action.seedClaudeMd, context.logWarning);
		context.logProgress?.(`wrote ${action.seedClaudeMd.path} in ${normalised}`);
	}
}

/**
 * Execute a sequence of prelaunch actions for a launch. Throws `PrelaunchError`
 * on the first failure; the caller is expected to surface the structured error
 * back to the server so the dashboard can render a recovery affordance.
 *
 * Idempotent: re-running on a partially-completed scaffold does not double-
 * mkdir, double-git-init, or clobber an existing CLAUDE.md.
 */
export async function executePrelaunchActions(
	actions: PrelaunchAction[],
	context: PrelaunchExecutionContext,
): Promise<void> {
	if (!actions || actions.length === 0) return;
	const roots = await resolveTrustedRoots(context.trustedRoots);
	for (const action of actions) {
		switch (action.kind) {
			case "scaffold_workarea":
				await executeScaffoldWorkArea(action, context, roots);
				break;
			default: {
				const exhaustive: never = action.kind;
				throw new Error(`Unsupported prelaunch action kind: ${String(exhaustive)}`);
			}
		}
	}
}
