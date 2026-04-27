import type {
	AgentType,
	ApprovalPolicy,
	SandboxMode,
	SessionTemplateInput,
} from "../../../shared/types.js";
import type { projects, sessionTemplates } from "../../db/schema.js";

type TemplateRow = typeof sessionTemplates.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/**
 * Resolves a template row into a SessionTemplateInput by merging project
 * defaults for fields not listed in templateProjectOverrides.
 *
 * Rules:
 *   - If no project is linked (projectId null), return the stored values as-is.
 *   - For each project-fillable field (cwd, agentType, model):
 *     - Field listed in templateProjectOverrides → use stored column value.
 *     - Field absent from overrides → use project value (if non-null) or stored value as fallback.
 *
 * Pure: no DB calls, no async. Safe to call in hot paths.
 */
export function resolveTemplateWithProject(
	template: TemplateRow,
	project: ProjectRow | null,
): SessionTemplateInput {
	if (!project) {
		return toSessionTemplateInput(template);
	}

	const overrides = parseOverrides(template.templateProjectOverrides);

	const cwd = overrides.has("cwd") || !project.cwd ? template.cwd : project.cwd;

	const agentType =
		overrides.has("agentType") || !project.defaultAgentType
			? (template.agentType as AgentType)
			: (project.defaultAgentType as AgentType);

	const model = overrides.has("model") ? template.model : (project.defaultModel ?? template.model);

	return {
		name: template.name,
		description: template.description,
		agentType,
		cwd,
		baseInstructions: template.baseInstructions,
		taskPrompt: template.taskPrompt,
		model,
		approvalPolicy: (template.approvalPolicy as ApprovalPolicy | null) ?? null,
		sandboxMode: (template.sandboxMode as SandboxMode | null) ?? null,
		env: (template.env as Record<string, string>) ?? {},
		tags: (template.tags as string[]) ?? [],
		isFavorite: template.isFavorite,
	};
}

export function parseOverrides(raw: string | string[] | null | undefined): Set<string> {
	if (!raw) return new Set();
	// Drizzle may deserialize the JSON column to an array already
	if (Array.isArray(raw)) return new Set(raw);
	try {
		const arr = JSON.parse(raw as string);
		return Array.isArray(arr) ? new Set(arr) : new Set();
	} catch {
		return new Set();
	}
}

function toSessionTemplateInput(template: TemplateRow): SessionTemplateInput {
	return {
		name: template.name,
		description: template.description,
		agentType: template.agentType as AgentType,
		cwd: template.cwd,
		baseInstructions: template.baseInstructions,
		taskPrompt: template.taskPrompt,
		model: template.model,
		approvalPolicy: (template.approvalPolicy as ApprovalPolicy | null) ?? null,
		sandboxMode: (template.sandboxMode as SandboxMode | null) ?? null,
		env: (template.env as Record<string, string>) ?? {},
		tags: (template.tags as string[]) ?? [],
		isFavorite: template.isFavorite,
	};
}
