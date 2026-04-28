import { lstat, rm } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
	expandTilde,
	isUnderAnyRoot,
	realpathOfDeepestExistingAncestor,
	rejectEscapingSymlinks,
	resolveTrustedRoots,
} from "./prelaunch-actions.js";

export type CleanupErrorCode =
	| "path_not_absolute"
	| "path_traversal_rejected"
	| "path_outside_trusted_roots"
	| "symlink_rejected"
	| "permission_denied"
	| "not_a_directory";

export class CleanupError extends Error {
	readonly code: CleanupErrorCode;
	readonly path?: string;
	readonly cause?: unknown;
	constructor(code: CleanupErrorCode, message: string, path?: string, cause?: unknown) {
		super(message);
		this.name = "CleanupError";
		this.code = code;
		this.path = path;
		this.cause = cause;
	}

	toJSON() {
		return { code: this.code, path: this.path ?? null, message: this.message };
	}
}

export interface CleanupWorkAreaInput {
	cwd: string;
	trustedRoots: string[];
	logProgress?: (msg: string) => void;
}

export interface CleanupWorkAreaResult {
	removed: boolean;
	resolvedPath: string;
}

/**
 * Remove a scratch workspace directory previously created by
 * scaffold_workarea. Mirrors the validation surface of executePrelaunchActions
 * (trusted-roots, symlink rejection, `..` segment rejection) so the destructive
 * step runs only when the path is on the same trusted trajectory the supervisor
 * was already willing to write to.
 *
 * Idempotent: a missing target returns `removed: false` without error so a
 * retry after a half-completed cleanup doesn't fail.
 */
export async function executeCleanupWorkArea(
	input: CleanupWorkAreaInput,
): Promise<CleanupWorkAreaResult> {
	const expanded = expandTilde(input.cwd);

	if (!isAbsolute(expanded)) {
		throw new CleanupError("path_not_absolute", `Path must be absolute: ${input.cwd}`, input.cwd);
	}

	const rawSegments = expanded.split(sep);
	if (rawSegments.includes("..")) {
		throw new CleanupError(
			"path_traversal_rejected",
			`Path may not contain '..' segments: ${input.cwd}`,
			input.cwd,
		);
	}

	const normalised = resolve(expanded);
	const roots = await resolveTrustedRoots(input.trustedRoots);

	try {
		await rejectEscapingSymlinks(normalised, roots);
	} catch (err) {
		// Rethrow as CleanupError so callers don't need to import PrelaunchError too.
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: unknown }).code;
			const message = err instanceof Error ? err.message : String(err);
			if (code === "symlink_rejected") {
				throw new CleanupError("symlink_rejected", message, normalised, err);
			}
			if (code === "permission_denied") {
				throw new CleanupError("permission_denied", message, normalised, err);
			}
		}
		throw err;
	}

	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(normalised);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			input.logProgress?.(`cleanup: ${normalised} already absent`);
			return { removed: false, resolvedPath: normalised };
		}
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") {
			throw new CleanupError(
				"permission_denied",
				`Cannot inspect ${normalised}: permission denied.`,
				normalised,
				err,
			);
		}
		throw err;
	}

	if (stat.isSymbolicLink()) {
		throw new CleanupError(
			"symlink_rejected",
			`Refusing to delete symlink at ${normalised}.`,
			normalised,
		);
	}
	if (!stat.isDirectory()) {
		throw new CleanupError(
			"not_a_directory",
			`Refusing to delete non-directory at ${normalised}.`,
			normalised,
		);
	}

	const probedPath = await realpathOfDeepestExistingAncestor(normalised);
	if (!isUnderAnyRoot(probedPath, roots)) {
		throw new CleanupError(
			"path_outside_trusted_roots",
			`Path ${normalised} is not under any trusted root.`,
			normalised,
		);
	}

	try {
		await rm(normalised, { recursive: true, force: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") {
			throw new CleanupError(
				"permission_denied",
				`Cannot remove ${normalised}: permission denied.`,
				normalised,
				err,
			);
		}
		throw err;
	}
	input.logProgress?.(`cleanup: removed ${normalised}`);
	return { removed: true, resolvedPath: normalised };
}
