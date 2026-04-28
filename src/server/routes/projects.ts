import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { type projects, sessions } from "../db/schema.js";
import { queueCleanupWorkArea } from "../services/control-actions.js";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	updateProject,
} from "../services/projects/projects-service.js";
import { normalizeCwd } from "../services/projects/resolver.js";
import { listSupervisors } from "../services/supervisor-registry.js";

const projectsRouter = new Hono();
projectsRouter.use("*", requireAuth());

function mapProject(row: typeof projects.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		cwd: row.cwd,
		githubRepoUrl: row.githubRepoUrl,
		defaultAgentType: row.defaultAgentType,
		defaultModel: row.defaultModel,
		defaultLaunchMode: row.defaultLaunchMode,
		notes: row.notes,
		tags: row.tags ?? [],
		isFavorite: row.isFavorite,
		metadata: row.metadata ?? {},
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function validateProjectInput(body: Record<string, unknown>): string[] {
	const errors: string[] = [];

	if (body.name !== undefined) {
		const name = body.name as string;
		if (!name || typeof name !== "string" || name.trim().length === 0) {
			errors.push("name is required");
		} else if (name.trim().length > 80) {
			errors.push("name must be 80 characters or fewer");
		}
	}

	if (body.cwd !== undefined) {
		const cwd = body.cwd as string;
		if (!cwd || typeof cwd !== "string") {
			errors.push("cwd is required");
		} else if (!cwd.startsWith("/")) {
			errors.push("cwd must be an absolute path");
		}
	}

	if (body.githubRepoUrl !== undefined && body.githubRepoUrl !== null) {
		try {
			new URL(body.githubRepoUrl as string);
		} catch {
			errors.push("githubRepoUrl must be a valid URL");
		}
	}

	const validAgentTypes = ["claude_code", "codex_cli"];
	if (
		body.defaultAgentType !== undefined &&
		body.defaultAgentType !== null &&
		!validAgentTypes.includes(body.defaultAgentType as string)
	) {
		errors.push("defaultAgentType must be claude_code or codex_cli");
	}

	const validLaunchModes = ["interactive_terminal", "headless", "managed_codex"];
	if (
		body.defaultLaunchMode !== undefined &&
		body.defaultLaunchMode !== null &&
		!validLaunchModes.includes(body.defaultLaunchMode as string)
	) {
		errors.push("defaultLaunchMode must be interactive_terminal, headless, or managed_codex");
	}

	return errors;
}

projectsRouter.get("/projects", async (c) => {
	const rows = await listProjects();
	return c.json({ projects: rows.map(mapProject), total: rows.length });
});

projectsRouter.get("/projects/:id", async (c) => {
	const id = c.req.param("id");
	const row = await getProject(id);
	if (!row) return c.json({ error: "Project not found" }, 404);
	return c.json({ project: mapProject(row) });
});

projectsRouter.get("/projects/:id/sessions", async (c) => {
	const id = c.req.param("id");
	const row = await getProject(id);
	if (!row) return c.json({ error: "Project not found" }, 404);

	const rows = await db
		.select()
		.from(sessions)
		.where(eq(sessions.projectId, id))
		.orderBy(desc(sessions.lastActivityAt));

	return c.json({ sessions: rows, total: rows.length });
});

projectsRouter.post("/projects", async (c) => {
	const body = await c.req.json<Record<string, unknown>>();

	if (!body.name) body.name = "";
	if (!body.cwd) body.cwd = "";

	const errors = validateProjectInput(body);
	if (errors.length > 0) return c.json({ error: errors.join("; ") }, 400);

	const result = await createProject({
		name: (body.name as string).trim(),
		cwd: normalizeCwd(body.cwd as string),
		githubRepoUrl: (body.githubRepoUrl as string | null) ?? null,
		defaultAgentType: (body.defaultAgentType as string | null) ?? null,
		defaultModel: (body.defaultModel as string | null) ?? null,
		defaultLaunchMode: (body.defaultLaunchMode as string | null) ?? null,
		notes: (body.notes as string | null) ?? null,
		tags: (body.tags as string[] | null) ?? null,
		isFavorite: (body.isFavorite as boolean | null) ?? false,
		metadata: (body.metadata as Record<string, unknown> | null) ?? null,
	});

	if (result.conflict) {
		return c.json(
			{ error: "A project with this cwd already exists", conflictId: result.conflict },
			409,
		);
	}
	if (!result.project) return c.json({ error: "Failed to create project" }, 500);

	return c.json({ project: mapProject(result.project) }, 201);
});

projectsRouter.put("/projects/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json<Record<string, unknown>>();

	const errors = validateProjectInput(body);
	if (errors.length > 0) return c.json({ error: errors.join("; ") }, 400);

	const result = await updateProject(id, {
		...(body.name !== undefined && { name: (body.name as string).trim() }),
		...(body.cwd !== undefined && { cwd: body.cwd as string }),
		...(body.githubRepoUrl !== undefined && {
			githubRepoUrl: (body.githubRepoUrl as string | null) ?? null,
		}),
		...(body.defaultAgentType !== undefined && {
			defaultAgentType: (body.defaultAgentType as string | null) ?? null,
		}),
		...(body.defaultModel !== undefined && {
			defaultModel: (body.defaultModel as string | null) ?? null,
		}),
		...(body.defaultLaunchMode !== undefined && {
			defaultLaunchMode: (body.defaultLaunchMode as string | null) ?? null,
		}),
		...(body.notes !== undefined && { notes: (body.notes as string | null) ?? null }),
		...(body.tags !== undefined && { tags: (body.tags as string[] | null) ?? null }),
		...(body.isFavorite !== undefined && { isFavorite: body.isFavorite as boolean }),
		...(body.metadata !== undefined && {
			metadata: (body.metadata as Record<string, unknown> | null) ?? null,
		}),
	});

	if (result.notFound) return c.json({ error: "Project not found" }, 404);
	if (result.conflict) {
		return c.json(
			{ error: "A project with this cwd already exists", conflictId: result.conflict },
			409,
		);
	}
	if (!result.project) return c.json({ error: "Failed to update project" }, 500);

	return c.json({ project: mapProject(result.project) });
});

projectsRouter.delete("/projects/:id", async (c) => {
	const id = c.req.param("id");
	const deleted = await deleteProject(id);
	if (!deleted) return c.json({ error: "Project not found" }, 404);
	return c.json({ ok: true });
});

// POST /projects/:id/cleanup-workarea
//
// Defense-in-depth gate for v1 (per §10.7 + §11.4): project must carry both
// `scratch` and `ai-initiated` tags before we'll queue an `rm -rf`. The
// supervisor performs another trusted-roots / symlink check on receipt — this
// route is the policy gate, the supervisor is the safety gate. Cascade
// deletion of the project row + its sessions runs in
// updateControlAction once the supervisor reports success.
projectsRouter.post("/projects/:id/cleanup-workarea", async (c) => {
	const id = c.req.param("id");
	const project = await getProject(id);
	if (!project) return c.json({ error: "Project not found" }, 404);

	const tags = project.tags ?? [];
	if (!tags.includes("scratch")) {
		return c.json({ error: "Cleanup is only supported for scratch projects" }, 400);
	}
	if (!tags.includes("ai-initiated")) {
		return c.json({ error: "Cleanup is only supported for AI-initiated scratch projects" }, 400);
	}

	const supervisors = await listSupervisors();
	const target = supervisors.find(
		(s) =>
			s.status === "connected" && (s.capabilities.features ?? []).includes("can_cleanup_workarea"),
	);
	if (!target) {
		return c.json({ error: "No connected supervisor advertises can_cleanup_workarea" }, 409);
	}

	const sessionRows = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.projectId, id));

	const action = await queueCleanupWorkArea({
		projectId: id,
		cwd: project.cwd,
		targetSupervisorId: target.id,
	});

	return c.json({
		action,
		queued: true,
		sessionCount: sessionRows.length,
		targetSupervisorId: target.id,
	});
});

export { projectsRouter };
