import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessionTemplates } from "../db/schema.js";
import { buildTemplatePreview, normalizeTemplateInput, validateTemplateInput } from "../services/template-preview.js";
import type { AgentType, SessionTemplateInput } from "../../shared/types.js";

const templatesRouter = new Hono();

function mapTemplate(row: typeof sessionTemplates.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		agentType: row.agentType,
		cwd: row.cwd,
		baseInstructions: row.baseInstructions,
		taskPrompt: row.taskPrompt,
		model: row.model,
		approvalPolicy: row.approvalPolicy,
		sandboxMode: row.sandboxMode,
		env: row.env ?? {},
		tags: row.tags ?? [],
		isFavorite: row.isFavorite,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

templatesRouter.get("/templates", async (c) => {
	const agentType = c.req.query("agent_type") as AgentType | undefined;
	const query = db.select().from(sessionTemplates);
	const rows = agentType
		? await query
				.where(eq(sessionTemplates.agentType, agentType))
				.orderBy(desc(sessionTemplates.updatedAt), desc(sessionTemplates.createdAt))
		: await query.orderBy(desc(sessionTemplates.updatedAt), desc(sessionTemplates.createdAt));

	return c.json({ templates: rows.map(mapTemplate), total: rows.length });
});

templatesRouter.get("/templates/:id", async (c) => {
	const id = c.req.param("id");
	const [row] = await db.select().from(sessionTemplates).where(eq(sessionTemplates.id, id)).limit(1);
	if (!row) return c.json({ error: "Template not found" }, 404);
	return c.json({ template: mapTemplate(row) });
});

templatesRouter.post("/templates", async (c) => {
	const body = await c.req.json<SessionTemplateInput>();
	const normalized = normalizeTemplateInput(body);
	const { errors } = validateTemplateInput(normalized);
	if (errors.length > 0) return c.json({ error: errors.join(" ") }, 400);

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
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return c.json({ template: mapTemplate(row) }, 201);
});

templatesRouter.put("/templates/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json<SessionTemplateInput>();
	const normalized = normalizeTemplateInput(body);
	const { errors } = validateTemplateInput(normalized);
	if (errors.length > 0) return c.json({ error: errors.join(" ") }, 400);

	const [existing] = await db.select().from(sessionTemplates).where(eq(sessionTemplates.id, id)).limit(1);
	if (!existing) return c.json({ error: "Template not found" }, 404);

	const [row] = await db
		.update(sessionTemplates)
		.set({
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
			updatedAt: new Date().toISOString(),
		})
		.where(eq(sessionTemplates.id, id))
		.returning();

	return c.json({ template: mapTemplate(row) });
});

templatesRouter.delete("/templates/:id", async (c) => {
	const id = c.req.param("id");
	const [existing] = await db.select().from(sessionTemplates).where(eq(sessionTemplates.id, id)).limit(1);
	if (!existing) return c.json({ error: "Template not found" }, 404);
	await db.delete(sessionTemplates).where(eq(sessionTemplates.id, id));
	return c.json({ ok: true });
});

templatesRouter.post("/templates/:id/duplicate", async (c) => {
	const id = c.req.param("id");
	const [existing] = await db.select().from(sessionTemplates).where(eq(sessionTemplates.id, id)).limit(1);
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
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return c.json({ template: mapTemplate(row) }, 201);
});

templatesRouter.post("/templates/preview", async (c) => {
	const body = await c.req.json<Partial<SessionTemplateInput>>();
	const preview = buildTemplatePreview(body);
	const { errors } = validateTemplateInput(preview.normalizedTemplate);
	if (errors.length > 0) {
		return c.json({ error: errors.join(" "), preview }, 400);
	}
	return c.json(preview);
});

export { templatesRouter };
