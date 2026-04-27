import { basename } from "node:path";
import { eq, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { projects, sessionTemplates, sessions } from "../../db/schema.js";
import { bumpVersionAndReload, getCachedProjects } from "./cache.js";
import { normalizeCwd, resolveProjectIdForCwd } from "./resolver.js";

export type ProjectRow = typeof projects.$inferSelect;

export type CreateProjectInput = {
	name: string;
	cwd: string;
	githubRepoUrl?: string | null;
	defaultAgentType?: string | null;
	defaultModel?: string | null;
	defaultLaunchMode?: string | null;
	notes?: string | null;
	tags?: string[] | null;
	isFavorite?: boolean;
	metadata?: Record<string, unknown> | null;
};

export type UpdateProjectInput = Partial<CreateProjectInput>;

// Service-layer duplicate-cwd check: returns the conflicting project id if
// another project already owns the same normalized cwd, otherwise null.
// No DB UNIQUE constraint — intentional, see route validation comment.
async function findCwdConflict(normalizedCwd: string, excludeId?: string): Promise<string | null> {
	const rows = await db.select({ id: projects.id, cwd: projects.cwd }).from(projects);
	for (const row of rows) {
		if (excludeId && row.id === excludeId) continue;
		if (normalizeCwd(row.cwd) === normalizedCwd) return row.id;
	}
	return null;
}

// Re-stamp sessions for a given project. Loads candidate sessions via a
// LIKE over-approximation, then filters through the path-segment-aware
// resolver.
//
// The LIKE clause is an intentional over-approximation — it can match
// /foo/bar-baz against project cwd /foo/bar. False positives are filtered
// out by resolveProjectIdForCwd, which uses path-segment-aware prefix
// matching. Documented here so future readers don't try to "tighten" the SQL.
export async function resolveAllSessionsForProject(
	projectId: string,
	projectCwd: string,
	allProjects?: Array<{ id: string; cwd: string }>,
): Promise<void> {
	const projectList = allProjects ?? getCachedProjects();
	const normalizedCwd = normalizeCwd(projectCwd);

	await db.transaction(async (tx) => {
		const candidates = await tx
			.select({
				id: sessions.id,
				cwd: sessions.cwd,
				projectId: sessions.projectId,
			})
			.from(sessions)
			.where(
				or(
					sql`${sessions.projectId} IS NULL`,
					eq(sessions.projectId, projectId),
					sql`${sessions.cwd} LIKE ${`${normalizedCwd}%`}`,
				),
			);

		for (const session of candidates) {
			const resolved = resolveProjectIdForCwd(session.cwd, projectList);
			if (resolved !== session.projectId) {
				await tx.update(sessions).set({ projectId: resolved }).where(eq(sessions.id, session.id));
			}
		}
	});
}

export async function listProjects(): Promise<ProjectRow[]> {
	return db.select().from(projects).orderBy(projects.name);
}

export async function getProject(id: string): Promise<ProjectRow | null> {
	const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
	return row ?? null;
}

export async function getProjectByName(name: string): Promise<ProjectRow | null> {
	const [row] = await db.select().from(projects).where(eq(projects.name, name)).limit(1);
	return row ?? null;
}

export async function createProject(
	input: CreateProjectInput,
): Promise<{ conflict?: string; project?: ProjectRow }> {
	const normalizedCwd = normalizeCwd(input.cwd);
	const conflictId = await findCwdConflict(normalizedCwd);
	if (conflictId) return { conflict: conflictId };

	const now = new Date().toISOString();
	const [row] = await db
		.insert(projects)
		.values({
			name: input.name,
			cwd: normalizedCwd,
			githubRepoUrl: input.githubRepoUrl ?? null,
			defaultAgentType: input.defaultAgentType ?? null,
			defaultModel: input.defaultModel ?? null,
			defaultLaunchMode: input.defaultLaunchMode ?? null,
			notes: input.notes ?? null,
			tags: input.tags ?? null,
			isFavorite: input.isFavorite ?? false,
			metadata: input.metadata ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	await bumpVersionAndReload();
	await resolveAllSessionsForProject(row.id, row.cwd, getCachedProjects());
	return { project: row };
}

export async function updateProject(
	id: string,
	input: UpdateProjectInput,
): Promise<{ notFound?: boolean; conflict?: string; project?: ProjectRow }> {
	const [existing] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
	if (!existing) return { notFound: true };

	const normalizedCwd = input.cwd ? normalizeCwd(input.cwd) : normalizeCwd(existing.cwd);
	if (input.cwd !== undefined) {
		const conflictId = await findCwdConflict(normalizedCwd, id);
		if (conflictId) return { conflict: conflictId };
	}

	const cwdChanged = normalizedCwd !== normalizeCwd(existing.cwd);

	const [row] = await db
		.update(projects)
		.set({
			...(input.name !== undefined && { name: input.name }),
			...(input.cwd !== undefined && { cwd: normalizedCwd }),
			...(input.githubRepoUrl !== undefined && { githubRepoUrl: input.githubRepoUrl }),
			...(input.defaultAgentType !== undefined && { defaultAgentType: input.defaultAgentType }),
			...(input.defaultModel !== undefined && { defaultModel: input.defaultModel }),
			...(input.defaultLaunchMode !== undefined && { defaultLaunchMode: input.defaultLaunchMode }),
			...(input.notes !== undefined && { notes: input.notes }),
			...(input.tags !== undefined && { tags: input.tags }),
			...(input.isFavorite !== undefined && { isFavorite: input.isFavorite }),
			...(input.metadata !== undefined && { metadata: input.metadata }),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(projects.id, id))
		.returning();

	await bumpVersionAndReload();

	if (cwdChanged) {
		// Re-resolve sessions that were previously stamped with this project
		// (their cwd may no longer match) AND sessions matching the new cwd.
		// Both groups go through resolveProjectIdForCwd against the full
		// project list — some end up reassigned, some become NULL, some newly
		// attach. Do not blanket-NULL the old set; the resolver decides.
		const allProjects = getCachedProjects();
		await db.transaction(async (tx) => {
			const candidates = await tx
				.select({ id: sessions.id, cwd: sessions.cwd, projectId: sessions.projectId })
				.from(sessions)
				.where(
					or(
						eq(sessions.projectId, id),
						sql`${sessions.cwd} LIKE ${`${normalizedCwd}%`}`,
						sql`${sessions.cwd} LIKE ${`${normalizeCwd(existing.cwd)}%`}`,
					),
				);

			for (const session of candidates) {
				const resolved = resolveProjectIdForCwd(session.cwd, allProjects);
				if (resolved !== session.projectId) {
					await tx.update(sessions).set({ projectId: resolved }).where(eq(sessions.id, session.id));
				}
			}
		});
	}

	return { project: row };
}

export async function getProjectByCwd(normalizedCwd: string): Promise<ProjectRow | null> {
	const rows = await db.select({ id: projects.id, cwd: projects.cwd }).from(projects);
	for (const row of rows) {
		if (normalizeCwd(row.cwd) === normalizedCwd) {
			const [full] = await db.select().from(projects).where(eq(projects.id, row.id)).limit(1);
			return full ?? null;
		}
	}
	return null;
}

const NAME_MAX_SEED = 78;
const NAME_SUFFIX_CAP = 50;

export type EnsureProjectInput = {
	cwd: string;
	defaultAgentType?: string | null;
	defaultModel?: string | null;
};

export async function ensureProjectForCwd(
	input: EnsureProjectInput,
): Promise<{ project: ProjectRow; created: boolean } | { error: string }> {
	const normalizedCwd = normalizeCwd(input.cwd);

	const existing = await getProjectByCwd(normalizedCwd);
	if (existing) return { project: existing, created: false };

	const seed = (basename(normalizedCwd) || "project").slice(0, NAME_MAX_SEED);

	// Find a unique name by appending numeric suffix when seed is already taken.
	let candidateName = seed;
	let attempt = 1;
	while (true) {
		const conflict = await getProjectByName(candidateName);
		if (!conflict) break;
		attempt += 1;
		if (attempt > NAME_SUFFIX_CAP) {
			return {
				error: `Could not generate a unique project name for cwd "${normalizedCwd}" after ${NAME_SUFFIX_CAP} attempts`,
			};
		}
		candidateName = `${seed}-${attempt}`;
	}

	const result = await createProject({
		name: candidateName,
		cwd: normalizedCwd,
		defaultAgentType: input.defaultAgentType ?? null,
		defaultModel: input.defaultModel ?? null,
	});

	if (result.conflict) {
		// A concurrent request created a project for this cwd between our check
		// and our insert. Re-fetch and return it as a non-created result.
		const refetched = await getProjectByCwd(normalizedCwd);
		if (refetched) return { project: refetched, created: false };
		return { error: `Concurrent project creation conflict for cwd "${normalizedCwd}"` };
	}

	// result.conflict is falsy here, so project is defined
	const project = result.project as ProjectRow;
	return { project, created: true };
}

export async function deleteProject(id: string): Promise<boolean> {
	const [existing] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
	if (!existing) return false;

	// All three cleanup operations in one transaction — if any fails, none apply.
	// No orphaned template or session rows with dangling project_id values.
	await db.transaction(async (tx) => {
		await tx
			.update(sessionTemplates)
			.set({ projectId: null })
			.where(eq(sessionTemplates.projectId, id));
		await tx.update(sessions).set({ projectId: null }).where(eq(sessions.projectId, id));
		await tx.delete(projects).where(eq(projects.id, id));
	});
	await bumpVersionAndReload();
	return true;
}
