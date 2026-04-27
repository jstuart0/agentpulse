import { desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentType, LaunchMode, SessionTemplateInput } from "../../shared/types.js";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { projects, sessionTemplates } from "../db/schema.js";
import { ensureProjectForCwd, getProject } from "../services/projects/projects-service.js";
import {
	buildTemplatePreview,
	normalizeTemplateInput,
	validateTemplateInput,
} from "../services/template-preview.js";
import { resolveTemplateWithProject } from "../services/templates/template-project-resolver.js";
import {
	deleteTemplate,
	mapTemplate,
	updateTemplate,
} from "../services/templates/templates-service.js";

const templatesRouter = new Hono();
templatesRouter.use("*", requireAuth());

templatesRouter.get("/templates", async (c) => {
	const agentType = c.req.query("agent_type") as AgentType | undefined;
	const query = db.select().from(sessionTemplates);
	const rows = agentType
		? await query
				.where(eq(sessionTemplates.agentType, agentType))
				.orderBy(desc(sessionTemplates.updatedAt), desc(sessionTemplates.createdAt))
		: await query.orderBy(desc(sessionTemplates.updatedAt), desc(sessionTemplates.createdAt));

	// Batch-fetch all linked projects in one query — one extra query regardless
	// of list size. Templates with no projectId short-circuit in the resolver.
	const linkedIds = [...new Set(rows.map((r) => r.projectId).filter(Boolean))] as string[];
	const projectMap = new Map<string, typeof projects.$inferSelect>();
	if (linkedIds.length > 0) {
		const linked = await db.select().from(projects).where(inArray(projects.id, linkedIds));
		for (const p of linked) projectMap.set(p.id, p);
	}

	const mapped = rows.map((row) => {
		const project = row.projectId ? (projectMap.get(row.projectId) ?? null) : null;
		const resolved = resolveTemplateWithProject(row, project);
		return {
			...mapTemplate(row),
			agentType: resolved.agentType,
			cwd: resolved.cwd,
			model: resolved.model,
		};
	});

	return c.json({ templates: mapped, total: mapped.length });
});

templatesRouter.get("/templates/:id", async (c) => {
	const id = c.req.param("id");
	const [row] = await db
		.select()
		.from(sessionTemplates)
		.where(eq(sessionTemplates.id, id))
		.limit(1);
	if (!row) return c.json({ error: "Template not found" }, 404);

	const project = row.projectId ? await getProject(row.projectId) : null;
	const resolved = resolveTemplateWithProject(row, project);

	return c.json({
		template: {
			...mapTemplate(row),
			agentType: resolved.agentType,
			cwd: resolved.cwd,
			model: resolved.model,
		},
		resolvedProject: project
			? {
					id: project.id,
					name: project.name,
					cwd: project.cwd,
					defaultAgentType: project.defaultAgentType,
					defaultModel: project.defaultModel,
					defaultLaunchMode: project.defaultLaunchMode,
				}
			: null,
	});
});

templatesRouter.post("/templates", async (c) => {
	const body = await c.req.json<
		SessionTemplateInput & { projectId?: string | null; overriddenFields?: string[] }
	>();
	const normalized = normalizeTemplateInput(body);
	const { errors } = validateTemplateInput(normalized);
	if (errors.length > 0) return c.json({ error: errors.join(" ") }, 400);

	let resolvedProjectId: string | null = body.projectId ?? null;
	if (resolvedProjectId === null && normalized.cwd.trim() !== "") {
		const result = await ensureProjectForCwd({
			cwd: normalized.cwd,
			defaultAgentType: normalized.agentType,
			defaultModel: normalized.model ?? null,
		});
		if ("error" in result) return c.json({ error: result.error }, 500);
		resolvedProjectId = result.project.id;
	}

	const now = new Date().toISOString();
	const [row] = await db
		.insert(sessionTemplates)
		.values({
			name: normalized.name,
			description: normalized.description,
			agentType: normalized.agentType,
			cwd: normalized.cwd,
			baseInstructions: normalized.baseInstructions,
			taskPrompt: normalized.taskPrompt,
			model: normalized.model,
			approvalPolicy: normalized.approvalPolicy,
			sandboxMode: normalized.sandboxMode,
			env: normalized.env,
			tags: normalized.tags,
			isFavorite: normalized.isFavorite ?? false,
			projectId: resolvedProjectId,
			templateProjectOverrides: body.overriddenFields?.length ? body.overriddenFields : null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return c.json({ template: mapTemplate(row) }, 201);
});

templatesRouter.put("/templates/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json<
		SessionTemplateInput & { projectId?: string | null; overriddenFields?: string[] }
	>();
	const result = await updateTemplate(id, body);
	if (!result.ok) return c.json({ error: result.error }, result.status);
	return c.json({
		template: {
			...result.template,
			agentType: result.agentType,
			cwd: result.cwd,
			model: result.model,
		},
	});
});

templatesRouter.delete("/templates/:id", async (c) => {
	const id = c.req.param("id");
	const result = await deleteTemplate(id);
	if (!result.ok) return c.json({ error: result.error }, result.status);
	return c.json({ ok: true });
});

templatesRouter.post("/templates/:id/duplicate", async (c) => {
	const id = c.req.param("id");
	const [existing] = await db
		.select()
		.from(sessionTemplates)
		.where(eq(sessionTemplates.id, id))
		.limit(1);
	if (!existing) return c.json({ error: "Template not found" }, 404);

	const now = new Date().toISOString();
	const [row] = await db
		.insert(sessionTemplates)
		.values({
			name: `Copy of ${existing.name}`,
			description: existing.description,
			agentType: existing.agentType,
			cwd: existing.cwd,
			baseInstructions: existing.baseInstructions,
			taskPrompt: existing.taskPrompt,
			model: existing.model,
			approvalPolicy: existing.approvalPolicy,
			sandboxMode: existing.sandboxMode,
			env: existing.env ?? {},
			tags: existing.tags ?? [],
			isFavorite: false,
			projectId: existing.projectId,
			templateProjectOverrides: existing.templateProjectOverrides,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return c.json({ template: mapTemplate(row) }, 201);
});

templatesRouter.post("/templates/preview", async (c) => {
	const body = await c.req.json<
		Partial<SessionTemplateInput> & {
			launchMode?: LaunchMode;
			requestedSupervisorId?: string | null;
			routingPolicy?: "manual_target" | "first_capable_host" | null;
		}
	>();
	const preview = await buildTemplatePreview(body, {
		requestedLaunchMode: body.launchMode ?? "interactive_terminal",
		requestedSupervisorId: body.requestedSupervisorId ?? null,
		routingPolicy: body.routingPolicy ?? null,
	});
	const { errors } = validateTemplateInput(preview.normalizedTemplate);
	if (errors.length > 0) {
		return c.json({ error: errors.join(" "), preview }, 400);
	}
	return c.json(preview);
});

export { templatesRouter };
