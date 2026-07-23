/**
 * Template mutation tools (AGEN-12 Phase 4, D2's mutating-tool table):
 * create_template, update_template, delete_template. (Template READS —
 * list_templates/get_template — live in catalog.ts; this file is the
 * write-side counterpart, split per the plan's file layout.)
 *
 * Field-naming convention: see the canonical note near ToolContext in
 * server.ts. This file's fields ARE the template's own top-level params
 * (not a pass-through blob), so they snake_case per the established
 * Phase 1-3 tool-surface convention, translated to the camelCase REST body
 * by templateBodyFromArgs below.
 */
import { z } from "zod";
import { AGENT_TYPE_ENUM, APPROVAL_POLICY_ENUM, SANDBOX_MODE_ENUM } from "../enums.js";
import { registerMutatingTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

/**
 * xander H1/e (mid-build security review): every mutating tool ships this
 * caveat in its own description — see orchestrate.ts/session-actions.ts
 * for the identical constant (each file owns its own copy).
 */
const CONFIRMATION_PORTABILITY_NOTE =
	"This is a state-changing action. The requires-confirmation hint is honored only by MCP hosts that implement it (e.g. Claude Code's UI); other clients (scripted, or hosts without the gate) will execute it without prompting.";

const TEMPLATE_FIELDS_SHAPE = {
	name: z.string(),
	description: z.string().nullable().optional(),
	agent_type: AGENT_TYPE_ENUM,
	cwd: z.string(),
	base_instructions: z.string().optional(),
	task_prompt: z.string().optional(),
	model: z.string().nullable().optional(),
	approval_policy: APPROVAL_POLICY_ENUM.nullable().optional(),
	sandbox_mode: SANDBOX_MODE_ENUM.nullable().optional(),
	env: z.record(z.string(), z.string()).optional(),
	tags: z.array(z.string()).optional(),
	is_favorite: z.boolean().optional(),
	project_id: z.string().nullable().optional(),
};

type TemplateFieldsArgs = {
	name: string;
	description?: string | null;
	agent_type: "claude_code" | "codex_cli";
	cwd: string;
	base_instructions?: string;
	task_prompt?: string;
	model?: string | null;
	approval_policy?: "default" | "suggest" | "auto" | "manual" | "untrusted" | "on-failure" | null;
	sandbox_mode?: "default" | "workspace-write" | "read-only" | "danger-full-access" | null;
	env?: Record<string, string>;
	tags?: string[];
	is_favorite?: boolean;
	project_id?: string | null;
};

function templateBodyFromArgs(args: TemplateFieldsArgs) {
	return {
		name: args.name,
		description: args.description ?? null,
		agentType: args.agent_type,
		cwd: args.cwd,
		baseInstructions: args.base_instructions,
		taskPrompt: args.task_prompt,
		model: args.model ?? null,
		approvalPolicy: args.approval_policy ?? null,
		sandboxMode: args.sandbox_mode ?? null,
		env: args.env,
		tags: args.tags,
		isFavorite: args.is_favorite,
		projectId: args.project_id ?? null,
	};
}

export function registerTemplateMutationTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (!flags.hasManage) return;

	registerMutatingTool(
		ctx,
		{
			name: "create_template",
			description: `Create a new session launch template. ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: TEMPLATE_FIELDS_SHAPE,
		},
		async (args, client) => client.createTemplate(templateBodyFromArgs(args)),
	);

	registerMutatingTool(
		ctx,
		{
			name: "update_template",
			description: `Replace an existing session launch template's fields. ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: { template_id: z.string(), ...TEMPLATE_FIELDS_SHAPE },
		},
		async (args, client) => client.updateTemplate(args.template_id, templateBodyFromArgs(args)),
	);

	registerMutatingTool(
		ctx,
		{
			name: "delete_template",
			description: `Permanently delete a session launch template. This cannot be undone. ${CONFIRMATION_PORTABILITY_NOTE}`,
			annotations: { destructiveHint: true },
			inputSchema: { template_id: z.string() },
		},
		async (args, client) => client.deleteTemplate(args.template_id),
	);
}
