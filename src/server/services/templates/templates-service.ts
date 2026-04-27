import { eq } from "drizzle-orm";
import type { AgentType, SessionTemplateInput } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { sessionTemplates } from "../../db/schema.js";
import { ensureProjectForCwd, getProject } from "../projects/projects-service.js";
import { normalizeCwd } from "../projects/resolver.js";
import { normalizeTemplateInput, validateTemplateInput } from "../template-preview.js";
import { parseOverrides, resolveTemplateWithProject } from "./template-project-resolver.js";

export type TemplateRow = typeof sessionTemplates.$inferSelect;

export function mapTemplate(row: TemplateRow) {
	return {
		id: row.id,
		projectId: row.projectId ?? null,
		overriddenFields: Array.from(parseOverrides(row.templateProjectOverrides)),
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

export type UpdateTemplateInput = SessionTemplateInput & {
	projectId?: string | null;
	overriddenFields?: string[];
};

export type UpdateTemplateResult =
	| {
			ok: true;
			template: ReturnType<typeof mapTemplate>;
			agentType: AgentType;
			cwd: string;
			model: string | null;
	  }
	| { ok: false; error: string; status: 400 | 404 | 500 };

/**
 * Update a template by id. Mirrors the full logic from the PUT /templates/:id
 * route handler — project auto-linking, cwd-change detection, and override
 * tracking are all preserved here so the route and any service-layer callers
 * (Slice 4 executors) get identical behaviour.
 */
export async function updateTemplate(
	templateId: string,
	body: UpdateTemplateInput,
): Promise<UpdateTemplateResult> {
	const normalized = normalizeTemplateInput(body);
	const { errors } = validateTemplateInput(normalized);
	if (errors.length > 0) return { ok: false, error: errors.join(" "), status: 400 };

	const [existing] = await db
		.select()
		.from(sessionTemplates)
		.where(eq(sessionTemplates.id, templateId))
		.limit(1);
	if (!existing) return { ok: false, error: "Template not found", status: 404 };

	const cwdChanged = normalizeCwd(normalized.cwd) !== normalizeCwd(existing.cwd);
	const bodyHasExplicitProjectId = "projectId" in body;
	const explicitProjectId = bodyHasExplicitProjectId ? (body.projectId ?? null) : undefined;

	let resolvedProjectId: string | null;
	if (bodyHasExplicitProjectId && explicitProjectId !== null) {
		resolvedProjectId = body.projectId as string;
	} else if (
		(explicitProjectId === null || !bodyHasExplicitProjectId) &&
		(cwdChanged || existing.projectId === null) &&
		normalized.cwd.trim() !== ""
	) {
		const result = await ensureProjectForCwd({
			cwd: normalized.cwd,
			defaultAgentType: normalized.agentType,
			defaultModel: normalized.model ?? null,
		});
		if ("error" in result) return { ok: false, error: result.error, status: 500 };
		resolvedProjectId = result.project.id;
	} else if (bodyHasExplicitProjectId) {
		resolvedProjectId = null;
	} else {
		resolvedProjectId = existing.projectId ?? null;
	}

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
			projectId: resolvedProjectId,
			templateProjectOverrides:
				"overriddenFields" in body
					? (body.overriddenFields ?? null)
					: existing.templateProjectOverrides,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(sessionTemplates.id, templateId))
		.returning();

	const project = row.projectId ? await getProject(row.projectId) : null;
	const resolved = resolveTemplateWithProject(row, project);
	return {
		ok: true,
		template: mapTemplate(row),
		agentType: resolved.agentType as AgentType,
		cwd: resolved.cwd,
		model: resolved.model ?? null,
	};
}

export type DeleteTemplateResult = { ok: true } | { ok: false; error: string; status: 404 };

/**
 * Delete a template by id. Returns a not-found error when the id doesn't
 * exist so callers (route handlers and Slice 4 executors) can respond
 * consistently without re-querying.
 */
export async function deleteTemplate(templateId: string): Promise<DeleteTemplateResult> {
	const [existing] = await db
		.select()
		.from(sessionTemplates)
		.where(eq(sessionTemplates.id, templateId))
		.limit(1);
	if (!existing) return { ok: false, error: "Template not found", status: 404 };
	await db.delete(sessionTemplates).where(eq(sessionTemplates.id, templateId));
	return { ok: true };
}
