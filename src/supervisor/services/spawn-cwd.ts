/**
 * The directory an agent process is started in. The server judged the launch's directory
 * against this host's trusted roots, but the host re-checks it itself and then spawns in the
 * path it checked, never the string it was handed: a symlink followed by `..`, or a path
 * that changes between the check and the spawn, would otherwise land somewhere else.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { resolveHomeDir } from "../config.js";
import {
	expandTilde,
	isPathInside,
	isUnderAnyRoot,
	realpathOfDeepestExistingAncestor,
	resolveTrustedRoots,
} from "./prelaunch-actions.js";

export class SpawnCwdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpawnCwdError";
	}
}

function absolutePath(cwd: string): string {
	if (cwd.split(/[\\/]/).includes("..")) {
		throw new SpawnCwdError(`Working directory may not contain '..' segments: ${cwd}`);
	}
	const expanded = expandTilde(cwd);
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Before anything runs (the directory may not exist yet: a prelaunch action can create
 * it): no `..`, and the deepest part that does exist resolves under a trusted root.
 */
export async function assertCwdTrusted(cwd: string, trustedRoots: string[]): Promise<void> {
	const absolute = absolutePath(cwd);
	const probed = await realpathOfDeepestExistingAncestor(absolute);
	if (!isUnderAnyRoot(probed, await resolveTrustedRoots(trustedRoots))) {
		throw new SpawnCwdError("Working directory is outside this host's trusted roots.");
	}
}

/** Right before spawn: the directory exists, its real path is trusted, and that real path is what is returned. */
export async function canonicalSpawnCwd(cwd: string, trustedRoots: string[]): Promise<string> {
	const absolute = absolutePath(cwd);
	let real: string;
	try {
		real = await realpath(absolute);
	} catch {
		throw new SpawnCwdError("Working directory doesn't exist on this host.");
	}
	if (!isUnderAnyRoot(real, await resolveTrustedRoots(trustedRoots))) {
		throw new SpawnCwdError("Working directory is outside this host's trusted roots.");
	}
	return real;
}

/**
 * A trusted root that contains the supervisor's own state directory (`~/.agentpulse`, which
 * holds the credential file and the interactive bridge sockets) would let a launch run in, or
 * write to, it. The supervisor refuses to start with such a root.
 */
export async function assertTrustedRootsExcludeAgentpulseDir(
	trustedRoots: string[],
): Promise<void> {
	const stateDir = join(resolveHomeDir(), ".agentpulse");
	let realState = stateDir;
	try {
		realState = await realpath(stateDir);
	} catch {}
	for (const root of await resolveTrustedRoots(trustedRoots)) {
		if (isPathInside(realState, root.resolved) || isPathInside(stateDir, root.resolved)) {
			throw new SpawnCwdError(
				`Trusted root ${root.original} contains ${stateDir}, which holds this supervisor's credentials and bridge sockets. Choose a narrower trusted root.`,
			);
		}
	}
}
