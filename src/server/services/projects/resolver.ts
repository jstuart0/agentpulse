export type ProjectRecord = { id: string; cwd: string };

export function normalizeCwd(p: string): string {
	return p.replace(/\/+$/, "");
}

// Returns true only when `prefix` is a path-segment-exact prefix of `full`.
// Prevents /foo/bar matching against /foo/barbaz.
export function isPrefixOf(prefix: string, full: string): boolean {
	if (prefix === full) return true;
	return full.startsWith(`${prefix}/`);
}

// Returns the id of the project whose cwd is the longest path-prefix of
// sessionCwd. Both sides are normalized before comparison.
export function resolveProjectIdForCwd(
	sessionCwd: string | null | undefined,
	projects: ProjectRecord[],
): string | null {
	if (!sessionCwd) return null;
	const normalizedSession = normalizeCwd(sessionCwd);

	let best: ProjectRecord | null = null;
	for (const project of projects) {
		const normalizedProject = normalizeCwd(project.cwd);
		if (!isPrefixOf(normalizedProject, normalizedSession)) continue;
		if (!best || normalizedProject.length > normalizeCwd(best.cwd).length) {
			best = project;
		}
	}

	return best ? best.id : null;
}
